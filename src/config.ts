/**
 * config.ts — Configuration loader for pi-read-delegator
 *
 * Reads/writes ~/.pi/agent/read-delegator.json with sensible defaults.
 * If the config file doesn't exist, it creates one with defaults.
 * If the config file is corrupted, it overwrites with defaults and logs a warning.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { rawLog, rawWarn, rawError } from "./ui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReadDelegatorConfig {
	enabled: boolean;
	reader_subagent_name: string;
	blocked_tools: string[];
	orchestrator_prompt: string;
	reader_model: string;
	language: string; // "auto" | "tr" | "en" | …
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: ReadDelegatorConfig = {
	enabled: true,
	reader_subagent_name: "reader",
	blocked_tools: ["read", "grep", "find", "ls"],
	orchestrator_prompt: [
		"## Reader Subagent Protocol",
		"",
		"Your `read`,`grep`,`find`,`ls` tools are BLOCKED. Shell read commands (cat, grep, type, Get-Content, etc.) are also blocked.",
		"",
		"### How to delegate",
		'Use: `subagent(agent="reader", task="<format>")`',
		"Format: Action: {read|grep|find|ls}  Target: {file|dir}  Detail: {what,be specific}",
		"",
		"### Graduated reading (use this order)",
		"1. **Find first**: `find src/ *.ts` → locate the relevant file.",
		"2. **Grep next**: `grep functionName in src/file.ts` → locate the exact spot.",
		"3. **Read last**: `read src/file.ts lines 42-80` → get only the needed section.",
		"Never read an entire file unless you truly need all of it.",
		"",
		"### Cache awareness",
		"You have previously-read file content in your context window. Before delegating, check if you already have what you need.",
		"Re-reading the same file wastes tokens — reuse cached content.",
		"",
		"### Reader output format (no headers, no fluff)",
		"grep: file:line  content  |  read: N: line  |  find/ls: bare list",
		"Large grep/find results: reader returns count-line first, then top matches.",
		"The reader auto-skips imports, node_modules, binaries — you get clean data.",
		'If you get "(no matches)" or an error, adjust and retry.',
	].join("\n"),
	reader_model: "lmstudio/nvidia/nemotron-3-nano-4b",
	language: "auto",
};

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Expand ~ to the user's home directory. */
function expandTilde(filePath: string): string {
	if (filePath.startsWith("~")) {
		return path.join(os.homedir(), filePath.slice(1));
	}
	return filePath;
}

/** Full path to the config file. */
function configFilePath(): string {
	return expandTilde("~/.pi/agent/read-delegator.json");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load configuration from disk.
 * - If the file doesn't exist, create it with defaults and return them.
 * - If the file is corrupted, overwrite with defaults, log a warning, return defaults.
 * - Otherwise parse and return the typed config.
 */
export function loadConfig(): ReadDelegatorConfig {
	const filePath = configFilePath();

	try {
		if (!fs.existsSync(filePath)) {
			// First run: create the config directory and write defaults
			ensureDir(path.dirname(filePath));
			saveConfig(DEFAULT_CONFIG, { silent: true });
			return { ...DEFAULT_CONFIG };
		}

		const raw = fs.readFileSync(filePath, "utf-8");
		const parsed: unknown = JSON.parse(raw);

		// Merge with defaults so missing keys get their default values
		const config = mergeDefaults(parsed, DEFAULT_CONFIG);
		return config;
	} catch (err) {
		// File is missing, unreadable, or invalid JSON → overwrite with defaults
		rawWarn(
			`Corrupted config file at ${filePath}. Overwriting with defaults. Error: ${err}`,
		);
		try {
			ensureDir(path.dirname(filePath));
			fs.writeFileSync(
				filePath,
				JSON.stringify(DEFAULT_CONFIG, null, 2),
				"utf-8",
			);
		} catch {
			// Silently fail — we tried our best
		}
		return { ...DEFAULT_CONFIG };
	}
}

/**
 * Save configuration to disk.
 * @param config  The config object to persist
 * @param options.silent  If true, suppress console output
 */
export function saveConfig(
	config: ReadDelegatorConfig,
	options?: { silent?: boolean },
): void {
	const filePath = configFilePath();
	ensureDir(path.dirname(filePath));

	try {
		fs.writeFileSync(filePath, JSON.stringify(config, null, 2), "utf-8");
		if (!options?.silent) {
			rawLog(`Config saved to ${filePath}`);
		}
	} catch (err) {
		rawError(`Failed to save config: ${err}`);
		throw err;
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recursively merge a partial user config on top of the defaults. */
function mergeDefaults(
	partial: unknown,
	defaults: ReadDelegatorConfig,
): ReadDelegatorConfig {
	if (typeof partial !== "object" || partial === null) {
		return { ...defaults };
	}

	const p = partial as Record<string, unknown>;
	return {
		enabled: typeof p.enabled === "boolean" ? p.enabled : defaults.enabled,
		reader_subagent_name:
			typeof p.reader_subagent_name === "string"
				? p.reader_subagent_name
				: defaults.reader_subagent_name,
		blocked_tools: Array.isArray(p.blocked_tools)
			? p.blocked_tools
			: defaults.blocked_tools,
		orchestrator_prompt:
			typeof p.orchestrator_prompt === "string"
				? p.orchestrator_prompt
				: defaults.orchestrator_prompt,
		reader_model:
			typeof p.reader_model === "string"
				? p.reader_model
				: defaults.reader_model,
		language: typeof p.language === "string" ? p.language : defaults.language,
	};
}

/** Recursively ensure a directory exists. */
function ensureDir(dir: string): void {
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
}
