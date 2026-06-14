"use strict";
/**
 * ui.ts — Localization, status bar, and logging for pi-read-delegator
 *
 * Detects the user's language preference (config → Pi settings → OS → "en")
 * and provides localized messages. Manages a status bar indicator.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLanguage = getLanguage;
exports.msg = msg;
exports.setLanguage = setLanguage;
exports.initStatusBar = initStatusBar;
exports.updateStatusBar = updateStatusBar;
exports.getStatus = getStatus;
exports.log = log;
exports.logError = logError;
exports.logWarn = logWarn;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------
/**
 * Language map of all translatable messages.
 *
 * Adding a new language means adding a record for every key.
 */
const messages = {
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
function getLanguage(configLang) {
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
            const settings = JSON.parse(raw);
            if (typeof settings.language === "string") {
                currentLang = settings.language;
                return currentLang;
            }
        }
    }
    catch {
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
    }
    catch {
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
function msg(key, lang) {
    const langCode = lang ?? currentLang;
    const entry = messages[key];
    if (!entry)
        return `??? ${key} ???`;
    return entry[langCode] ?? entry.en ?? key;
}
/**
 * Explicitly set the current language (for /read-delegator lang <code>).
 */
function setLanguage(lang) {
    currentLang = lang;
}
// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------
let statusBarAgent = null;
let currentStatus = "idle";
/**
 * Initialize the status bar with the given agent.
 */
function initStatusBar(agent) {
    statusBarAgent = agent;
    updateStatusBar("idle");
}
/**
 * Update the status bar indicator.
 */
function updateStatusBar(status) {
    currentStatus = status;
    if (!statusBarAgent)
        return;
    let text;
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
    }
    catch {
        // Graceful fallback — not all Pi versions support status bar
    }
}
/**
 * Get the current status.
 */
function getStatus() {
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
function log(key, detail) {
    const prefix = "[pi-read-delegator]";
    const message = msg(key);
    if (detail) {
        console.log(`${prefix} ${message}${detail}`);
    }
    else {
        console.log(`${prefix} ${message}`);
    }
}
/**
 * Log an error with the standard prefix.
 */
function logError(key, detail) {
    const prefix = "[pi-read-delegator]";
    const message = msg(key);
    const full = detail ? `${message}${detail}` : message;
    console.error(`${prefix} ${full}`);
}
/**
 * Log a warning with the standard prefix.
 */
function logWarn(key, detail) {
    const prefix = "[pi-read-delegator]";
    const message = msg(key);
    const full = detail ? `${message}${detail}` : message;
    console.warn(`${prefix} ${full}`);
}
//# sourceMappingURL=ui.js.map