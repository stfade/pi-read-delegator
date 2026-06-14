/**
 * index.ts — pi-read-delegator entry point
 *
 * Blocks read tools from the orchestrator and tells it to delegate every
 * file-read / search task to the 'reader' subagent.
 *
 * Architecture:
 *  - Factory body: registration only (pi.on, pi.registerCommand, ensureReaderTemplate)
 *  - session_start: dependency check → tool blocking → status bar
 *  - before_agent_start: inject orchestrator system prompt
 *  - tool_call: intercept bash read commands → redirect to reader
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
			`model: ${model}`,
			"---",
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
			confirm(title: string, message: string): Promise<boolean>;
			setStatus(id: string, text: string): void;
			notify(
				text: string,
				type?: "error" | "info" | "warning" | undefined,
			): void;
		};
	},
	config: ReadDelegatorConfig,
): Promise<boolean> {
	const promptFn = async (message: string): Promise<string> => {
		const ok = await ctx.ui.confirm("pi-subagents required", message);
		return ok ? "y" : "n";
	};

	const ready = await checkDependencies(promptFn, createProgressCallback(ctx));

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
// Extension factory — registration only; actions go inside events
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
	const config = loadConfig();

	// Detect language
	getLanguage(config.language);

	// Quick sync dependency check — interactive prompt is deferred to
	// session_start where we have access to ctx.ui.confirm().
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
	// 3. tool_call: intercept bash read commands
	// -----------------------------------------------------------------------
	pi.on("tool_call", (event, _ctx) => {
		if (!config.enabled) return;

		if (event.toolName === "bash" || event.toolName === "shell") {
			const command = String(
				(event.input as { command?: string } | undefined)?.command ?? "",
			);
			if (!command) return;

			if (isReadCommand(command)) {
				return {
					block: true,
					reason: [
						'Use subagent(agent: "' +
							config.reader_subagent_name +
							'", task: "Execute and summarize: ' +
							command +
							'")',
						"instead of running file-reading commands directly.",
					].join(" "),
				};
			}
		}
	});

	// -----------------------------------------------------------------------
	// 4. Commands
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

	pi.registerCommand("read-delegator-status", {
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

	// 5. Background: sync reader.md template from config
	syncReaderTemplate(config.reader_model);
}
