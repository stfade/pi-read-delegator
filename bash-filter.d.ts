/**
 * bash-filter.ts — Bash command classification and Reader forwarding
 *
 * Classifies shell commands as read-only (delegate to Reader subagent),
 * write (execute directly), or ambiguous (prompt user).
 */
/**
 * Determine if a bash command is read-only and should be forwarded to Reader.
 *
 * Rules:
 * - If the first word is in READ_COMMANDS → true
 * - sed without -i flag → true (read-only stream edit)
 * - sed with -i → false (in-place edit = write)
 */
export declare function isReadCommand(command: string): boolean;
/**
 * Determine if a bash command modifies the filesystem and should run directly.
 *
 * Rules:
 * - If the first word is in WRITE_COMMANDS → true
 * - sed with -i flag → true (in-place edit)
 * - Command contains > or >> redirect → true (writes to file)
 * - Command contains tee without -a flag → true (writes to file)
 */
export declare function isWriteCommand(command: string): boolean;
/**
 * Wrap a shell command into a Reader subagent task.
 *
 * Returns a formatted string instructing the Reader to execute and report
 * minimal results.
 */
export declare function wrapForReader(command: string): string;
/**
 * Wrap a generic task (non-bash) into a Reader subagent task.
 */
export declare function wrapTaskForReader(task: string): string;
//# sourceMappingURL=bash-filter.d.ts.map