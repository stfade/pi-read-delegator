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
/** Minimal shape for a Pi tool definition. */
export interface ToolDefinition {
    name: string;
    description?: string;
    [key: string]: unknown;
}
/** The Pi agent interface this module operates on. */
export interface ExtensionAgent {
    getTools(): ToolDefinition[];
    removeTool(name: string): void;
    addTool(definition: ToolDefinition): void;
}
/**
 * Remove the listed tools from the agent.
 * Saves their definitions so they can be restored later.
 * If a tool is already removed, it is silently skipped.
 */
export declare function blockTools(agent: ExtensionAgent, tools: string[]): void;
/**
 * Restore all previously blocked tools to the agent.
 * If a tool was never removed, it is skipped.
 */
export declare function restoreTools(agent: ExtensionAgent): void;
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
export declare function tempAllowOnce<T>(agent: ExtensionAgent, blockedTools: string[], callback: () => Promise<T>): Promise<T>;
/**
 * Check whether a given tool is currently blocked.
 */
export declare function isBlocked(toolName: string): boolean;
/**
 * Get the list of currently blocked tool names.
 */
export declare function getBlockedTools(): string[];
/**
 * Clear all blocked tool state (useful for testing / full reset).
 */
export declare function reset(): void;
//# sourceMappingURL=tool-blocker.d.ts.map