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
import { type AgentWithSubagent } from "./reader-manager";
/**
 * The Pi agent interface as consumed by pi-read-delegator.
 * Extends the building-block types from sub-modules.
 */
export interface PiAgent extends AgentWithSubagent {
    /** Return current tool definitions. */
    getTools(): Array<{
        name: string;
    }>;
    /** Remove a tool by name. */
    removeTool(name: string): void;
    /** Add/re-add a tool definition. */
    addTool(definition: {
        name: string;
        [key: string]: unknown;
    }): void;
    /** Append a persistent system message to the conversation. */
    addSystemMessage(text: string): void;
    /** Remove a previously-added system message by its exact text. */
    removeSystemMessage(text: string): void;
    /** Register a hook that fires BEFORE a tool with the given name is called. */
    onBeforeToolCall(toolName: string, callback: (params: unknown) => Promise<unknown> | unknown): void;
    /** Register a Pi command (like /read-delegator on). */
    registerCommand(name: string, handler: (args: string[]) => Promise<string> | string): void;
    /** Execute a raw shell command directly on the system. */
    executeShellCommand(command: string): Promise<{
        stdout: string;
        stderr: string;
    }>;
    /** Prompt the user for input. */
    promptUser(message: string): Promise<string>;
    /** Display a message to the user. */
    displayMessage(message: string): void;
    /** Set status bar text. */
    setStatusBarText(text: string): void;
}
/**
 * Initialize the extension.
 *
 * This is the function Pi calls when loading the extension.
 * It returns a lifecycle object with enable() and disable().
 */
export declare function init(agent: PiAgent): {
    enable: () => void;
    disable: () => void;
};
//# sourceMappingURL=index.d.ts.map