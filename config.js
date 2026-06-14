"use strict";
/**
 * config.ts — Configuration loader for pi-read-delegator
 *
 * Reads/writes ~/.pi/agent/read-delegator.json with sensible defaults.
 * If the config file doesn't exist, it creates one with defaults.
 * If the config file is corrupted, it overwrites with defaults and logs a warning.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadConfig = loadConfig;
exports.saveConfig = saveConfig;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG = {
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
    orchestrator_prompt: "You are an orchestrator. For any file reading, searching, or listing operation, you MUST use the subagent tool with subagent='reader'. Do not use read/grep/find/ls yourself. If you need to run a shell command that only reads (like cat, grep, find, ls), also delegate it to the reader subagent.",
    language: "auto",
};
// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------
/** Expand ~ to the user's home directory. */
function expandTilde(filePath) {
    if (filePath.startsWith("~")) {
        return path.join(os.homedir(), filePath.slice(1));
    }
    return filePath;
}
/** Full path to the config file. */
function configFilePath() {
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
function loadConfig() {
    const filePath = configFilePath();
    try {
        if (!fs.existsSync(filePath)) {
            // First run: create the config directory and write defaults
            ensureDir(path.dirname(filePath));
            saveConfig(DEFAULT_CONFIG, { silent: true });
            return { ...DEFAULT_CONFIG };
        }
        const raw = fs.readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(raw);
        // Merge with defaults so missing keys get their default values
        const config = mergeDefaults(parsed, DEFAULT_CONFIG);
        return config;
    }
    catch (err) {
        // File is missing, unreadable, or invalid JSON → overwrite with defaults
        console.warn(`[pi-read-delegator] Corrupted config file at ${filePath}. Overwriting with defaults. Error: ${err}`);
        try {
            ensureDir(path.dirname(filePath));
            fs.writeFileSync(filePath, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
        }
        catch {
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
function saveConfig(config, options) {
    const filePath = configFilePath();
    ensureDir(path.dirname(filePath));
    try {
        fs.writeFileSync(filePath, JSON.stringify(config, null, 2), "utf-8");
        if (!options?.silent) {
            console.log(`[pi-read-delegator] Config saved to ${filePath}`);
        }
    }
    catch (err) {
        console.error(`[pi-read-delegator] Failed to save config: ${err}`);
        throw err;
    }
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** Recursively merge a partial user config on top of the defaults. */
function mergeDefaults(partial, defaults) {
    if (typeof partial !== "object" || partial === null) {
        return { ...defaults };
    }
    const p = partial;
    return {
        enabled: typeof p.enabled === "boolean" ? p.enabled : defaults.enabled,
        reader_subagent_name: typeof p.reader_subagent_name === "string"
            ? p.reader_subagent_name
            : defaults.reader_subagent_name,
        blocked_tools: Array.isArray(p.blocked_tools)
            ? p.blocked_tools
            : defaults.blocked_tools,
        allowed_bash_write_commands: Array.isArray(p.allowed_bash_write_commands)
            ? p.allowed_bash_write_commands
            : defaults.allowed_bash_write_commands,
        orchestrator_prompt: typeof p.orchestrator_prompt === "string"
            ? p.orchestrator_prompt
            : defaults.orchestrator_prompt,
        language: typeof p.language === "string" ? p.language : defaults.language,
    };
}
/** Recursively ensure a directory exists. */
function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}
//# sourceMappingURL=config.js.map