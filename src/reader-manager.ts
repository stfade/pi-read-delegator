/**
 * reader-manager.ts — Reader subagent lifecycle
 *
 * Responsibilities:
 *  - Check that pi-subagents is installed, auto-install if missing
 *  - Session-level file cache for read operations
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { exec } from "child_process";
import type { ReadDelegatorConfig } from "./config";
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
	onProgress?: (status: InstallProgress) => void,
): Promise<boolean> {
	// Already installed — nothing to do
	if (fs.existsSync(piSubagentsPackageJson())) {
		registerPiSubagentsPackage();
		return true;
	}

	rawLog("📦 pi-subagents is a required dependency. Installing now…");

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
