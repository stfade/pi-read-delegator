/**
 * index.ts — pi-read-delegator extension entry point
 *
 * Lifecycle:
 *   init(agent)  → load config, check deps, ensure template, enable/disable
 *   enable(agent) → block tools, add system prompt, attach bash filter
 *   disable(agent) → restore tools, remove prompt, detach bash filter
 *
 * Commands:
 *   /read-delegator on     → enable the delegator
 *   /read-delegator off    → disable the delegator
 *   /read-delegator status  → show current status
 */

import { loadConfig, type ReadDelegatorConfig, saveConfig } from "./config";
import { blockTools, restoreTools, getBlockedTools } from "./tool-blocker";
import { isReadCommand, isWriteCommand, wrapForReader } from "./bash-filter";
import {
	checkDependencies,
	ensureReaderTemplate,
	callReader,
	handleReaderError,
	type AgentWithSubagent,
} from "./reader-manager";
import {
	getLanguage,
	msg,
	log,
	logWarn,
	logError,
	initStatusBar,
	updateStatusBar,
	getStatus,
} from "./ui";

// ---------------------------------------------------------------------------
// Enhanced Agent type (what we expect from Pi's runtime)
// ---------------------------------------------------------------------------

/**
 * The Pi agent interface as consumed by pi-read-delegator.
 * Extends the building-block types from sub-modules.
 */
export interface PiAgent extends AgentWithSubagent {
	/** Return current tool definitions. */
	getTools(): Array<{ name: string }>;
	/** Remove a tool by name. */
	removeTool(name: string): void;
	/** Add/re-add a tool definition. */
	addTool(definition: { name: string; [key: string]: unknown }): void;
	/** Append a persistent system message to the conversation. */
	addSystemMessage(text: string): void;
	/** Remove a previously-added system message by its exact text. */
	removeSystemMessage(text: string): void;
	/** Register a hook that fires BEFORE a tool with the given name is called. */
	onBeforeToolCall(
		toolName: string,
		callback: (params: unknown) => Promise<unknown> | unknown,
	): void;
	/** Register a Pi command (like /read-delegator on). */
	registerCommand(
		name: string,
		handler: (args: string[]) => Promise<string> | string,
	): void;
	/** Execute a raw shell command directly on the system. */
	executeShellCommand(
		command: string,
	): Promise<{ stdout: string; stderr: string }>;
	/** Prompt the user for input. */
	promptUser(message: string): Promise<string>;
	/** Display a message to the user. */
	displayMessage(message: string): void;
	/** Set status bar text. */
	setStatusBarText(text: string): void;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let enabled = false;
let config: ReadDelegatorConfig | null = null;
let currentSystemMessage: string | null = null;

// ---------------------------------------------------------------------------
// Lifecycle: init
// ---------------------------------------------------------------------------

/**
 * Initialize the extension.
 *
 * This is the function Pi calls when loading the extension.
 * It returns a lifecycle object with enable() and disable().
 */
export function init(agent: PiAgent): {
	enable: () => void;
	disable: () => void;
} {
	// 1. Load configuration
	config = loadConfig();

	// 2. Detect language
	getLanguage(config.language);

	// 3. Initialize status bar
	initStatusBar(agent);

	// 4. Register commands
	registerCommands(agent);

	// 5. Run async init tasks (dependency check, template) in background.
	//    We do NOT block init — if deps are missing the user will be prompted.
	initAsync(agent);

	// Build lifecycle interface
	const enable = () => doEnable(agent);
	const disable = () => doDisable(agent);

	// If config says enabled, auto-enable (synchronous part first)
	if (config?.enabled) {
		doEnable(agent);
	}

	return { enable, disable };
}

// ---------------------------------------------------------------------------
// Async initialization (runs in background)
// ---------------------------------------------------------------------------

async function initAsync(agent: PiAgent): Promise<void> {
	try {
		// Check pi-subagents dependency
		await checkDependencies(agent.promptUser);
	} catch (err) {
		logError("deps_failed");
		logError("reader_failed", String(err));
		// Disable the extension if dependencies can't be satisfied
		doDisable(agent);
		return;
	}

	// Ensure reader.md template exists
	const templateOk = ensureReaderTemplate();
	if (!templateOk) {
		logWarn(
			"reader_failed",
			"Reader template could not be created. Create ~/.pi/agent/agents/reader.md manually.",
		);
	}
}

// ---------------------------------------------------------------------------
// Enable / Disable
// ---------------------------------------------------------------------------

function doEnable(agent: PiAgent): void {
	if (enabled) {
		agent.displayMessage(msg("already_blocked"));
		return;
	}

	if (!config) {
		logError("reader_failed", "No configuration loaded.");
		return;
	}

	// Block read tools
	blockTools(agent, config.blocked_tools);

	// Add system message
	currentSystemMessage = config.orchestrator_prompt;
	agent.addSystemMessage(config.orchestrator_prompt);

	// Attach bash filter hook
	attachBashFilter(agent);

	// Update status
	enabled = true;
	updateStatusBar("active");
	log("enabled");

	agent.displayMessage(msg("enabled"));
}

function doDisable(agent: PiAgent): void {
	if (!enabled) {
		agent.displayMessage(msg("already_enabled"));
		return;
	}

	// Restore read tools
	restoreTools(agent);

	// Remove system message
	if (currentSystemMessage) {
		try {
			agent.removeSystemMessage(currentSystemMessage);
		} catch {
			// Best effort — the message text may have been mutated
		}
		currentSystemMessage = null;
	}

	// Detach bash filter (we can't undo onBeforeToolCall, but we set a flag)
	enabled = false;
	updateStatusBar("idle");
	log("disabled");

	agent.displayMessage(msg("disabled"));
}

// ---------------------------------------------------------------------------
// Bash filter hook
// ---------------------------------------------------------------------------

/**
 * Attach a before-tool-call hook on the "bash" (and "shell") tools.
 *
 * When the main model tries to execute a bash command:
 *  - Read commands → forwarded to Reader subagent
 *  - Write commands → executed directly
 *  - Ambiguous → user is prompted
 */
function attachBashFilter(agent: PiAgent): void {
	// Hook both "bash" and "shell" tools, since Pi may expose either.
	const bashToolNames = ["bash", "shell"];

	for (const toolName of bashToolNames) {
		try {
			agent.onBeforeToolCall(toolName, async (params: unknown) => {
				// Only intercept if the extension is enabled
				if (!enabled || !config) return undefined; // undefined = proceed normally

				const p = params as Record<string, unknown>;
				const command = typeof p.command === "string" ? p.command : "";

				if (!command) return undefined; // Let the tool handle the error

				// Classify the command
				if (isWriteCommand(command)) {
					// Let the raw bash/shell tool execute this directly
					return undefined; // undefined → Pi runs the original tool
				}

				if (isReadCommand(command)) {
					// Forward to Reader subagent
					log("reader_calling", command);

					try {
						const result = await callReader(
							agent,
							config,
							wrapForReader(command),
						);
						log("reader_done");
						// Return the result directly — Pi will use this as the tool output
						// instead of running the original bash command.
						return { result, subagent_used: true };
					} catch (err) {
						logError("reader_failed", String(err));

						// Offer the [R/A/C] dialog
						try {
							const handled = await handleReaderError(
								agent,
								config,
								config.blocked_tools,
								err,
								wrapForReader(command),
								agent.promptUser,
							);
							// If "Allow once" was selected, return a special marker
							if (handled.startsWith("[ALLOW_ONCE]")) {
								return { result: handled, allow_once: true };
							}
							// Retry succeeded — return the result
							return { result: handled, subagent_used: true };
						} catch (finalErr) {
							updateStatusBar("error");
							return {
								error: true,
								message:
									finalErr instanceof Error
										? finalErr.message
										: "Reader failed",
							};
						}
					}
				}

				// Ambiguous command → ask user
				const answer = await agent.promptUser(
					`The command "${command}" may read files. Run via Reader? [Y/n]`,
				);

				if (
					answer.trim().toLowerCase() === "n" ||
					answer.trim().toLowerCase() === "no"
				) {
					// Let the original tool run
					return undefined;
				}

				// Forward to Reader
				log("reader_calling", command);
				try {
					const result = await callReader(
						agent,
						config,
						wrapForReader(command),
					);
					log("reader_done");
					return { result, subagent_used: true };
				} catch (err) {
					logError("reader_failed", String(err));
					return {
						error: true,
						message: err instanceof Error ? err.message : "Reader failed",
					};
				}
			});
		} catch {
			// onBeforeToolCall not supported for this tool — no-op
		}
	}
}

// ---------------------------------------------------------------------------
// Pi commands
// ---------------------------------------------------------------------------

function registerCommands(agent: PiAgent): void {
	agent.registerCommand("read-delegator", async (args: string[]) => {
		const sub = args[0]?.toLowerCase();

		switch (sub) {
			case "on":
			case "enable": {
				if (!config) {
					config = loadConfig();
				}
				config.enabled = true;
				saveConfig(config, { silent: true });
				doEnable(agent);
				return msg("enabled");
			}

			case "off":
			case "disable": {
				if (config) {
					config.enabled = false;
					saveConfig(config, { silent: true });
				}
				doDisable(agent);
				return msg("disabled");
			}

			case "status": {
				const status = getStatus();
				const blocked = getBlockedTools();
				return (
					`pi-read-delegator is ${status}\n` +
					`Enabled: ${enabled ? "yes" : "no"}\n` +
					`Blocked tools: ${blocked.join(", ") || "(none)"}\n` +
					`Reader subagent: ${config?.reader_subagent_name ?? "reader"}\n` +
					`Language: ${config?.language ?? "auto"}`
				);
			}

			default:
				return (
					"Usage:\n" +
					"  /read-delegator on     — enable read delegation\n" +
					"  /read-delegator off    — disable read delegation\n" +
					"  /read-delegator status — show current status"
				);
		}
	});
}
