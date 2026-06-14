/**
 * ui.ts — Localization, status bar, and logging for pi-read-delegator
 *
 * Detects the user's language preference (config → Pi settings → OS → "en")
 * and provides localized messages. Manages a status bar indicator.
 */
export type Status = "active" | "idle" | "error";
/** Minimal Pi agent interface for the status bar API. */
export interface AgentWithStatusBar {
    /** Set text to display in the Pi status bar. */
    setStatusBarText(text: string): void;
}
/**
 * Resolve the effective language.
 *
 * Priority:
 * 1. Explicit language in config (if not "auto")
 * 2. Pi's own language setting from ~/.pi/settings.json
 * 3. Operating system locale (first two chars)
 * 4. Fallback "en"
 */
export declare function getLanguage(configLang?: string): string;
/**
 * Retrieve a localized message by key.
 *
 * Falls back to English if the current language doesn't have the key.
 */
export declare function msg(key: string, lang?: string): string;
/**
 * Explicitly set the current language (for /read-delegator lang <code>).
 */
export declare function setLanguage(lang: string): void;
/**
 * Initialize the status bar with the given agent.
 */
export declare function initStatusBar(agent: AgentWithStatusBar): void;
/**
 * Update the status bar indicator.
 */
export declare function updateStatusBar(status: Status): void;
/**
 * Get the current status.
 */
export declare function getStatus(): Status;
/**
 * Log a one-line Reader event using the current language.
 *
 * Prepend "[pi-read-delegator]" for easy filtering.
 */
export declare function log(key: string, detail?: string): void;
/**
 * Log an error with the standard prefix.
 */
export declare function logError(key: string, detail?: string): void;
/**
 * Log a warning with the standard prefix.
 */
export declare function logWarn(key: string, detail?: string): void;
//# sourceMappingURL=ui.d.ts.map