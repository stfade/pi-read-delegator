# pi-read-delegator – AGENTS.md

## Project Overview

A Pi extension that removes read tools (read, grep, find, ls) from the main model and delegates all read operations to a local Reader subagent. Writing tools (write, edit) remain. Bash is filtered: read-like commands go to Reader, write-like commands execute directly.

## Core Principles

- **Open**: Configurable subagent name, model provider, blocked tools, bash filter rules
- **Closed**: Main model never directly reads. All reads go through Reader subagent.
- **Token efficiency**: Reader returns only results (numbers, summaries, short lists), never file dumps

## Architecture

```
pi-read-delegator/
├── index.ts (or index.js)       # Extension entry point
├── config.ts                     # Config loader (read-delegator.json)
├── tool-blocker.ts               # Tool removal/restoration
├── bash-filter.ts                # Bash command filtering logic
├── reader-manager.ts             # Subagent health, templates, dependency check
├── ui.ts                         # Log messages, status bar, language map
├── templates/
│   └── reader.md                 # Default Reader subagent template
├── package.json
└── README.md
```

## Component Details

### config.ts

- Loads `~/.pi/agent/read-delegator.json`
- Defaults: enabled=true, reader_subagent_name="reader", blocked_tools=["read","grep","find","ls"], language="auto"
- Exports typed config object

### tool-blocker.ts

- `blockTools(pi, tools[])` – removes listed tools from orchestrator via pi.setActiveTools()
- `restoreTools(pi)` – restores all tools via pi.setActiveTools()
- `tempAllowOnce(pi, tools, callback)` – temporarily allows blocked tools, runs callback, re-blocks in finally
- `consumeAllowOnce(pi, tools)` – re-blocks tools after a single allow-once read operation
- `isAllowOnceActive()` – check if single-shot allow-once is active
- `isBlocked(toolName)` – check if a specific tool is blocked
- `getBlockedTools()` – return list of currently blocked tool names

### bash-filter.ts

- List of read-like commands: cat, grep, find, ls, head, tail, less, wc, nl, more, bat, rg, fd
- `isReadCommand(command: string): boolean`
- `redirectToReader(command: string): string` – wraps command into Reader task

### reader-manager.ts

- `checkDependencies()` – verifies pi-subagents is installed; if not, auto-installs via npm
- `isSubagentsInstalled()` – synchronous check if pi-subagents exists on disk
- `SessionFileCache` class – session-level file cache with hash-based invalidation and range tracking
- Reader call and error handling flow lives in index.ts via tool_call/tool_result hooks (not standalone functions)

### ui.ts

- Language map for log messages (tr, en as minimum)
- Status bar indicator: `● active` / `○ idle` / `⚠ error`
- Console log format: `🔍 Reader: <message>`

## Subagent Template (templates/reader.md)

```yaml
---
name: reader
description: Read-only agent that returns minimal results
tools: read, grep, find, ls
model: lmstudio/nemotron-mini  # Change to ollama/phi3, etc.
---

You are a token-efficient assistant. Execute read/search tasks and return ONLY the essential result. Max 5 lines or a single number. Never dump files.
```

## Error Handling Flow

1. Reader output is scanned for error patterns (Error:, [ERROR], [FAILED], timeout, no model, unavailable) or empty output
2. On detection: all read tools are unblocked, recovery prompt appended to reader output
3. Recovery prompt: `[R]etry  [A]llow once  [C]ancel` plus `/read-delegator-off` and `/read-delegator-on`
4. Retry: orchestrator calls subagent(agent="reader", task="...") again with same task (preferred)
5. Allow once: orchestrator uses read/grep/find/ls directly — re-blocks after one operation
6. Cancel: move on without the read
7. Toggle: `/read-delegator-off` permanently unblocks, `/read-delegator-on` re-enables

## Platform & Provider Support

- **Platform**: Windows primarily (v1), with cross-platform paths via `path` module
- **Providers**: Any that pi-subagents supports. Reader.md model line determines provider:
  - `lmstudio/...`, `ollama/...`, `openai/...`, `llamacpp/...`, `anthropic/...`

## Key Behaviors

- On init: check deps, ensure template, block tools, add system message, attach bash filter
- On disable: restore tools, remove system message, remove bash filter
- On reader fail: 3-option prompt (retry/allow once/cancel)
- Logging: detects Pi language setting, shows localized single-line logs
- Status bar: reflects current state

## MVP Scope

- [x] Tool blocking/restoration
- [x] Bash command filtering
- [x] Reader subagent integration via pi-subagents
- [x] Error handling with 3 options
- [x] Config file with defaults
- [x] Auto-install pi-subagents if missing
- [x] Localized logging (tr/en)
- [x] Status bar indicator
- [x] Reader.md template generation
- [ ] Cross-platform testing (Linux/Mac)
- [ ] Advanced bash filter (pipes, redirections)
- [ ] Reader model auto-detection
- [ ] Performance metrics logging
