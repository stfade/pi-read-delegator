/**
 * reader-manager.ts — Reader subagent lifecycle and error handling
 *
 * Responsibilities:
 *  - Check that pi-subagents is installed (prompt user if not)
 *  - Ensure the reader.md subagent template exists
 *  - Call the Reader subagent with a task
 *  - Handle errors with a [R]etry / [A]llow once / [C]ancel prompt
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { exec } from "child_process";
import type { ReadDelegatorConfig } from "./config";
import type { ExtensionAgent } from "./tool-blocker";
import { rawLog, rawWarn, rawError } from "./ui";

// ---------------------------------------------------------------------------
// Session-level file cache (CCR — Content Conscious Retrieval)
// ---------------------------------------------------------------------------

/**
 * In-memory cache for files read by the reader subagent during this session.
 * Tracks content hashes and read line ranges to avoid redundant re-reads.
 *
 * While the extension cannot directly intercept subagent calls to short-circuit
 * them, the orchestrator prompt instructs the model to use progressive reading
 * and reuse already-retrieved content from its own context window.
 */
interface CacheEntry {
	content: string;
	hash: string;
	timestamp: number;
	sizeBytes: number;
}

export class SessionFileCache {
	private files = new Map<string, CacheEntry>();
	private readRanges = new Map<string, Array<[number, number]>>();

	/** Cache a file's content with a hash for change detection. */
	set(path: string, content: string): void {
		this.files.set(path, {
			content,
			hash: simpleHash(content),
			timestamp: Date.now(),
			sizeBytes: Buffer.byteLength(content, "utf-8"),
		});
	}

	get(path: string): string | undefined {
		return this.files.get(path)?.content;
	}

	has(path: string): boolean {
		return this.files.has(path);
	}

	getHash(path: string): string | undefined {
		return this.files.get(path)?.hash;
	}

	/** Record that a specific line range of a path has been read. */
	markReadRange(path: string, from: number, to: number): void {
		const existing = this.readRanges.get(path) ?? [];
		existing.push([from, to]);
		this.readRanges.set(path, existing);
	}

	getReadRanges(path: string): Array<[number, number]> {
		return this.readRanges.get(path) ?? [];
	}

	/** Compute gaps (unread line ranges) given total line count. */
	getUnreadRanges(path: string, totalLines: number): Array<[number, number]> {
		const read = this.readRanges.get(path);
		if (!read || read.length === 0) return [[1, totalLines]];

		const sorted = [...read].sort((a, b) => a[0] - b[0]);
		const gaps: Array<[number, number]> = [];
		let pos = 1;

		for (const [from, to] of sorted) {
			if (from > pos) gaps.push([pos, from - 1]);
			pos = Math.max(pos, to + 1);
		}
		if (pos <= totalLines) gaps.push([pos, totalLines]);
		return gaps;
	}

	/** Return cache statistics for the status command. */
	stats(): { files: number; sizeKB: number; ranges: number } {
		let totalSize = 0;
		for (const entry of this.files.values()) totalSize += entry.sizeBytes;
		return {
			files: this.files.size,
			sizeKB: Math.round(totalSize / 1024),
			ranges: this.readRanges.size,
		};
	}

	clear(): void {
		this.files.clear();
		this.readRanges.clear();
	}
}

/** Singleton cache instance shared across the extension session. */
export const sessionCache = new SessionFileCache();

/** Simple non-cryptographic hash for cache invalidation. */
function simpleHash(str: string): string {
	let h = 0;
	for (let i = 0; i < str.length; i++) {
		h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
	}
	return h.toString(36);
}

/**
 * Progress callback for dependency installation.
 */
export type InstallProgress = "installing" | "done" | "failed";

// ---------------------------------------------------------------------------
// Types for the Pi agent we extend
// ---------------------------------------------------------------------------

export interface AgentWithSubagent extends ExtensionAgent {
	/** Call a subagent by name with a task string. Returns the subagent's response. */
	callSubagent(params: { name: string; task: string }): Promise<string>;
}

/** Error thrown when the Reader subagent fails. */
export class ReaderError extends Error {
	constructor(
		message: string,
		public readonly originalError?: unknown,
	) {
		super(message);
		this.name = "ReaderError";
	}
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function expandTilde(p: string): string {
	if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
	return p;
}

const READER_TEMPLATE_PATH = expandTilde("~/.pi/agent/agents/reader.md");

// ---------------------------------------------------------------------------
// 1. Dependency check
// ---------------------------------------------------------------------------

/**
 * Verify that pi-subagents is installed as a Pi extension.
 *
 * - Checks fs.existsSync for the pi-subagents directory (bypasses require.resolve
 *   caching issues after npm install within the same process).
 * - If not installed, prompts the user to install via `npm install --prefix`.
 * - If the user declines or installation fails, returns false (caller disables the extension).
 *
 * @returns true if installed or successfully installed; false otherwise
 */

function piSubagentsDir(): string {
	return path.join(
		os.homedir(),
		".pi",
		"agent",
		"npm",
		"node_modules",
		"pi-subagents",
	);
}

function piSubagentsPackageJson(): string {
	return path.join(piSubagentsDir(), "package.json");
}

function piSettingsPath(): string {
	return path.join(os.homedir(), ".pi", "agent", "settings.json");
}

/**
 * Register pi-subagents in Pi's package list (settings.json).
 *
 * npm install puts the package on disk, but Pi's `pi list` command reads
 * from settings.json's `packages` array. Without this step, the user
 * won't see pi-subagents in their package list.
 */
function registerPiSubagentsPackage(): void {
	try {
		const settingsPath = piSettingsPath();
		let settings: Record<string, unknown> = {};

		if (fs.existsSync(settingsPath)) {
			const raw = fs.readFileSync(settingsPath, "utf-8");
			settings = JSON.parse(raw) as Record<string, unknown>;
		}

		const packages: unknown[] = Array.isArray(settings.packages)
			? [...(settings.packages as unknown[])]
			: [];

		const pkgName = "npm:pi-subagents";
		if (!packages.includes(pkgName)) {
			packages.push(pkgName);
			settings.packages = packages;

			// Atomic write: write to temp file then rename to avoid
			// corruption from concurrent writes by other extensions.
			const tmpPath = settingsPath + ".tmp";
			fs.writeFileSync(
				tmpPath,
				JSON.stringify(settings, null, 2) + "\n",
				"utf-8",
			);
			fs.renameSync(tmpPath, settingsPath);
			rawLog("✅ Registered pi-subagents in settings.json package list.");
		}
	} catch (err) {
		rawWarn(
			"⚠️ Failed to register pi-subagents in settings.json: " + String(err),
		);
	}
}

/**
 * Async wrapper around child_process.exec.
 * Returns stdout/stderr and rejects on non-zero exit or timeout.
 */
function execAsync(
	command: string,
	options: { cwd?: string; timeout?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = exec(
			command,
			{ cwd: options.cwd, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 },
			(err, stdout, stderr) => {
				if (err) {
					reject(Object.assign(err, { stdout, stderr }));
				} else {
					resolve({ stdout, stderr });
				}
			},
		);

		if (options.timeout && options.timeout > 0) {
			setTimeout(() => {
				child.kill();
				reject(new Error(`Command timed out after ${options.timeout}ms`));
			}, options.timeout);
		}
	});
}

export async function checkDependencies(
	prompt: (message: string) => Promise<string>,
	onProgress?: (status: InstallProgress) => void,
): Promise<boolean> {
	// Already installed — nothing to do
	if (fs.existsSync(piSubagentsPackageJson())) {
		registerPiSubagentsPackage();
		return true;
	}

	rawWarn("⚠️ pi-subagents is not installed.");

	const answer = await prompt(
		"pi-subagents is not installed. Install it now? [Y/n]",
	);

	const normalized = answer.trim().toLowerCase();
	if (normalized !== "" && normalized !== "y" && normalized !== "yes") {
		rawError("❌ Cannot proceed without pi-subagents. Extension disabled.");
		return false;
	}

	// Attempt installation
	const piNpmDir = path.join(os.homedir(), ".pi", "agent", "npm");
	rawLog("📦 Installing pi-subagents to " + piNpmDir + "…");

	onProgress?.("installing");

	try {
		await execAsync(`npm install --prefix "${piNpmDir}" pi-subagents`, {
			timeout: 120_000,
		});
		rawLog("✅ pi-subagents installed via npm.");
		registerPiSubagentsPackage();
		onProgress?.("done");
	} catch (firstErr) {
		onProgress?.("failed");
		rawError(
			"⚠️ npm install failed: " +
				(firstErr instanceof Error ? firstErr.message : String(firstErr)),
		);
		rawError("❌ Cannot proceed without pi-subagents. Extension disabled.");
		return false;
	}

	// Verify installation took effect
	if (fs.existsSync(piSubagentsPackageJson())) {
		return true;
	}
	rawError(
		"❌ pi-subagents installed but cannot be found at " +
			piSubagentsDir() +
			". Restart Pi and try again.",
	);
	return false;
}

/**
 * Quick synchronous check: does pi-subagents exist on disk?
 */
export function isSubagentsInstalled(): boolean {
	return fs.existsSync(piSubagentsPackageJson());
}

// ---------------------------------------------------------------------------
// 2. Reader template
// ---------------------------------------------------------------------------

/**
 * Ensure the reader.md subagent template exists.
 * If not, copy the bundled template from `templates/reader.md`.
 *
 * @returns true if the template exists after this call
 */
export function ensureReaderTemplate(): boolean {
	if (fs.existsSync(READER_TEMPLATE_PATH)) {
		return true;
	}

	// Path to the bundled template (sibling to the compiled JS)
	const bundledPath = path.join(__dirname, "templates", "reader.md");

	if (!fs.existsSync(bundledPath)) {
		rawWarn("⚠️ Bundled reader template not found at: " + bundledPath);
		rawWarn("Please create ~/.pi/agent/agents/reader.md manually.");
		return false;
	}

	try {
		const content = fs.readFileSync(bundledPath, "utf-8");
		ensureDir(path.dirname(READER_TEMPLATE_PATH));
		fs.writeFileSync(READER_TEMPLATE_PATH, content, "utf-8");
		rawLog(`✅ Created reader subagent template: ${READER_TEMPLATE_PATH}`);
		return true;
	} catch (err) {
		rawError("⚠️ Failed to create reader template: " + String(err));
		return false;
	}
}

// ---------------------------------------------------------------------------
// 3. Call Reader
// ---------------------------------------------------------------------------

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
export async function callReader(
	agent: AgentWithSubagent,
	config: ReadDelegatorConfig,
	task: string,
	timeoutMs: number = 30_000,
): Promise<string> {
	const result = await withTimeout(
		agent.callSubagent({
			name: config.reader_subagent_name,
			task,
		}),
		timeoutMs,
		`Reader subagent timed out after ${timeoutMs / 1000}s`,
	);

	if (!result || result.trim().length === 0) {
		throw new ReaderError("Reader subagent returned an empty response.");
	}

	return result;
}

// ---------------------------------------------------------------------------
// 4. Error handling: [R]etry / [A]llow once / [C]ancel
// ---------------------------------------------------------------------------

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
export async function handleReaderError(
	agent: AgentWithSubagent,
	config: ReadDelegatorConfig,
	blockedTools: string[],
	error: unknown,
	task: string,
	prompt: (message: string) => Promise<string>,
): Promise<string> {
	const errMsg = error instanceof Error ? error.message : String(error);

	rawError(`❌ Reader failed: ${errMsg}`);

	const answer = await prompt(
		`\n❌ Reader subagent failed: ${errMsg}\n` +
			`[R]etry  [A]llow once (let main model do it)  [C]ancel\n`,
	);

	const choice = answer.trim().toLowerCase();

	if (choice === "r" || choice === "retry") {
		// Retry the same task
		rawLog("🔄 Retrying Reader…");
		return callReader(agent, config, task);
	}

	if (choice === "a" || choice === "allow" || choice === "allow once") {
		// Temporarily unblock tools, let main model execute the task,
		// then re-block.
		rawLog("🔓 Allowing main model to read once…");

		// NOTE: For "Allow once", we need the main model to perform the task.
		// However, we are inside a tool call — the main model can't run code
		// inline. We return a specially formatted string that instructs the
		// main model: "blocked tools are now available for one operation;
		// please perform the following task and then they will be re-locked."
		//
		// The tempAllowOnce wrapper re-blocks after this handler returns.

		// Actually, the flow for "Allow once" is:
		// 1. We restore tools (they're currently blocked)
		// 2. We return a message telling the main model "do this task yourself"
		// 3. After the main model does ONE operation, tools are re-blocked
		//
		// But since we can't intercept the main model's turn boundary
		// precisely, we return a message and rely on the next hook point
		// to re-block. The caller should call tempAllowOnce around this.

		return `[ALLOW_ONCE] The blocked tools (${blockedTools.join(
			", ",
		)}) are now temporarily available. Please perform the following task yourself, then tools will be re-blocked:\n\n${task}`;
	}

	// Cancel
	throw new ReaderError(`Reader failed and user cancelled: ${errMsg}`, error);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Race a promise against a timeout. */
async function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	timeoutMessage: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;

	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new ReaderError(timeoutMessage)), ms);
	});

	try {
		const result = await Promise.race([promise, timeout]);
		return result;
	} finally {
		clearTimeout(timer!);
	}
}

/** Ensure a directory exists, creating it recursively. */
function ensureDir(dir: string): void {
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
}
