# pi-read-delegator

Pi extension that removes read tools (`read`, `grep`, `find`, `ls`) from the main model and delegates all read operations to a local **Reader** subagent.

## How It Works

```
Main Model                    Reader Subagent
┌──────────┐                  ┌──────────┐
│ write    │                  │ read     │
│ edit     │    ──task──>     │ grep     │
│ bash     │    <──result──   │ find     │
│ (write)  │                  │ ls       │
└──────────┘                  └──────────┘
```

- **Write tools** (`write`, `edit`) remain with the main model.
- **Read tools** (`read`, `grep`, `find`, `ls`) are blocked on the main model and routed to the Reader subagent.
- **Bash commands** are filtered: read commands go to Reader, write commands execute directly, ambiguous commands prompt the user.

## Requirements

- [pi-subagents](https://github.com/earendil-works/pi-subagents) installed
- A local LLM for the Reader subagent (default: `lmstudio/nemotron-mini`)

## Installation

```bash
pi install npm:@stfade/pi-read-delegator
```

Or manually:

```bash
npm install -g pi-read-delegator
```

Then edit `~/.pi/agent/agents/reader.md` to set your preferred Reader model.

## Commands

| Command | Description |
|---|---|
| `/read-delegator on` | Enable read delegation |
| `/read-delegator off` | Disable read delegation |
| `/read-delegator status` | Show current status |

## Configuration

Edit `~/.pi/agent/read-delegator.json`:

```json
{
  "enabled": true,
  "reader_subagent_name": "reader",
  "blocked_tools": ["read", "grep", "find", "ls"],
  "allowed_bash_write_commands": ["mkdir", "echo", "touch", "sed", "rm", "mv", "cp"],
  "orchestrator_prompt": "You are an orchestrator. For any file reading... use the subagent tool...",
  "language": "auto"
}
```

| Field | Description |
|---|---|
| `enabled` | Enable/disable the extension |
| `reader_subagent_name` | Name of the Reader subagent (must match `reader.md`) |
| `blocked_tools` | Tools to block from the main model |
| `language` | `"auto"`, `"tr"`, or `"en"` |

## Reader Subagent

The Reader template is created at `~/.pi/agent/agents/reader.md` on first run. Edit the `model:` line to use your preferred provider:

```yaml
model: lmstudio/nemotron-mini   # LM Studio
# model: ollama/phi3             # Ollama
# model: openai/gpt-4o-mini      # OpenAI
# model: anthropic/claude-haiku   # Anthropic
```

## Error Handling

When the Reader fails:

- **[R]etry** — resend the same task to Reader
- **[A]llow once** — temporarily unblock tools for one operation
- **[C]ancel** — report the failure

## Bash Filter

| Read commands → Reader | Write commands → Direct |
|---|---|
| `cat`, `grep`, `find`, `ls` | `mkdir`, `touch`, `rm`, `mv` |
| `head`, `tail`, `less`, `wc` | `cp`, `chmod`, `chown` |
| `bat`, `rg`, `fd`, `awk` | `npm`, `git`, `docker` |
| `sed` (without `-i`) | `sed -i` (in-place edit) |

## Supported Languages

- **English** (`en`)
- **Turkish** (`tr`)

Language is auto-detected from Pi's settings or the OS locale.

## License

MIT
