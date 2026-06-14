/**
 * config.ts — Configuration loader for pi-read-delegator
 *
 * Reads/writes ~/.pi/agent/read-delegator.json with sensible defaults.
 * If the config file doesn't exist, it creates one with defaults.
 * If the config file is corrupted, it overwrites with defaults and logs a warning.
 */
export interface ReadDelegatorConfig {
    enabled: boolean;
    reader_subagent_name: string;
    blocked_tools: string[];
    allowed_bash_write_commands: string[];
    orchestrator_prompt: string;
    language: string;
}
/**
 * Load configuration from disk.
 * - If the file doesn't exist, create it with defaults and return them.
 * - If the file is corrupted, overwrite with defaults, log a warning, return defaults.
 * - Otherwise parse and return the typed config.
 */
export declare function loadConfig(): ReadDelegatorConfig;
/**
 * Save configuration to disk.
 * @param config  The config object to persist
 * @param options.silent  If true, suppress console output
 */
export declare function saveConfig(config: ReadDelegatorConfig, options?: {
    silent?: boolean;
}): void;
//# sourceMappingURL=config.d.ts.map