/**
 * reader-manager.ts — Reader subagent lifecycle and error handling
 *
 * Responsibilities:
 *  - Check that pi-subagents is installed (prompt user if not)
 *  - Ensure the reader.md subagent template exists
 *  - Call the Reader subagent with a task
 *  - Handle errors with a [R]etry / [A]llow once / [C]ancel prompt
 */
import type { ReadDelegatorConfig } from "./config";
import type { ExtensionAgent } from "./tool-blocker";
export interface AgentWithSubagent extends ExtensionAgent {
    /** Call a subagent by name with a task string. Returns the subagent's response. */
    callSubagent(params: {
        name: string;
        task: string;
    }): Promise<string>;
}
/** Error thrown when the Reader subagent fails. */
export declare class ReaderError extends Error {
    readonly originalError?: unknown | undefined;
    constructor(message: string, originalError?: unknown | undefined);
}
/**
 * Verify that pi-subagents is installed as a Pi extension.
 *
 * Strategy: check whether the `pi-subagents` npm package is findable.
 * If not, prompt the user to install it. If they agree, install via
 * `pi install pi-subagents` (fallback: `npm install -g pi-subagents`).
 *
 * @returns true if installed or successfully installed
 * @throws  if the user declines or installation fails
 */
export declare function checkDependencies(prompt: (message: string) => Promise<string>): Promise<boolean>;
/**
 * Ensure the reader.md subagent template exists.
 * If not, copy the bundled template from `templates/reader.md`.
 *
 * @returns true if the template exists after this call
 */
export declare function ensureReaderTemplate(): boolean;
/**
 * Send a task to the Reader subagent and return its response.
 *
 * @param agent   The Pi agent with subagent-calling capability
 * @param config  Current extension configuration
 * @param task    The task string to send
 * @param timeoutMs  Timeout in milliseconds (default 30s)
 * @returns       The Reader's response text
 * @throws        ReaderError on timeout, failure, or empty response
 */
export declare function callReader(agent: AgentWithSubagent, config: ReadDelegatorConfig, task: string, timeoutMs?: number): Promise<string>;
/**
 * Handle a Reader failure by prompting the user.
 *
 * Options:
 * - [R]etry  → re-send the same task to Reader
 * - [A]llow once → temporarily unblock tools, let main model do it, re-block
 * - [C]ancel → throw the error upstream
 *
 * @param agent         The Pi agent
 * @param config        Extension config
 * @param blockedTools  Tool names currently blocked
 * @param error         The error that occurred
 * @param task          The original task string
 * @param prompt        Async prompt function (should collect user input)
 * @returns             Reader response on Retry/Allow; never returns on Cancel
 * @throws              ReaderError on Cancel or repeated failure
 */
export declare function handleReaderError(agent: AgentWithSubagent, config: ReadDelegatorConfig, blockedTools: string[], error: unknown, task: string, prompt: (message: string) => Promise<string>): Promise<string>;
//# sourceMappingURL=reader-manager.d.ts.map