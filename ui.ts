/**
 * ui.ts — Localization, status bar, and logging for pi-read-delegator
 *
 * Detects the user's language preference (config → Pi settings → OS → "en")
 * and provides localized messages. Manages a status bar indicator.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Status = "active" | "idle" | "error";

/** Minimal Pi agent interface for the status bar API. */
export interface AgentWithStatusBar {
	/** Set text to display in the Pi status bar. */
	setStatusBarText(text: string): void;
}

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

/**
 * Language map of all translatable messages.
 *
 * Adding a new language means adding a record for every key.
 */
const messages: Record<string, Record<string, string>> = {
	reader_calling: {
		tr: "🔍 Reader: sorgu çalıştırılıyor…",
		en: "🔍 Reader: executing query…",
	},
	reader_done: {
		tr: "✅ Reader: tamamlandı",
		en: "✅ Reader: done",
	},
	reader_failed: {
		tr: "❌ Reader: başarısız - ",
		en: "❌ Reader: failed - ",
	},
	deps_missing: {
		tr: "⚠️ pi-subagents yüklü değil. Yüklensin mi? [E/h]",
		en: "⚠️ pi-subagents not installed. Install now? [Y/n]",
	},
	deps_installing: {
		tr: "📦 pi-subagents yükleniyor…",
		en: "📦 Installing pi-subagents…",
	},
	deps_failed: {
		tr: "❌ Kurulum başarısız. Elle yükleyin.",
		en: "❌ Installation failed. Install manually.",
	},
	status_active: {
		tr: "● aktif",
		en: "● active",
	},
	status_idle: {
		tr: "○ boşta",
		en: "○ idle",
	},
	status_error: {
		tr: "⚠ hata",
		en: "⚠ error",
	},
	blocked: {
		tr: "🚫 Engellendi: ",
		en: "🚫 Blocked: ",
	},
	already_blocked: {
		tr: "⚠ Araçlar zaten engellenmiş.",
		en: "⚠ Tools are already blocked.",
	},
	already_enabled: {
		tr: "⚠ Araçlar zaten aktif.",
		en: "⚠ Tools are already active.",
	},
	enabled: {
		tr: "✅ pi-read-delegator etkin",
		en: "✅ pi-read-delegator enabled",
	},
	disabled: {
		tr: "🔓 pi-read-delegator devre dışı — tüm araçlar serbest",
		en: "🔓 pi-read-delegator disabled — all tools free",
	},
	config_saved: {
		tr: "💾 Konfigürasyon kaydedildi",
		en: "💾 Configuration saved",
	},
};

// Cached language code determined at init time.
let currentLang = "en";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the effective language.
 *
 * Priority:
 * 1. Explicit language in config (if not "auto")
 * 2. Pi's own language setting from ~/.pi/settings.json
 * 3. Operating system locale (first two chars)
 * 4. Fallback "en"
 */
export function getLanguage(configLang?: string): string {
	// 1. Explicit config override
	if (configLang && configLang !== "auto") {
		currentLang = configLang;
		return currentLang;
	}

	// 2. Pi's own setting
	try {
		const piSettingsPath = path.join(os.homedir(), ".pi", "settings.json");
		if (fs.existsSync(piSettingsPath)) {
			const raw = fs.readFileSync(piSettingsPath, "utf-8");
			const settings = JSON.parse(raw) as Record<string, unknown>;
			if (typeof settings.language === "string") {
				currentLang = settings.language;
				return currentLang;
			}
		}
	} catch {
		// Silently fall through
	}

	// 3. OS locale (e.g., "tr-TR" → "tr")
	try {
		const locale = Intl.DateTimeFormat().resolvedOptions().locale;
		const short = locale.split("-")[0];
		if (short && short.length === 2 && messages.reader_calling[short]) {
			currentLang = short;
			return currentLang;
		}
	} catch {
		// Silently fall through
	}

	// 4. Fallback
	currentLang = "en";
	return currentLang;
}

/**
 * Retrieve a localized message by key.
 *
 * Falls back to English if the current language doesn't have the key.
 */
export function msg(key: string, lang?: string): string {
	const langCode = lang ?? currentLang;
	const entry = messages[key];
	if (!entry) return `??? ${key} ???`;
	return entry[langCode] ?? entry.en ?? key;
}

/**
 * Explicitly set the current language (for /read-delegator lang <code>).
 */
export function setLanguage(lang: string): void {
	currentLang = lang;
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

let statusBarAgent: AgentWithStatusBar | null = null;
let currentStatus: Status = "idle";

/**
 * Initialize the status bar with the given agent.
 */
export function initStatusBar(agent: AgentWithStatusBar): void {
	statusBarAgent = agent;
	updateStatusBar("idle");
}

/**
 * Update the status bar indicator.
 */
export function updateStatusBar(status: Status): void {
	currentStatus = status;
	if (!statusBarAgent) return;

	let text: string;
	switch (status) {
		case "active":
			text = msg("status_active");
			break;
		case "error":
			text = msg("status_error");
			break;
		default:
			text = msg("status_idle");
			break;
	}

	try {
		statusBarAgent.setStatusBarText(`pi-read-delegator: ${text}`);
	} catch {
		// Graceful fallback — not all Pi versions support status bar
	}
}

/**
 * Get the current status.
 */
export function getStatus(): Status {
	return currentStatus;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * Log a one-line Reader event using the current language.
 *
 * Prepend "[pi-read-delegator]" for easy filtering.
 */
export function log(key: string, detail?: string): void {
	const prefix = "[pi-read-delegator]";
	const message = msg(key);
	if (detail) {
		console.log(`${prefix} ${message}${detail}`);
	} else {
		console.log(`${prefix} ${message}`);
	}
}

/**
 * Log an error with the standard prefix.
 */
export function logError(key: string, detail?: string): void {
	const prefix = "[pi-read-delegator]";
	const message = msg(key);
	const full = detail ? `${message}${detail}` : message;
	console.error(`${prefix} ${full}`);
}

/**
 * Log a warning with the standard prefix.
 */
export function logWarn(key: string, detail?: string): void {
	const prefix = "[pi-read-delegator]";
	const message = msg(key);
	const full = detail ? `${message}${detail}` : message;
	console.warn(`${prefix} ${full}`);
}
