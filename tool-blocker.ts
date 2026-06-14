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

// ---------------------------------------------------------------------------
// Types (what we assume Pi's API gives us)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tool blocker state
// ---------------------------------------------------------------------------

/** Stores tool definitions that were removed, keyed by tool name. */
const removedTools = new Map<string, ToolDefinition>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Remove the listed tools from the agent.
 * Saves their definitions so they can be restored later.
 * If a tool is already removed, it is silently skipped.
 */
export function blockTools(agent: ExtensionAgent, tools: string[]): void {
	const currentTools = agent.getTools();

	for (const toolName of tools) {
		// Skip if already removed
		if (removedTools.has(toolName)) continue;

		const definition = currentTools.find((t) => t.name === toolName);
		if (definition) {
			removedTools.set(toolName, definition);
			try {
				agent.removeTool(toolName);
				console.log(`[pi-read-delegator] Blocked tool: ${toolName}`);
			} catch (err) {
				console.error(
					`[pi-read-delegator] Failed to block tool "${toolName}": ${err}`,
				);
			}
		}
	}
}

/**
 * Restore all previously blocked tools to the agent.
 * If a tool was never removed, it is skipped.
 */
export function restoreTools(agent: ExtensionAgent): void {
	for (const [toolName, definition] of removedTools.entries()) {
		try {
			agent.addTool(definition);
			console.log(`[pi-read-delegator] Restored tool: ${toolName}`);
		} catch (err) {
			console.error(
				`[pi-read-delegator] Failed to restore tool "${toolName}": ${err}`,
			);
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
export async function tempAllowOnce<T>(
	agent: ExtensionAgent,
	blockedTools: string[],
	callback: () => Promise<T>,
): Promise<T> {
	// Restore temporarily
	const restoredNow: string[] = [];

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
			} catch (err) {
				console.error(
					`[pi-read-delegator] Failed to temporarily restore "${toolName}": ${err}`,
				);
			}
		}
	}

	try {
		// Run the callback while tools are available
		const result = await callback();
		return result;
	} finally {
		// Re-block the tools we restored
		for (const toolName of restoredNow) {
			// Find the definition from agent's current tool list before removing
			const currentTools = agent.getTools();
			const definition = currentTools.find((t) => t.name === toolName);
			if (definition) {
				removedTools.set(toolName, definition);
				try {
					agent.removeTool(toolName);
				} catch (err) {
					console.error(
						`[pi-read-delegator] Failed to re-block "${toolName}": ${err}`,
					);
				}
			}
		}
	}
}

/**
 * Check whether a given tool is currently blocked.
 */
export function isBlocked(toolName: string): boolean {
	return removedTools.has(toolName);
}

/**
 * Get the list of currently blocked tool names.
 */
export function getBlockedTools(): string[] {
	return Array.from(removedTools.keys());
}

/**
 * Clear all blocked tool state (useful for testing / full reset).
 */
export function reset(): void {
	removedTools.clear();
}
