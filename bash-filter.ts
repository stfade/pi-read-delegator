/**
 * bash-filter.ts — Bash command classification and Reader forwarding
 *
 * Classifies shell commands as read-only (delegate to Reader subagent),
 * write (execute directly), or ambiguous (prompt user).
 */

// ---------------------------------------------------------------------------
// Command lists
// ---------------------------------------------------------------------------

/**
 * Commands that ONLY read and should be forwarded to the Reader subagent.
 * - sed without -i is read-only (stream editor writing to stdout).
 * - awk is read-only (pattern scanning and processing language).
 */
const READ_COMMANDS = new Set([
	"cat",
	"grep",
	"find",
	"ls",
	"head",
	"tail",
	"less",
	"wc",
	"nl",
	"more",
	"bat",
	"rg",
	"fd",
	"awk",
	"du",
	"df",
	"stat",
	"file",
	"which",
	"where",
	"type",
	"dir",
]);

/**
 * Commands that write to the filesystem and should execute directly.
 * sed and tee are context-dependent — handled specially in isWriteCommand.
 */
const WRITE_COMMANDS = new Set([
	"mkdir",
	"touch",
	"echo",
	"rm",
	"mv",
	"cp",
	"chmod",
	"chown",
	"ln",
	"rmdir",
	"npm",
	"pnpm",
	"yarn",
	"pip",
	"cargo",
	"go",
	"npx",
	"node",
	"python",
	"python3",
	"git",
	"docker",
	"kubectl",
	"tsc",
	"make",
	"cmake",
	"dotnet",
	"rustc",
	"gcc",
	"g++",
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Determine if a bash command is read-only and should be forwarded to Reader.
 *
 * Rules:
 * - If the first word is in READ_COMMANDS → true
 * - sed without -i flag → true (read-only stream edit)
 * - sed with -i → false (in-place edit = write)
 */
export function isReadCommand(command: string): boolean {
	const argv = parseArgv(command);
	if (argv.length === 0) return false;

	const cmd = argv[0].toLowerCase();

	// sed is special: if -i is present, it's a write; otherwise read-only
	if (cmd === "sed" || cmd === "sed.exe") {
		return !hasInlineFlag(argv);
	}

	return READ_COMMANDS.has(cmd);
}

/**
 * Determine if a bash command modifies the filesystem and should run directly.
 *
 * Rules:
 * - If the first word is in WRITE_COMMANDS → true
 * - sed with -i flag → true (in-place edit)
 * - Command contains > or >> redirect → true (writes to file)
 * - Command contains tee without -a flag → true (writes to file)
 */
export function isWriteCommand(command: string): boolean {
	const argv = parseArgv(command);
	if (argv.length === 0) return false;

	const cmd = argv[0].toLowerCase();

	// sed with -i = write
	if (cmd === "sed" || cmd === "sed.exe") {
		return hasInlineFlag(argv);
	}

	if (WRITE_COMMANDS.has(cmd)) return true;

	// Check for output redirection markers (> or >>)
	// We do a simple string match outside the parsed argv because parseArgv
	// might stop at the redirect operator.
	if (/\b>>?\b/.test(command)) return true;

	// tee is ambiguous: if -a (append) it's write, otherwise also write
	if (cmd === "tee" || cmd === "tee.exe") return true;

	return false;
}

/**
 * Wrap a shell command into a Reader subagent task.
 *
 * Returns a formatted string instructing the Reader to execute and report
 * minimal results.
 */
export function wrapForReader(command: string): string {
	return [
		"Execute this shell command and return ONLY the essential result.",
		"Max 5 lines or a single number. Never dump full file contents.",
		`Command: ${command}`,
	].join("\n");
}

/**
 * Wrap a generic task (non-bash) into a Reader subagent task.
 */
export function wrapTaskForReader(task: string): string {
	return [
		"Execute this task and return ONLY the essential result.",
		"Max 5 lines or a single number. Never dump full file contents.",
		`Task: ${task}`,
	].join("\n");
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Parse a command string into argv tokens, respecting single/double quotes.
 *
 * This is a simplified parser — edge cases like escaped quotes inside
 * opposite-quoted strings are handled on a best-effort basis.
 */
function parseArgv(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];

		if (inSingle) {
			if (ch === "'") {
				inSingle = false;
			} else {
				current += ch;
			}
		} else if (inDouble) {
			if (ch === '"') {
				inDouble = false;
			} else if (ch === "\\" && i + 1 < command.length) {
				// Simple escape handling inside double quotes
				const next = command[i + 1];
				if (next === '"' || next === "\\" || next === "$" || next === "`") {
					current += next;
					i++;
				} else {
					current += ch;
				}
			} else {
				current += ch;
			}
		} else {
			if (ch === "'") {
				inSingle = true;
			} else if (ch === '"') {
				inDouble = true;
			} else if (ch === " " || ch === "\t") {
				if (current.length > 0) {
					tokens.push(current);
					current = "";
				}
			} else {
				current += ch;
			}
		}
	}

	// Flush remaining token
	if (current.length > 0) {
		tokens.push(current);
	}

	return tokens;
}

/**
 * Check whether `sed` has the -i (in-place) flag.
 */
function hasInlineFlag(argv: string[]): boolean {
	for (let i = 1; i < argv.length; i++) {
		const arg = argv[i];
		// -i, -i.bak, --in-place, --in-place=.bak
		if (arg === "-i" || arg.startsWith("-i.") || arg === "--in-place") {
			return true;
		}
		if (arg.startsWith("--in-place=")) {
			return true;
		}
		// Stop at the expression (s/.../.../ or -e '...') — flags after that
		// might apply to the expression, not sed itself. In practice, -i always
		// comes before the expression.
	}
	return false;
}
