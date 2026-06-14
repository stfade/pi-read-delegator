"use strict";
/**
 * tool-blocker.ts — Tool removal and restoration for pi-read-delegator
 *
 * Pi's Extension API exposes:
 *   agent.getTools()          → ToolDefinition[]
 *   agent.removeTool(name)    → void
 *   agent.addTool(definition)  → void
 *
 * We store removed tool definitions in a Map so they can be restored later.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.blockTools = blockTools;
exports.restoreTools = restoreTools;
exports.tempAllowOnce = tempAllowOnce;
exports.isBlocked = isBlocked;
exports.getBlockedTools = getBlockedTools;
exports.reset = reset;
// ---------------------------------------------------------------------------
// Tool blocker state
// ---------------------------------------------------------------------------
/** Stores tool definitions that were removed, keyed by tool name. */
const removedTools = new Map();
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Remove the listed tools from the agent.
 * Saves their definitions so they can be restored later.
 * If a tool is already removed, it is silently skipped.
 */
function blockTools(agent, tools) {
    const currentTools = agent.getTools();
    for (const toolName of tools) {
        // Skip if already removed
        if (removedTools.has(toolName))
            continue;
        const definition = currentTools.find((t) => t.name === toolName);
        if (definition) {
            removedTools.set(toolName, definition);
            try {
                agent.removeTool(toolName);
                console.log(`[pi-read-delegator] Blocked tool: ${toolName}`);
            }
            catch (err) {
                console.error(`[pi-read-delegator] Failed to block tool "${toolName}": ${err}`);
            }
        }
    }
}
/**
 * Restore all previously blocked tools to the agent.
 * If a tool was never removed, it is skipped.
 */
function restoreTools(agent) {
    for (const [toolName, definition] of removedTools.entries()) {
        try {
            agent.addTool(definition);
            console.log(`[pi-read-delegator] Restored tool: ${toolName}`);
        }
        catch (err) {
            console.error(`[pi-read-delegator] Failed to restore tool "${toolName}": ${err}`);
        }
    }
    removedTools.clear();
}
/**
 * Temporarily allow the main model to use blocked tools for one operation.
 *
 * 1. Restore the tools
 * 2. Await the callback (which performs the read)
 * 3. Re-block the tools
 *
 * @param agent        The Pi agent
 * @param blockedTools List of tool names that should stay blocked normally
 * @param callback     Async function to run while tools are available
 * @returns The callback's return value
 */
async function tempAllowOnce(agent, blockedTools, callback) {
    // Restore temporarily
    const restoredNow = [];
    // We need to get the definitions from our map, but they might not be there
    // if the tools were never initially blocked. In that case, we just re-block
    // the names after.
    for (const toolName of blockedTools) {
        const definition = removedTools.get(toolName);
        if (definition) {
            try {
                agent.addTool(definition);
                // Remove from the map temporarily so restoreTools doesn't double-restore
                removedTools.delete(toolName);
                restoredNow.push(toolName);
            }
            catch (err) {
                console.error(`[pi-read-delegator] Failed to temporarily restore "${toolName}": ${err}`);
            }
        }
    }
    try {
        // Run the callback while tools are available
        const result = await callback();
        return result;
    }
    finally {
        // Re-block the tools we restored
        for (const toolName of restoredNow) {
            // Find the definition from agent's current tool list before removing
            const currentTools = agent.getTools();
            const definition = currentTools.find((t) => t.name === toolName);
            if (definition) {
                removedTools.set(toolName, definition);
                try {
                    agent.removeTool(toolName);
                }
                catch (err) {
                    console.error(`[pi-read-delegator] Failed to re-block "${toolName}": ${err}`);
                }
            }
        }
    }
}
/**
 * Check whether a given tool is currently blocked.
 */
function isBlocked(toolName) {
    return removedTools.has(toolName);
}
/**
 * Get the list of currently blocked tool names.
 */
function getBlockedTools() {
    return Array.from(removedTools.keys());
}
/**
 * Clear all blocked tool state (useful for testing / full reset).
 */
function reset() {
    removedTools.clear();
}
//# sourceMappingURL=tool-blocker.js.map