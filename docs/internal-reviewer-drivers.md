# Reviewer drivers

This page is for contributors. It records how `openqodex review` starts its own reviewer process, and what was observed with the real binary before a driver was enabled. A driver is enabled only when every property below was shown by a real run.

The reviewer is a separate coding-agent process that openqodex starts, without a window, for one review. It reads a frozen copy of the change (the snapshot) and answers with one JSON object. The trace is the agent's own event stream: every tool call, its input and whether it succeeded.

## Claude Code

Tested with Claude Code 2.1.289 (`claude --version`) on macOS, 2026-10-03, on a throwaway folder and on the demo repo.

### The command line

The driver starts this command without a shell, with the snapshot as the working directory, and writes the brief to standard input:

```
claude -p --output-format stream-json --verbose --input-format stream-json
  --tools Read,Grep,Glob
  --permission-mode dontAsk
  --setting-sources ""
  --settings {"autoMemoryEnabled":false,"hooks":{}}
  --strict-mcp-config --mcp-config {"mcpServers":{}}
  --disable-slash-commands
  --no-session-persistence
```

The child gets the parent's environment minus the variables that tie a process to a running Claude Code session (`CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_JOB_DIR`, `CLAUDE_EFFORT` and the `CLAUDE_CODE_*` session, entry point, messaging and path variables), plus `OPENQODEX_REVIEW_DEPTH=1`.

### What each flag was observed to do

| Flag | Observed |
|---|---|
| `-p` with `--input-format stream-json` | A fresh session that reads user messages as JSON lines on standard input. After each answer it prints a `result` event and waits for the next message, so a correction round goes to the same session. Closing standard input ends the process with exit 0. |
| `--output-format stream-json --verbose` | One JSON event per line: an `init` event (tools, MCP servers, plugins, permission mode, memory paths, version), every `tool_use` with its input, every `tool_result` with `is_error`, a `permission_denied` event for each refusal, and a `result` event with the final text, turns, usage and cost. For a Read, `tool_use_result.file` gives the path, `startLine` and `numLines` delivered. |
| `--tools Read,Grep,Glob` | The `init` event lists exactly `Glob`, `Grep`, `Read`. Asked to run `ls /` and to write a file, the model answered that it has no Bash or Write tool; no such tool call appears in the trace. The `Agent` tool is absent, so no subagent can start. |
| `--permission-mode dontAsk` | Reads inside the working directory succeed. A Read of an absolute path outside it (`/tmp/.../outside/secret.txt`, `/etc/hosts`, a decoy ssh config), a relative path that leaves it (`../outside/secret.txt`), a Read through a link inside the folder that points outside, and a Grep or Glob rooted outside (`/tmp/...`, `/`) were each refused with a `permission_denied` event and an error result. A recursive Grep and a `**/*` Glob in the folder did not follow the link out. |
| `--setting-sources ""` | No user, project or local settings file is read. In the same folder, a run without this flag loaded the project `CLAUDE.md` canary (the answer ended with the canary word) and the user's global instructions (the answer quoted them, about 155,000 input tokens); with it, the input was about 4,500 tokens and neither canary nor any sentence of the global file appeared anywhere in the event stream. With `--include-hook-events`, a run reading user settings showed 11 hook events; this run showed none. |
| `--settings {"autoMemoryEnabled":false,"hooks":{}}` | The `init` event has no `memory_paths`: auto memory is off. |
| `--strict-mcp-config --mcp-config {"mcpServers":{}}` | The `init` event lists no MCP server. |
| `--disable-slash-commands` | The `init` event lists no skill and no slash command. |
| `--no-session-persistence` | Nothing is saved for a later `--resume`; the correction rounds use the open process instead. |

`AGENTS.md`: a canary there was not loaded in any run, with or without settings. The built-in plugins (`cc-plugin-agents-md`, `cc-plugin-telemetry`, `cc-plugin-plugin-authoring`) stay listed; they are part of Claude Code and read no repository instruction file in this configuration.

### Where it works

- Started from a Bash tool inside a running Claude Code session: works, with the same tools and the same refusals.
- Started from a plain environment (`PATH`, `HOME`, `USER`, `LOGNAME`, `TMPDIR` and the developer's own `CLAUDE_CONFIG_DIR`): works. Without `USER` the login in the macOS keychain is not found and the run ends with "Not logged in".
- A temporary `CLAUDE_CONFIG_DIR` loses the login, so the driver keeps the developer's own configuration folder and excludes its contents with the flags above.

### Detecting it

- `claude --version` prints the version.
- `claude auth status` prints JSON with `loggedIn`. Exit 1 and `"loggedIn": false` mean the reviewer cannot start.

### Usage

Each `result` event carries `num_turns` and `usage` for that turn (input, output and cache tokens), and `total_cost_usd` and `modelUsage` for the session so far. The driver adds up the turns and takes tokens and cost from the last `result` event.

### What the tool still checks itself

The permission rules are the agent's own. The tool does not trust them alone: it fails a run whose `init` event lists any tool beyond Read, Grep and Glob, any MCP server or a memory path, and a run whose trace shows any tool other than those three or any successful read of a path outside the snapshot. The snapshot holds no links (they are written as plain files) and secrets the scanners found are redacted in it.

### Not covered

- Managed (policy) settings set by an organisation still apply; they can add hooks or permission rules. The trace check above still fails a run that reads outside the snapshot.
- Each new Claude Code version can change these flags. Re-run these checks before raising the tested version.
