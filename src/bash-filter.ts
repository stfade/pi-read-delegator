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
 *
 * Covers three shells:
 *   - bash/sh (Linux/macOS/WSL/Git Bash)
 *   - PowerShell (Windows)
 *   - cmd.exe (Windows)
 *
 * All comparisons are case-insensitive (isReadSegment lowercases the argv).
 *
 * Context-dependent:
 *   - sed without -i is read-only (stream editor → stdout)
 *   - awk is read-only (pattern scanning / processing language)
 */
const READ_COMMANDS = new Set([
	// ── bash / sh (Linux, macOS, WSL, Git Bash) ──
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
	"sort",
	"uniq",
	"cut",
	"tr",
	"diff",
	"cmp",
	"comm",
	"od",
	"hexdump",
	"xxd",

	// ── PowerShell (Windows) ──
	"get-content",
	"select-string",
	"get-childitem",
	"get-itemproperty",
	"get-item",
	"test-path",
	"get-alias",
	"get-command",
	"measure-object",
	"compare-object",
	"where-object",
	"select-object",
	"format-list",
	"format-table",
	"get-service",
	"get-process",
	"get-eventlog",
	"get-history",
	"get-variable",
	"get-psdrive",
	"get-psprovider",

	// ── cmd.exe (Windows) ──
	"findstr",
	"comp",
	"fc",
	"tree",
]);

/**
 * Commands that write to the filesystem and should execute directly.
 * sed and tee are context-dependent — handled specially in isWriteCommand.
 *
 * Covers bash/sh, PowerShell, and cmd.exe writable commands.
 */
const WRITE_COMMANDS = new Set([
	// ── bash / sh ──
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

	// ── cross-platform build tools ──
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

	// ── PowerShell write commands ──
	"set-content",
	"add-content",
	"new-item",
	"remove-item",
	"copy-item",
	"move-item",
	"rename-item",
	"out-file",
	"export-csv",
	"export-clixml",
	"start-process",
	"invoke-expression",
	"invoke-webrequest",

	// ── cmd.exe write commands ──
	"del",
	"erase",
	"rename",
	"copy",
	"xcopy",
	"robocopy",
	"move",
	"md",
	"rd",
	"attrib",
	"icacls",
	"cacls",
	"setx",
	"reg",
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Output redirect operators. These turn a read command into a write —
 * e.g. `grep pattern file > out.txt` writes output to a file. We still
 * block these because the actual operation (grep/find/cat) is a read.
 */
const REDIRECT_WRITE = /\b>>?\b/;

/**
 * Split a command string by shell separators (&&, ||, ;, |, &) and return
 * the list of segment strings. Respects quoting so separators inside quotes
 * are not treated as actual shell separators.
 */
export function splitShellSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];

		if (inSingle) {
			current += ch;
			if (ch === "'") inSingle = false;
		} else if (inDouble) {
			current += ch;
			if (ch === '"') inDouble = false;
			else if (ch === "\\" && i + 1 < command.length) {
				current += command[++i];
			}
		} else if (ch === "'") {
			current += ch;
			inSingle = true;
		} else if (ch === '"') {
			current += ch;
			inDouble = true;
		} else if (ch === "|") {
			// Peek ahead for ||
			if (i + 1 < command.length && command[i + 1] === "|") {
				// || separator
				segments.push(current.trim());
				current = "";
				i++; // skip second |
			} else {
				// Single | pipe
				segments.push(current.trim());
				current = "";
			}
		} else if (ch === "&") {
			if (i + 1 < command.length && command[i + 1] === "&") {
				// && separator
				segments.push(current.trim());
				current = "";
				i++; // skip second &
			} else {
				// Single & background
				segments.push(current.trim());
				current = "";
			}
		} else if (ch === ";") {
			segments.push(current.trim());
			current = "";
		} else {
			current += ch;
		}
	}

	// Flush remaining
	const remainder = current.trim();
	if (remainder.length > 0) {
		segments.push(remainder);
	}

	return segments;
}

/**
 * Check if a single segment (no pipes/chains) is a read command.
 */
function isReadSegment(segment: string): boolean {
	const argv = parseArgv(segment);
	if (argv.length === 0) return false;

	const cmd = argv[0].toLowerCase();

	// sed without -i is read-only
	if (cmd === "sed" || cmd === "sed.exe") {
		return !hasInlineFlag(argv);
	}

	return READ_COMMANDS.has(cmd);
}

/**
 * Determine if a bash command is read-only and should be forwarded to Reader.
 *
 * Splits on shell separators (&&, ||, ;, |, &) and checks EACH segment.
 * If ANY segment starts with a read command, the full command is blocked.
 *
 * Examples:
 *   isReadCommand("cat file")               → true
 *   isReadCommand("echo hello && cat file")  → true (cat in chain)
 *   isReadCommand("npm test")               → false
 *   isReadCommand("grep x | head -5")       → true (pipeline)
 */
export function isReadCommand(command: string): boolean {
	const segments = splitShellSegments(command);
	for (const seg of segments) {
		if (isReadSegment(seg)) return true;
	}
	return false;
}

/**
 * Determine if a bash command modifies the filesystem and should run directly.
 *
 * Rules:
 * - If any segment's first word is in WRITE_COMMANDS → true
 * - sed with -i flag → true (in-place edit)
 * - Command contains > or >> redirect → true (writes to file)
 * - Command contains tee → true (writes to file)
 */
export function isWriteCommand(command: string): boolean {
	const segments = splitShellSegments(command);

	for (const seg of segments) {
		const argv = parseArgv(seg);
		if (argv.length === 0) continue;

		const cmd = argv[0].toLowerCase();

		if (cmd === "sed" || cmd === "sed.exe") {
			if (hasInlineFlag(argv)) return true;
			continue;
		}

		if (WRITE_COMMANDS.has(cmd)) return true;

		// tee always writes
		if (cmd === "tee" || cmd === "tee.exe") return true;
	}

	// Output redirects anywhere in the full command = write
	if (REDIRECT_WRITE.test(command)) return true;

	return false;
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
