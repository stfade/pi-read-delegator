/**
 * index.ts — pi-read-delegator entry point
 *
 * Blocks read tools from the orchestrator and tells it to delegate every
 * file-read / search task to the 'reader' subagent.
 *
 * Architecture:
 *  - Factory body: registration only (pi.on, pi.registerCommand, syncReaderTemplate)
 *  - session_start: dependency check → tool blocking → status bar
 *  - before_agent_start: inject orchestrator system prompt
 *  - tool_call: intercept bash read commands + subagent enrichment + cache check
 *  - tool_result: post-process reader output (deterministic optimizations) + cache
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";

import type { ReadDelegatorConfig } from "./config";
import { loadConfig, saveConfig } from "./config";
import {
	checkDependencies,
	isSubagentsInstalled,
	sessionCache,
} from "./reader-manager";
import type { InstallProgress } from "./reader-manager";
import { getLanguage, msg } from "./ui";
import { isReadCommand } from "./bash-filter";
import {
	restoreTools,
	isAllowOnceActive,
	consumeAllowOnce,
} from "./tool-blocker";

// ---------------------------------------------------------------------------
// Reader template path
// ---------------------------------------------------------------------------

function readerPath(): string {
	return path.join(os.homedir(), ".pi", "agent", "agents", "reader.md");
}

function syncReaderTemplate(model: string): void {
	const rp = readerPath();
	try {
		const dir = path.dirname(rp);
		fs.mkdirSync(dir, { recursive: true });

		const content = [
			"---",
			"name: reader",
			"description: Compact code-reader — executes tasks, returns results with line numbers",
			"tools: read, grep, find, ls",
			"extensions:",
			`model: ${model}`,
			"---",
			"",
			"You are a READ-ONLY agent with STRICT limits.",
			"You CANNOT write, edit, delete, or modify any file.",
			"You CANNOT execute shell commands or run programs.",
			"You CANNOT spawn subagents or delegate work to other agents.",
			"Your ONLY capabilities: read, grep, find, ls.",
			"Do not ask for additional capabilities — you have none.",
			"",
			"Execute the task. Return only the result, nothing else.",
			"Always include line numbers for grep and read results.",
			"No explanations, summaries, or conversational text.",
			"",
			"### Structure masks (auto-apply to code output)",
			"- Skip import statements unless task explicitly mentions them.",
			"- Collapse long type annotations: `Record<string, string>[]` → `Record<...>[]`.",
			"- Truncate paths: `C:/Users/samet/Documents/Projects/pi-read-delegator/src/` → `src/`.",
			"",
			"### Stats-first for grep / find",
			"- grep: show total match count on line 1, then matches. Large result sets (>20): only count.",
			"- find: show file count first, then list. >50 files: only count.",
			"- ls: show file count first, then list.",
			"",
			"### Smart filtering",
			"- Skip node_modules, .git, dist, .next, coverage, __pycache__ unless task specifies a path inside.",
			"- Skip binary files (images, .exe, .dll, .zip, .db) — return '(binary)'.",
			"- Deduplicate: if same file appears in multiple grep matches, show it once with all line numbers.",
			"",
			"### Output format (no markdown headers)",
			"grep: src/file.ts:42  matched line",
			"read: 42: line content",
			"find: file list, one per line",
			"ls:   name  size",
			"No matches: (no matches)",
			"Error: Error: <message>",
		].join("\n");

		fs.writeFileSync(rp, content, "utf8");
	} catch {
		// read-only home directory — template sync is best-effort
	}
}

// ---------------------------------------------------------------------------
// Model picker
// ---------------------------------------------------------------------------

/**
 * Interactive model picker using Pi's model registry.
 * Shows a select UI with all configured models and updates config + reader.md
 * when the user picks a new model.
 *
 * Returns the selected model string ("provider/model") or undefined if the
 * picker is unavailable or the user cancels.
 */
async function pickReaderModel(
	config: ReadDelegatorConfig,
	ctx: {
		modelRegistry?: {
			getAvailable?: () => Array<{ provider?: string; id: string }>;
		};
		ui: {
			select(title: string, options: string[]): Promise<string | undefined>;
			notify(
				text: string,
				type?: "error" | "info" | "warning" | undefined,
			): void;
		};
	},
): Promise<string | undefined> {
	try {
		const models = ctx.modelRegistry?.getAvailable?.() ?? [];
		if (models.length === 0) return undefined;

		const options = models.map((m) => `${m.provider ?? "?"}/${m.id}`);
		if (!options.includes(config.reader_model)) {
			options.unshift(config.reader_model);
		}

		const selected = await ctx.ui.select(
			"Choose reader model (ESC to keep current)",
			options,
		);

		if (selected && selected !== config.reader_model) {
			config.reader_model = selected;
			saveConfig(config, { silent: true });
			syncReaderTemplate(selected);
			ctx.ui.notify("✅ Reader model set to: " + selected, "info");
			return selected;
		}
	} catch {
		// modelRegistry or ui.select not available — fallback
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Tool helpers
// ---------------------------------------------------------------------------

/** Determine which tools stay active after blocking read tools.
 *  Always keeps "subagent" — the bridge to the reader. */
function computeActiveTools(pi: ExtensionAPI, blocked: string[]): string[] {
	const all = pi.getAllTools();
	const blockedSet = new Set(blocked);
	const forceKeep = new Set(["subagent"]);

	return all
		.map((t: ToolInfo) => t.name)
		.filter((name: string) => forceKeep.has(name) || !blockedSet.has(name));
}

// ---------------------------------------------------------------------------
// Dependency check helpers — extracted to keep session_start handler lean
// ---------------------------------------------------------------------------

function createProgressCallback(ctx: {
	ui: {
		setStatus(id: string, text: string): void;
		notify(text: string, type?: "error" | "info" | "warning" | undefined): void;
	};
}): (status: InstallProgress) => void {
	return (status) => {
		if (status === "installing") {
			ctx.ui.setStatus("read-delegator", "⏳ Installing pi-subagents…");
			ctx.ui.notify(
				msg("deps_installing") +
					" This may take up to 60 seconds. Please wait…",
				"info",
			);
		} else if (status === "done") {
			ctx.ui.setStatus("read-delegator", msg("status_active"));
			ctx.ui.notify("✅ pi-subagents installed successfully.", "info");
		} else if (status === "failed") {
			ctx.ui.setStatus("read-delegator", msg("status_error"));
		}
	};
}

async function performDependencyCheck(
	ctx: {
		ui: {
			setStatus(id: string, text: string): void;
			notify(
				text: string,
				type?: "error" | "info" | "warning" | undefined,
			): void;
		};
	},
	config: ReadDelegatorConfig,
): Promise<boolean> {
	ctx.ui.notify(msg("deps_required"), "info");

	const ready = await checkDependencies(createProgressCallback(ctx));

	if (!ready) {
		config.enabled = false;
		saveConfig(config, { silent: true });
		ctx.ui.setStatus("read-delegator", msg("status_error"));
		ctx.ui.notify(msg("deps_disabled"), "warning");
		return false;
	}

	if (!config.enabled) {
		config.enabled = true;
		saveConfig(config, { silent: true });
	}

	return true;
}

// ---------------------------------------------------------------------------
// Reader task pre/post processing helpers
// ---------------------------------------------------------------------------

/**
 * Simple non-cryptographic hash (matches reader-manager.ts simpleHash).
 */
function simpleHash(str: string): string {
	let h = 0;
	for (let i = 0; i < str.length; i++) {
		h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
	}
	return h.toString(36);
}

/**
 * Extract the Target field from a structured task string.
 * Format: "Action: read | Target: src/file.ts | Detail: ..."
 * Also matches looser formats like "Target: src/file.ts".
 */
function extractTargetFromTask(task: string): string | null {
	const match = task.match(/Target:\s*(\S+)/i);
	return match ? match[1] : null;
}

/**
 * Append deterministic optimization rules to a reader task.
 * These are injected into the task string so the reader model sees them
 * alongside the user's request — no reliance on system prompt compliance.
 */
function enrichTask(task: string): string {
	if (task.includes("Auto-rules:")) return task; // already enriched
	return (
		task +
		"\n\nAuto-rules: Skip imports. Skip node_modules, .git, dist, binaries. " +
		"Return count first (e.g. '(5 matches)'). Deduplicate. " +
		"No markdown headers. Truncate paths to project-relative."
	);
}

/**
 * Post-process reader output with deterministic regex-based optimizations.
 *
 * These run on EVERY reader subagent result, guaranteeing token savings
 * regardless of whether the reader model follows its prompt instructions.
 */
function optimizeOutput(text: string, cwd: string): string {
	let result = text;

	// 1. Strip import/export lines (single-line only)
	result = result.replace(/^\s*(?:import\b|export\b).*$/gm, "");

	// 2. Truncate absolute project paths to relative
	if (cwd) {
		const normalizedCwd = cwd.replace(/\\/g, "/");
		const escaped = normalizedCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		result = result.replace(new RegExp(escaped + "/?", "g"), "");
	}

	// 3. Collapse consecutive blank lines from import stripping
	result = result.replace(/\n{3,}/g, "\n\n");

	// 4. Collapse long type annotations (>40 chars) inside angle brackets
	result = result.replace(
		/\b(?:Record|Map|Promise|Array|Set|Partial|Required|Readonly|Pick|Omit|Exclude|Extract)<[^<>]*(?:<[^<>]*>)*[^<>]*>/g,
		(match) => {
			if (match.length > 40) {
				const base = match.match(/^(\w+)/)?.[1] ?? match;
				return `${base}<...>`;
			}
			return match;
		},
	);

	return result.trim();
}

// ---------------------------------------------------------------------------
// Extension factory — registration only; actions go inside events
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
	const config = loadConfig();

	// Detect language
	getLanguage(config.language);

	// Quick sync dependency check — auto-install is deferred to session_start.
	let depsReady = isSubagentsInstalled();
	let depsChecked = depsReady; // if already ready, no need to check again

	// -----------------------------------------------------------------------
	// 1. session_start: dependency check → tool blocking → status bar
	// -----------------------------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		// --- Dependency check ---
		if (!depsChecked) {
			depsReady = await performDependencyCheck(ctx, config);
			depsChecked = true;
			if (!depsReady) return;

			// First install: pick reader model from available models
			await pickReaderModel(config, ctx);
		}

		// --- Tool blocking ---
		if (config.enabled) {
			pi.setActiveTools(computeActiveTools(pi, config.blocked_tools));
		}
		ctx.ui.setStatus(
			"read-delegator",
			config.enabled ? msg("status_active") : msg("status_off"),
		);
	});

	// -----------------------------------------------------------------------
	// 2. before_agent_start: inject orchestrator system prompt
	// -----------------------------------------------------------------------
	pi.on("before_agent_start", (event, _ctx) => {
		if (!config.enabled) return;
		return {
			systemPrompt: event.systemPrompt + "\n\n" + config.orchestrator_prompt,
		};
	});

	// -----------------------------------------------------------------------
	// 3. tool_call: intercept bash read commands + subagent enrichment + cache
	// -----------------------------------------------------------------------
	pi.on("tool_call", (event, ctx) => {
		if (!config.enabled) return;

		// --- 3a. Allow-once: let blocked read tools through during retry window ---
		const readTools = new Set(["read", "grep", "find", "ls"]);
		if (readTools.has(event.toolName) && isAllowOnceActive()) {
			return; // let it through; re-block happens in tool_result
		}

		// --- 3b. Bash/shell: block read commands ---
		if (event.toolName === "bash" || event.toolName === "shell") {
			const command = String(
				(event.input as { command?: string } | undefined)?.command ?? "",
			);
			if (!command) return;

			if (isReadCommand(command)) {
				return {
					block: true,
					reason:
						'Read commands are blocked. Use subagent(agent:"' +
						config.reader_subagent_name +
						'", task:"<format from system prompt>") ' +
						"instead. Format: Action: read|grep|find|ls | Target: file|dir | Detail: what to find.",
				};
			}
		}

		// --- 3b. Subagent: enrich reader tasks + cache check ---
		if (event.toolName === "subagent") {
			const input = event.input as { agent?: string; task?: string };
			if (input.agent !== config.reader_subagent_name) return;

			const task = input.task ?? "";
			if (!task) return;

			// Cache check: if this file was already read and hasn't changed,
			// tell the orchestrator to reuse from context.
			const target = extractTargetFromTask(task);
			if (target && ctx.cwd) {
				const absPath = path.resolve(ctx.cwd, target);
				if (sessionCache.has(absPath)) {
					try {
						const diskContent = fs.readFileSync(absPath, "utf-8");
						const diskHash = simpleHash(diskContent);
						if (diskHash === sessionCache.getHash(absPath)) {
							const cachedLines =
								sessionCache.get(absPath)?.split("\n").length ?? 0;
							return {
								block: true,
								reason:
									'File "' +
									target +
									'" already in context (' +
									cachedLines +
									" lines, unchanged). Reuse from your context window.",
							};
						}
						// File changed — invalidate stale cache entry
						sessionCache.set(absPath, diskContent);
					} catch {
						// File not accessible — let the subagent handle it
					}
				}
			}

			// Enrich task with deterministic optimization rules
			event.input.task = enrichTask(task);
		}
	});

	// -----------------------------------------------------------------------
	// 4. tool_result: post-process reader output (optimizations + error handling)
	// -----------------------------------------------------------------------
	pi.on("tool_result", (event, ctx) => {
		if (!config.enabled) return;

		// --- 4a. Allow-once re-block: re-block tools after first read tool use ---
		const readTools = new Set(["read", "grep", "find", "ls"]);
		if (readTools.has(event.toolName) && isAllowOnceActive()) {
			consumeAllowOnce(pi, config.blocked_tools);
			ctx.ui.notify(
				"🔒 Read tools re-blocked after allow-once operation.",
				"info",
			);
			return;
		}

		// --- 4b. Only post-process subagent/reader results ---
		if (event.toolName !== "subagent") return;

		const input = event.input as { agent?: string; task?: string };
		if (input.agent !== config.reader_subagent_name) return;

		const task = input.task ?? "";

		// Post-process content with regex-based optimizations
		if (event.content && Array.isArray(event.content)) {
			for (const part of event.content) {
				if (part.type === "text" && typeof part.text === "string") {
					part.text = optimizeOutput(part.text, ctx.cwd);
				}
			}
		}

		// --- Error detection on reader output ---
		const fullText =
			(event.content as Array<{ type: string; text?: string }>)
				?.filter((p) => p.type === "text")
				.map((p) => p.text ?? "")
				.join("\n") ?? "";

		const errorPatterns = [
			/^Error[:\s]/im,
			/\[ERROR\]/i,
			/\[FAILED\]/i,
			/timeout/i,
			/no model/i,
			/unavailable/i,
		];
		const isError =
			fullText.trim().length === 0 ||
			errorPatterns.some((p) => p.test(fullText));

		if (isError) {
			// Unblock tools so orchestrator can use direct reads for recovery
			restoreTools(pi);

			const recoveryMsg =
				"\n\n[READER FAILED] Reader subagent could not complete this task.\n" +
				'[R]etry — call subagent(agent="' +
				config.reader_subagent_name +
				'", task="...") again.\n' +
				"[A]llow once — read tools UNBLOCKED for one operation (auto re-block after).\n" +
				"[C]ancel — skip this read.\n" +
				"[/read-delegator-off] permanently unblock.  [/read-delegator-on] re-enable.";

			if (event.content && Array.isArray(event.content)) {
				const textPart = event.content.find((p) => p.type === "text") as
					| { text?: string }
					| undefined;
				if (textPart) textPart.text = (textPart.text ?? "") + recoveryMsg;
			}

			ctx.ui.notify(
				"⚠ Reader failed. Read tools temporarily unblocked.",
				"warning",
			);
		}

		// Cache: record the file that was read for future cache checks
		const target = extractTargetFromTask(task);
		if (target && ctx.cwd) {
			const absPath = path.resolve(ctx.cwd, target);
			try {
				const content = fs.readFileSync(absPath, "utf-8");
				sessionCache.set(absPath, content);
			} catch {
				// File not accessible — nothing to cache
			}
		}

		// Return patched content (event.content mutated in-place above)
		return { content: event.content };
	});

	// -----------------------------------------------------------------------
	// 5. Commands
	// -----------------------------------------------------------------------

	// Shared status helper
	const showStatus = (ctx: any) => {
		const s = sessionCache.stats();
		const lines = [
			"Read delegation: " + (config.enabled ? "🟢 enabled" : "🔴 disabled"),
			"Reader subagent: " + config.reader_subagent_name,
			"Reader model: " + config.reader_model,
			"Dependencies: " + (depsReady ? "✅ ready" : "❌ missing"),
			"Blocked tools: " + config.blocked_tools.join(", "),
			"Cache: " + s.files + " files (" + s.sizeKB + " KB)",
		];
		ctx.ui.notify(lines.join("\n"), "info");
	};

	// Shortcut: enable/disable toggle with subcommand syntax (kept for back compat)
	pi.registerCommand("read-delegator", {
		description: "Show read-delegator status",
		handler: async (_args, ctx) => {
			showStatus(ctx);
		},
	});

	pi.registerCommand("read-delegator-on", {
		description: "Enable read delegation",
		handler: async (_args, ctx) => {
			if (!depsReady) {
				ctx.ui.notify(
					"pi-subagents not installed. Install it first to enable read delegation.",
					"warning",
				);
				return;
			}
			config.enabled = true;
			saveConfig(config, { silent: true });
			pi.setActiveTools(computeActiveTools(pi, config.blocked_tools));
			ctx.ui.notify(msg("enabled"), "info");
			ctx.ui.setStatus("read-delegator", msg("status_active"));
		},
	});

	pi.registerCommand("read-delegator-off", {
		description: "Disable read delegation",
		handler: async (_args, ctx) => {
			config.enabled = false;
			saveConfig(config, { silent: true });
			pi.setActiveTools(pi.getAllTools().map((t: ToolInfo) => t.name));
			ctx.ui.notify(msg("disabled"), "info");
			ctx.ui.setStatus("read-delegator", msg("status_off"));
		},
	});

	pi.registerCommand("read-delegator-model", {
		description: "Set or view the reader model",
		handler: async (args: string | undefined, ctx) => {
			const modelArg = args?.trim() ?? "";

			if (!modelArg) {
				// Interactive picker via available models
				const picked = await pickReaderModel(config, ctx);
				if (picked === undefined) {
				}
				return;
			}

			config.reader_model = modelArg;
			saveConfig(config, { silent: true });
			syncReaderTemplate(modelArg);
			ctx.ui.notify("✅ Reader model set to: " + modelArg, "info");
		},
	});

	// 6. Background: sync reader.md template from config
	syncReaderTemplate(config.reader_model);
}
