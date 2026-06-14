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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReadDelegatorConfig {
	enabled: boolean;
	reader_subagent_name: string;
	blocked_tools: string[];
	allowed_bash_write_commands: string[];
	orchestrator_prompt: string;
	language: string; // "auto" | "tr" | "en" | …
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: ReadDelegatorConfig = {
	enabled: true,
	reader_subagent_name: "reader",
	blocked_tools: ["read", "grep", "find", "ls"],
	allowed_bash_write_commands: [
		"mkdir",
		"echo",
		"touch",
		"sed",
		"rm",
		"mv",
		"cp",
	],
	orchestrator_prompt:
		"You are an orchestrator. For any file reading, searching, or listing operation, you MUST use the subagent tool with subagent='reader'. Do not use read/grep/find/ls yourself. If you need to run a shell command that only reads (like cat, grep, find, ls), also delegate it to the reader subagent.",
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
		console.warn(
			`[pi-read-delegator] Corrupted config file at ${filePath}. Overwriting with defaults. Error: ${err}`,
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
			console.log(`[pi-read-delegator] Config saved to ${filePath}`);
		}
	} catch (err) {
		console.error(`[pi-read-delegator] Failed to save config: ${err}`);
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
		allowed_bash_write_commands: Array.isArray(p.allowed_bash_write_commands)
			? p.allowed_bash_write_commands
			: defaults.allowed_bash_write_commands,
		orchestrator_prompt:
			typeof p.orchestrator_prompt === "string"
				? p.orchestrator_prompt
				: defaults.orchestrator_prompt,
		language: typeof p.language === "string" ? p.language : defaults.language,
	};
}

/** Recursively ensure a directory exists. */
function ensureDir(dir: string): void {
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
}
