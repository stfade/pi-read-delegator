"use strict";
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
exports.default = default_1;
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const DEFAULT_CONFIG = {
    enabled: true,
    reader_subagent_name: "reader",
    blocked_tools: ["read", "grep", "find", "ls"],
    orchestrator_prompt: [
        "You are an orchestrator. You do NOT have direct file-reading tools.",
        "For any file reading, searching, or directory listing, use the",
        "'subagent' tool with agent='reader'.",
        'Example: subagent(agent: "reader", task: "Find all TS files that import \'lodash\'")',
        "Never try to use read, grep, find, or ls yourself. Always delegate.",
    ].join("\n"),
    language: "auto",
};
const READ_BASH_COMMANDS = new Set([
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
function configPath() {
    return path.join(os.homedir(), ".pi", "agent", "read-delegator.json");
}
function readerPath() {
    return path.join(os.homedir(), ".pi", "agent", "agents", "reader.md");
}
function loadConfig() {
    const cp = configPath();
    try {
        if (fs.existsSync(cp)) {
            const raw = fs.readFileSync(cp, "utf8");
            const parsed = JSON.parse(raw);
            return { ...DEFAULT_CONFIG, ...parsed };
        }
    }
    catch {
        // corrupt file --- fall back to defaults
    }
    try {
        const dir = path.dirname(cp);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(cp, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf8");
    }
    catch {
        // read-only home directory --- ignore
    }
    return { ...DEFAULT_CONFIG };
}
function saveConfig(config) {
    const cp = configPath();
    try {
        const dir = path.dirname(cp);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(cp, JSON.stringify(config, null, 2), "utf8");
    }
    catch {
        // read-only home directory --- ignore
    }
}
async function ensureReaderTemplate() {
    const rp = readerPath();
    if (fs.existsSync(rp))
        return;
    const content = [
        "---",
        "name: reader",
        "description: Token-efficient code reader that returns minimal results.",
        "tools: read, grep, find, ls",
        "model: lmstudio/nvidia/nemotron-3-nano-4b",
        "---",
        "",
        "You are a token-efficient analyst. Execute read/search/list tasks and return",
        "ONLY the essential result. Maximum 10 lines. Use bullet summaries.",
        "Never dump entire files. Focus only on what was asked.",
    ].join("\n");
    try {
        const dir = path.dirname(rp);
        fs.mkdirSync(dir, { recursive: true });
        await fs.promises.writeFile(rp, content, "utf8");
    }
    catch {
        // read-only home directory --- template creation is best-effort
    }
}
/**
 * Determine which tools should stay active after blocking read tools.
 *
 * We MUST keep the 'subagent' tool (registered by pi-subagents) active;
 * otherwise the orchestrator cannot call the reader at all.
 */
function computeActiveTools(pi, blocked) {
    const all = pi.getAllTools();
    const blockedSet = new Set(blocked);
    // Always keep "subagent" --- it is the bridge to the reader.
    const forceKeep = new Set(["subagent"]);
    return all
        .map((t) => t.name)
        .filter((name) => forceKeep.has(name) || !blockedSet.has(name));
}
// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------
async function default_1(pi) {
    const config = loadConfig();
    if (!config.enabled)
        return;
    // --- 1. Block read tools ------------------------------------------------
    const active = computeActiveTools(pi, config.blocked_tools);
    pi.setActiveTools(active);
    // --- 2. Inject orchestrator system prompt -------------------------------
    pi.on("before_agent_start", async (event, _ctx) => {
        return {
            systemPrompt: `${event.systemPrompt}\n\n${config.orchestrator_prompt}`,
        };
    });
    // --- 3. Intercept bash read commands ------------------------------------
    //
    // When the LLM tries `cat some-file` or similar, we block the call and
    // tell it to route through the reader subagent instead.
    pi.on("tool_call", async (event, _ctx) => {
        if (event.toolName === "bash" || event.toolName === "shell") {
            const command = String(event.input?.command ?? "");
            const firstWord = command.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
            if (READ_BASH_COMMANDS.has(firstWord)) {
                return {
                    block: true,
                    reason: [
                        `Use subagent(agent: "reader", task: "Execute and summarize: ${command}")`,
                        "instead of running file-reading commands directly.",
                    ].join(" "),
                };
            }
        }
    });
    // --- 4. Register /read-delegator command --------------------------------
    pi.registerCommand("read-delegator", {
        description: "Manage read delegation (on|off|status)",
        handler: async (args, ctx) => {
            const sub = args?.trim().toLowerCase() ?? "status";
            switch (sub) {
                case "on":
                case "enable": {
                    config.enabled = true;
                    saveConfig(config);
                    const active2 = computeActiveTools(pi, config.blocked_tools);
                    pi.setActiveTools(active2);
                    ctx.ui.notify("🟢 Read delegation enabled", "info");
                    return;
                }
                case "off":
                case "disable": {
                    config.enabled = false;
                    saveConfig(config);
                    // Restore all tools
                    pi.setActiveTools(pi.getAllTools().map((t) => t.name));
                    ctx.ui.notify("🔴 Read delegation disabled", "info");
                    ctx.ui.setStatus("read-delegator", undefined);
                    return;
                }
                case "status":
                default: {
                    const lines = [
                        `Read delegation: ${config.enabled ? "🟢 enabled" : "🔴 disabled"}`,
                        `Blocked tools: ${config.blocked_tools.join(", ")}`,
                        `Reader subagent: ${config.reader_subagent_name}`,
                    ];
                    ctx.ui.notify(lines.join("\n"), "info");
                    return;
                }
            }
        },
    });
    // --- 5. Ensure reader.md template ---------------------------------------
    await ensureReaderTemplate();
    // --- 6. Status bar ------------------------------------------------------
    pi.on("session_start", async (_event, ctx) => {
        ctx.ui.setStatus("read-delegator", `● reader: ${config.reader_subagent_name}`);
    });
}
//# sourceMappingURL=index.js.map