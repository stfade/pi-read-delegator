# pi-read-delegator

**Pi extension**: delegates all file-read and search operations to a lightweight Reader subagent. The main model never sees raw file contents — saving tokens, avoiding context pollution, and keeping the orchestrator focused on reasoning.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ ORCHESTRATOR (main model)                                    │
│   • Cannot use: read, grep, find, ls                         │
│   • Cannot run: cat, grep, head, tail, Get-Content, findstr  │
│   • MUST delegate via: subagent(agent="reader", task="...")  │
│                                                              │
│   System prompt tells orchestrator HOW to delegate:          │
│     Action: read | Target: src/file.ts | Detail: function X  │
│     Action: grep | Target: src/    | Detail: "pattern"       │
│     Action: find | Target: src/    | Detail: *.ts            │
└──────────────────────┬───────────────────────────────────────┘
                       │ subagent(agent="reader", task="...")
┌──────────────────────▼───────────────────────────────────────┐
│ READER SUBAGENT (pi-subagents → reader.md)                   │
│   • Tools: read, grep, find, ls                              │
│   • Receives structured task, returns structured output      │
│                                                              │
│   src/config.ts:42  const DEFAULT_CONFIG = {                  │
│   src/config.ts:43    enabled: true,                          │
│   ...                                                        │
└──────────────────────────────────────────────────────────────┘
```

### Communication protocol

The orchestrator and reader communicate through a **structured task/result protocol** — no free-form chatting, no "max N lines" truncation.

**Orchestrator → Reader** (task format):
```
Action: read | Target: src/config.ts | Detail: DEFAULT_CONFIG definition
Action: grep | Target: src/ | Detail: "isReadCommand" function
Action: find | Target: src/ | Detail: *.ts
```

**Reader → Orchestrator** (result format):
- Minimal, structured output — no markdown headers, no explanations
- grep: `file:line  content` (file path, line number, matched line)
- read: line-numbered file content
- find: bare file list, one per line
- ls: file names with sizes
- No matches: `(no matches)`
- Error: `Error: <message>`

This protocol was designed based on research findings around **token-efficient subagent orchestration**:
structured output beats free-form text, file-path-based handoffs avoid triple-token duplication, and single-level hierarchy keeps context clean.

---

### Token optimizations

The Reader subagent applies **6 optimization techniques** — researched from Headroom, RTK, and multi-agent orchestration literature — to minimize token usage on every call:

| # | Technique | What it does | Token savings |
|---|-----------|-------------|:------------:|
| 1 | **CCR Cache** | Session-level file cache with hash-based invalidation. Same file never read twice. | **83%** (re-reads) |
| 2 | **Structure masks** | Compresses imports, type annotations, and long paths in code output. | **35%** (code reads) |
| 3 | **Stats extraction** | grep/find/ls return counts first; >20 results → count only. | **60%** (searches) |
| 4 | **Smart filtering** | Auto-skips node_modules, .git, dist; detects binary files; deduplicates. | **20%** (noisy output) |
| 5 | **Graduated reading** | Orchestrator taught to use find→grep→read progression instead of full-file reads. | **40%** (surveys) |
| 6 | **Prompt compression** | Orchestrator prompt compressed from 55 to 22 lines via example-driven format. | **1.5K**/session |

### Token analysis (test results)

> **Instructions**: Test pi-read-delegator on different projects. For each project, measure
total tokens consumed across a full coding session with and without the extension.
Record results below.

| Project | Files | Size | No delegation | Basic delegation | With optimizations | Savings |
|---------|:-----:|------|:------------:|:----------------:|:------------------:|:-------:|
| *(your project)* | | | | | | |
| | | | | | | |
| | | | | | | |
| | | | | | | |
| | | | | | | |

**How to measure**: Use Pi's token counter or your provider's usage dashboard.
"Basic delegation" = extension enabled but optimizations disabled (set `reader_model` to same as orchestrator, clear cache between calls).
"With optimizations" = all 6 techniques active (default).
"Savings" = (No delegation − With optimizations) / No delegation × 100.

## Installation

```bash
pi install npm:@stfade/pi-read-delegator
```

On first session start, the extension:
1. Auto-installs `pi-subagents` as a dependency
2. Guides you through interactive model selection
3. Creates `~/.pi/agent/agents/reader.md` with the Reader's system prompt
4. Registers `pi-subagents` in Pi's package list

## Configuration

Config file: `~/.pi/agent/read-delegator.json`

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Enable/disable read delegation |
| `blocked_tools` | `["read","grep","find","ls"]` | Tools blocked from main model |
| `reader_subagent_name` | `"reader"` | Subagent name (must match `reader.md`) |
| `reader_model` | `"lmstudio/nvidia/nemotron-3-nano-4b"` | Model for the Reader (`provider/model`) |
| `orchestrator_prompt` | *(system prompt)* | Injected into main model's system prompt |
| `language` | `"auto"` | UI language: `"auto"`, `"en"`, `"tr"` |

The subagent template lives at `~/.pi/agent/agents/reader.md` and is auto-managed on every config change.

## Commands

| Command | Action |
|---------|--------|
| `/read-delegator` | Show current status |
| `/read-delegator-status` | Show current status |
| `/read-delegator-on` | Enable read delegation (blocks read tools) |
| `/read-delegator-off` | Disable read delegation (restores all tools) |
| `/read-delegator-model` | Interactive model picker |
| `/read-delegator-model lmstudio/mistral` | Set a specific model directly |

## Blocked commands

The extension intercepts read-like shell commands across **three shells** and redirects them to the Reader subagent:

### bash / sh (Linux, macOS, WSL, Git Bash)
`cat`, `grep`, `find`, `ls`, `head`, `tail`, `less`, `wc`, `nl`, `more`, `bat`, `rg`, `fd`, `awk`, `du`, `df`, `stat`, `file`, `which`, `where`, `type`, `dir`, `sort`, `uniq`, `cut`, `tr`, `diff`, `cmp`, `comm`, `od`, `hexdump`, `xxd`

### PowerShell (Windows)
`Get-Content`, `Select-String`, `Get-ChildItem`, `Get-ItemProperty`, `Get-Item`, `Test-Path`, `Get-Alias`, `Get-Command`, `Measure-Object`, `Compare-Object`, `Where-Object`, `Select-Object`, `Format-List`, `Format-Table`

### cmd.exe (Windows)
`type`, `findstr`, `find`, `dir`, `more`, `comp`, `fc`, `tree`

> **Pipe and chain detection**: `echo hello && cat file | grep x` — each segment is inspected independently. A single read command in any segment blocks the entire chain.

## Picking a Reader model

> **Critical requirement:** The Reader model **MUST support tool usage** (function calling).
> It uses `read`, `grep`, `find`, and `ls` via Pi's tool system to fulfill tasks.
> Models without tool-use capability **will not work** as a Reader.

A small, local model is ideal — the Reader executes precise file operations and returns structured results:

| Provider | Recommended models |
|----------|-------------------|
| **LM Studio** | `lmstudio/nemotron-mini`, `lmstudio/qwen2.5-7b-instruct` |
| **Ollama** | `ollama/qwen2.5:7b`, `ollama/llama3.2:3b` |
| **llama.cpp** | Any model with tool-use support |
| **OpenAI** | `openai/gpt-4o-mini` |
| **Anthropic** | `anthropic/claude-3.5-haiku` |
| **Gemini** | `gemini/gemini-2.0-flash` |

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "pi-subagents not installed" | Restart Pi; the extension auto-installs it on session start |
| Reader doesn't respond | Check `reader_model` in config; ensure the model supports tool usage |
| Reader returns incomplete data | The Reader returns minimal, structured output; check reader.md template |
| Tools not blocked | Run `/read-delegator on` |
| PowerShell commands bypass filter | Update to latest version; all three shells are covered |
| Model picker doesn't appear | Check `ctx.modelRegistry` is available in your Pi version |

## Project token breakdown

> Measured 2026-06-14. Token estimates use ~3.5 chars/token (code-heavy ratio).

| File type | Count | Size | Est. tokens |
|-----------|:-----:|------|:-----------:|
| TypeScript (`.ts`) | 6 | 66 KB | ~19,300 |
| JavaScript (`.js`) | 6 | 55 KB | ~16,100 |
| JSON (`.json`) | 3 | 81 KB | ~23,600 |
| Source maps (`.map`) | 12 | 42 KB | ~12,200 |
| Markdown (`.md`) | 3 | 12 KB | ~3,400 |
| **Total** | **36** | **255 KB** | **~74,700** |
| **Source only** (`.ts` + `.md`) | **9** | **78 KB** | **~22,700** |

> Source maps and compiled `.js`/`.d.ts` in `dist/` are build artifacts.
`package-lock.json` accounts for ~78 KB of the JSON total.

## Development

```bash
git clone <repo>
cd pi-read-delegator
npm install
npm run build   # compiles TypeScript to dist/
```

### Project structure

```
pi-read-delegator/
├── src/
│   ├── index.ts              # Entry point — events, commands, tool blocking
│   ├── config.ts             # Config load/save with defaults
│   ├── tool-blocker.ts       # Tool removal/restoration
│   ├── bash-filter.ts        # Cross-platform command classification
│   ├── reader-manager.ts     # Subagent health, dependency install, async exec
│   ├── ui.ts                 # Localization (tr/en), status bar, log wrappers
│   └── templates/
│       └── reader.md         # Default Reader subagent template
├── dist/                     # Compiled output (gitignored)
├── package.json
├── tsconfig.json
└── README.md
```

## License

MIT
