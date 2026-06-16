/**
 * tool-blocker.ts — Tool removal and restoration for pi-read-delegator
 *
 * Uses Pi's ExtensionAPI (setActiveTools / getAllTools) to block and
 * restore read tools on the orchestrator model.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let blockedSet = new Set<string>();
let allowOnceFlag = false;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Remove the listed tools from the orchestrator's active set.
 * Calls pi.setActiveTools() with the filtered list.
 */
export function blockTools(pi: ExtensionAPI, tools: string[]): void {
	blockedSet = new Set(tools);
	applyBlock(pi);
}

/**
 * Restore all previously blocked tools (set all tools as active).
 */
export function restoreTools(pi: ExtensionAPI): void {
	const all = pi.getAllTools().map((t) => t.name);
	pi.setActiveTools(all);
	blockedSet.clear();
	allowOnceFlag = false;
}

/**
 * Temporarily allow blocked tools for one operation.
 *
 * 1. Restore all tools
 * 2. Run callback (orchestrator makes its read call)
 * 3. Re-block tools after callback resolves
 *
 * The re-block sets allowOnceFlag = true so the next tool_result
 * triggers automatic re-blocking.
 */
export async function tempAllowOnce<T>(
	pi: ExtensionAPI,
	blockedTools: string[],
	callback: () => Promise<T>,
): Promise<T> {
	const all = pi.getAllTools().map((t) => t.name);
	pi.setActiveTools(all);
	allowOnceFlag = true;

	try {
		const result = await callback();
		return result;
	} finally {
		// Re-block after the operation completes
		blockedSet = new Set(blockedTools);
		applyBlock(pi);
		allowOnceFlag = false;
	}
}

/**
 * Signal that a single allow-once operation has completed.
 * Called by index.ts after the tool_result event to re-block tools.
 */
export function consumeAllowOnce(
	pi: ExtensionAPI,
	blockedTools: string[],
): boolean {
	if (!allowOnceFlag) return false;
	blockedSet = new Set(blockedTools);
	applyBlock(pi);
	allowOnceFlag = false;
	return true;
}

/**
 * Check whether a single-shot allow-once is active.
 */
export function isAllowOnceActive(): boolean {
	return allowOnceFlag;
}

/**
 * Check whether a given tool is currently blocked.
 */
export function isBlocked(toolName: string): boolean {
	return blockedSet.has(toolName);
}

/**
 * Get the list of currently blocked tool names.
 */
export function getBlockedTools(): string[] {
	return [...blockedSet];
}

/**
 * Clear all blocked tool state (useful for testing / full reset).
 */
export function reset(): void {
	blockedSet.clear();
	allowOnceFlag = false;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function applyBlock(pi: ExtensionAPI): void {
	const all = pi.getAllTools().map((t) => t.name);
	const active = all.filter((name) => !blockedSet.has(name));

	// Always keep "subagent" — the bridge to the reader
	if (!active.includes("subagent")) {
		active.push("subagent");
	}

	pi.setActiveTools(active);
}
