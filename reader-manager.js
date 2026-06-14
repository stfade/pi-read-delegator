"use strict";
/**
 * reader-manager.ts — Reader subagent lifecycle and error handling
 *
 * Responsibilities:
 *  - Check that pi-subagents is installed (prompt user if not)
 *  - Ensure the reader.md subagent template exists
 *  - Call the Reader subagent with a task
 *  - Handle errors with a [R]etry / [A]llow once / [C]ancel prompt
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
exports.ReaderError = void 0;
exports.checkDependencies = checkDependencies;
exports.ensureReaderTemplate = ensureReaderTemplate;
exports.callReader = callReader;
exports.handleReaderError = handleReaderError;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const child_process_1 = require("child_process");
/** Error thrown when the Reader subagent fails. */
class ReaderError extends Error {
    originalError;
    constructor(message, originalError) {
        super(message);
        this.originalError = originalError;
        this.name = "ReaderError";
    }
}
exports.ReaderError = ReaderError;
// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
function expandTilde(p) {
    if (p.startsWith("~"))
        return path.join(os.homedir(), p.slice(1));
    return p;
}
const READER_TEMPLATE_PATH = expandTilde("~/.pi/agent/agents/reader.md");
// ---------------------------------------------------------------------------
// 1. Dependency check
// ---------------------------------------------------------------------------
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
async function checkDependencies(prompt) {
    // Try to resolve pi-subagents to verify it's installed
    if (isSubagentsInstalled()) {
        return true;
    }
    console.warn("[pi-read-delegator] ⚠️ pi-subagents is not installed.");
    const answer = await prompt("⚠️ pi-subagents is not installed. Install it now? [Y/n]");
    const normalized = answer.trim().toLowerCase();
    if (normalized !== "" && normalized !== "y" && normalized !== "yes") {
        throw new Error("pi-subagents is required. Please install it manually: pi install pi-subagents");
    }
    // Attempt installation
    console.log("[pi-read-delegator] 📦 Installing pi-subagents…");
    try {
        // Try `pi install pi-subagents` first (the Pi package manager)
        (0, child_process_1.execSync)("pi install pi-subagents", {
            stdio: "pipe",
            timeout: 60_000,
            encoding: "utf-8",
        });
        console.log("[pi-read-delegator] ✅ pi-subagents installed via pi.");
    }
    catch {
        // Fallback to global npm install
        try {
            (0, child_process_1.execSync)("npm install -g pi-subagents", {
                stdio: "pipe",
                timeout: 60_000,
                encoding: "utf-8",
            });
            console.log("[pi-read-delegator] ✅ pi-subagents installed via npm.");
        }
        catch (err) {
            throw new Error("❌ Installation failed. Please install manually: npm install -g pi-subagents");
        }
    }
    // Verify installation took effect
    if (!isSubagentsInstalled()) {
        throw new Error("❌ pi-subagents installed but cannot be found. Restart Pi and try again.");
    }
    return true;
}
/**
 * Simple check: can we require/import pi-subagents?
 */
function isSubagentsInstalled() {
    try {
        // Dynamic require that works even if TypeScript doesn't know the module
        const mod = require("pi-subagents");
        return mod !== undefined;
    }
    catch {
        return false;
    }
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
function ensureReaderTemplate() {
    if (fs.existsSync(READER_TEMPLATE_PATH)) {
        return true;
    }
    // Path to the bundled template (sibling to the compiled JS)
    const bundledPath = path.join(__dirname, "templates", "reader.md");
    if (!fs.existsSync(bundledPath)) {
        console.warn("[pi-read-delegator] ⚠️ Bundled reader template not found at:", bundledPath);
        console.warn("[pi-read-delegator] Please create ~/.pi/agent/agents/reader.md manually.");
        return false;
    }
    try {
        const content = fs.readFileSync(bundledPath, "utf-8");
        ensureDir(path.dirname(READER_TEMPLATE_PATH));
        fs.writeFileSync(READER_TEMPLATE_PATH, content, "utf-8");
        console.log(`[pi-read-delegator] ✅ Created reader subagent template: ${READER_TEMPLATE_PATH}`);
        return true;
    }
    catch (err) {
        console.error("[pi-read-delegator] ⚠️ Failed to create reader template:", err);
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
async function callReader(agent, config, task, timeoutMs = 30_000) {
    const result = await withTimeout(agent.callSubagent({
        name: config.reader_subagent_name,
        task,
    }), timeoutMs, `Reader subagent timed out after ${timeoutMs / 1000}s`);
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
async function handleReaderError(agent, config, blockedTools, error, task, prompt) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[pi-read-delegator] ❌ Reader failed: ${errMsg}`);
    const answer = await prompt(`\n❌ Reader subagent failed: ${errMsg}\n` +
        `[R]etry  [A]llow once (let main model do it)  [C]ancel\n`);
    const choice = answer.trim().toLowerCase();
    if (choice === "r" || choice === "retry") {
        // Retry the same task
        console.log("[pi-read-delegator] 🔄 Retrying Reader…");
        return callReader(agent, config, task);
    }
    if (choice === "a" || choice === "allow" || choice === "allow once") {
        // Temporarily unblock tools, let main model execute the task,
        // then re-block.
        console.log("[pi-read-delegator] 🔓 Allowing main model to read once…");
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
        return `[ALLOW_ONCE] The blocked tools (${blockedTools.join(", ")}) are now temporarily available. Please perform the following task yourself, then tools will be re-blocked:\n\n${task}`;
    }
    // Cancel
    throw new ReaderError(`Reader failed and user cancelled: ${errMsg}`, error);
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** Race a promise against a timeout. */
async function withTimeout(promise, ms, timeoutMessage) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ReaderError(timeoutMessage)), ms);
    });
    try {
        const result = await Promise.race([promise, timeout]);
        return result;
    }
    finally {
        clearTimeout(timer);
    }
}
/** Ensure a directory exists, creating it recursively. */
function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}
//# sourceMappingURL=reader-manager.js.map