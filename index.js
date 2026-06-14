"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.init = init;
const config_1 = require("./config");
const tool_blocker_1 = require("./tool-blocker");
const bash_filter_1 = require("./bash-filter");
const reader_manager_1 = require("./reader-manager");
const ui_1 = require("./ui");
// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------
let enabled = false;
let config = null;
let currentSystemMessage = null;
// ---------------------------------------------------------------------------
// Lifecycle: init
// ---------------------------------------------------------------------------
/**
 * Initialize the extension.
 *
 * This is the function Pi calls when loading the extension.
 * It returns a lifecycle object with enable() and disable().
 */
function init(agent) {
    // 1. Load configuration
    config = (0, config_1.loadConfig)();
    // 2. Detect language
    (0, ui_1.getLanguage)(config.language);
    // 3. Initialize status bar
    (0, ui_1.initStatusBar)(agent);
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
async function initAsync(agent) {
    try {
        // Check pi-subagents dependency
        await (0, reader_manager_1.checkDependencies)(agent.promptUser);
    }
    catch (err) {
        (0, ui_1.logError)("deps_failed");
        (0, ui_1.logError)("reader_failed", String(err));
        // Disable the extension if dependencies can't be satisfied
        doDisable(agent);
        return;
    }
    // Ensure reader.md template exists
    const templateOk = (0, reader_manager_1.ensureReaderTemplate)();
    if (!templateOk) {
        (0, ui_1.logWarn)("reader_failed", "Reader template could not be created. Create ~/.pi/agent/agents/reader.md manually.");
    }
}
// ---------------------------------------------------------------------------
// Enable / Disable
// ---------------------------------------------------------------------------
function doEnable(agent) {
    if (enabled) {
        agent.displayMessage((0, ui_1.msg)("already_blocked"));
        return;
    }
    if (!config) {
        (0, ui_1.logError)("reader_failed", "No configuration loaded.");
        return;
    }
    // Block read tools
    (0, tool_blocker_1.blockTools)(agent, config.blocked_tools);
    // Add system message
    currentSystemMessage = config.orchestrator_prompt;
    agent.addSystemMessage(config.orchestrator_prompt);
    // Attach bash filter hook
    attachBashFilter(agent);
    // Update status
    enabled = true;
    (0, ui_1.updateStatusBar)("active");
    (0, ui_1.log)("enabled");
    agent.displayMessage((0, ui_1.msg)("enabled"));
}
function doDisable(agent) {
    if (!enabled) {
        agent.displayMessage((0, ui_1.msg)("already_enabled"));
        return;
    }
    // Restore read tools
    (0, tool_blocker_1.restoreTools)(agent);
    // Remove system message
    if (currentSystemMessage) {
        try {
            agent.removeSystemMessage(currentSystemMessage);
        }
        catch {
            // Best effort — the message text may have been mutated
        }
        currentSystemMessage = null;
    }
    // Detach bash filter (we can't undo onBeforeToolCall, but we set a flag)
    enabled = false;
    (0, ui_1.updateStatusBar)("idle");
    (0, ui_1.log)("disabled");
    agent.displayMessage((0, ui_1.msg)("disabled"));
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
function attachBashFilter(agent) {
    // Hook both "bash" and "shell" tools, since Pi may expose either.
    const bashToolNames = ["bash", "shell"];
    for (const toolName of bashToolNames) {
        try {
            agent.onBeforeToolCall(toolName, async (params) => {
                // Only intercept if the extension is enabled
                if (!enabled || !config)
                    return undefined; // undefined = proceed normally
                const p = params;
                const command = typeof p.command === "string" ? p.command : "";
                if (!command)
                    return undefined; // Let the tool handle the error
                // Classify the command
                if ((0, bash_filter_1.isWriteCommand)(command)) {
                    // Let the raw bash/shell tool execute this directly
                    return undefined; // undefined → Pi runs the original tool
                }
                if ((0, bash_filter_1.isReadCommand)(command)) {
                    // Forward to Reader subagent
                    (0, ui_1.log)("reader_calling", command);
                    try {
                        const result = await (0, reader_manager_1.callReader)(agent, config, (0, bash_filter_1.wrapForReader)(command));
                        (0, ui_1.log)("reader_done");
                        // Return the result directly — Pi will use this as the tool output
                        // instead of running the original bash command.
                        return { result, subagent_used: true };
                    }
                    catch (err) {
                        (0, ui_1.logError)("reader_failed", String(err));
                        // Offer the [R/A/C] dialog
                        try {
                            const handled = await (0, reader_manager_1.handleReaderError)(agent, config, config.blocked_tools, err, (0, bash_filter_1.wrapForReader)(command), agent.promptUser);
                            // If "Allow once" was selected, return a special marker
                            if (handled.startsWith("[ALLOW_ONCE]")) {
                                return { result: handled, allow_once: true };
                            }
                            // Retry succeeded — return the result
                            return { result: handled, subagent_used: true };
                        }
                        catch (finalErr) {
                            (0, ui_1.updateStatusBar)("error");
                            return {
                                error: true,
                                message: finalErr instanceof Error
                                    ? finalErr.message
                                    : "Reader failed",
                            };
                        }
                    }
                }
                // Ambiguous command → ask user
                const answer = await agent.promptUser(`The command "${command}" may read files. Run via Reader? [Y/n]`);
                if (answer.trim().toLowerCase() === "n" ||
                    answer.trim().toLowerCase() === "no") {
                    // Let the original tool run
                    return undefined;
                }
                // Forward to Reader
                (0, ui_1.log)("reader_calling", command);
                try {
                    const result = await (0, reader_manager_1.callReader)(agent, config, (0, bash_filter_1.wrapForReader)(command));
                    (0, ui_1.log)("reader_done");
                    return { result, subagent_used: true };
                }
                catch (err) {
                    (0, ui_1.logError)("reader_failed", String(err));
                    return {
                        error: true,
                        message: err instanceof Error ? err.message : "Reader failed",
                    };
                }
            });
        }
        catch {
            // onBeforeToolCall not supported for this tool — no-op
        }
    }
}
// ---------------------------------------------------------------------------
// Pi commands
// ---------------------------------------------------------------------------
function registerCommands(agent) {
    agent.registerCommand("read-delegator", async (args) => {
        const sub = args[0]?.toLowerCase();
        switch (sub) {
            case "on":
            case "enable": {
                if (!config) {
                    config = (0, config_1.loadConfig)();
                }
                config.enabled = true;
                (0, config_1.saveConfig)(config, { silent: true });
                doEnable(agent);
                return (0, ui_1.msg)("enabled");
            }
            case "off":
            case "disable": {
                if (config) {
                    config.enabled = false;
                    (0, config_1.saveConfig)(config, { silent: true });
                }
                doDisable(agent);
                return (0, ui_1.msg)("disabled");
            }
            case "status": {
                const status = (0, ui_1.getStatus)();
                const blocked = (0, tool_blocker_1.getBlockedTools)();
                return (`pi-read-delegator is ${status}\n` +
                    `Enabled: ${enabled ? "yes" : "no"}\n` +
                    `Blocked tools: ${blocked.join(", ") || "(none)"}\n` +
                    `Reader subagent: ${config?.reader_subagent_name ?? "reader"}\n` +
                    `Language: ${config?.language ?? "auto"}`);
            }
            default:
                return ("Usage:\n" +
                    "  /read-delegator on     — enable read delegation\n" +
                    "  /read-delegator off    — disable read delegation\n" +
                    "  /read-delegator status — show current status");
        }
    });
}
//# sourceMappingURL=index.js.map