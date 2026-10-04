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

The child gets an environment built from an allowlist (`reviewerEnv` in `packages/cli/src/reviewers/claude.ts`): `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, locale, `TERM`, `TZ`, `CLAUDE_CONFIG_DIR`, proxy and CA settings, the `ANTHROPIC_*` key, URL and model variables, and the Bedrock, Vertex or Foundry variables only when the matching `CLAUDE_CODE_USE_*` flag is set; plus `OPENQODEX_REVIEW_DEPTH=1`. No other variable is copied, so no developer token and nothing that ties the child to a running Claude Code session (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, messaging sockets) reaches it. A run from inside a Claude Code session with this environment worked as the runs below did.

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

### The boundary and the alarm

The boundary is Claude Code's own permission rules: `--tools Read,Grep,Glob` and `--permission-mode dontAsk` with no settings source, which refused every read outside the working folder in the runs above. The alarm is the tool's own check of the event stream (`packages/cli/src/reviewers/trace.ts`), which does not trust the boundary and fails closed:

- the run fails when the `init` event lists any tool beyond Read, Grep and Glob, any MCP server or a memory path; the `Agent` tool is never listed, so no subagent or nested turn can make a call the stream does not show, and every `tool_use` in the stream is checked whichever turn it came from;
- every tool call counts from the moment the agent asks for it, with or without a result; a tool name other than the three makes the review incomplete;
- every path-bearing input (`file_path`, `path`, `notebook_path`, `cwd`, `directory`, and a `pattern` or `glob` that starts at `/`, `~`, a drive or `..`) is resolved against the snapshot, then through the real path of its deepest existing folder, and compared case-insensitively on macOS and Windows; a path with `$`, `%` or a NUL is refused, `~` is the home folder;
- an input that is not an object, or a path field that is not text, makes the review incomplete;
- any attempt outside the snapshot makes the review incomplete, even one the agent refused.

The snapshot holds no links (they are written as plain files) and secrets the scanners found are redacted in every file of it before the reviewer starts; a file too large to check is removed from it.

### What the agent stores

With `--no-session-persistence` and auto memory off, real runs with Claude Code 2.1.289 left no transcript, no `history.jsonl` line and no project entry for a snapshot folder in the configuration folder (searched for the brief's text and the snapshot paths after the runs). An earlier run without `autoMemoryEnabled: false` left one empty `projects/<folder>/memory` folder; with the flag, none. The driver keeps the developer's configuration folder because a temporary one loses the login.

### Not covered

- Managed (policy) settings set by an organisation still apply; they can add hooks or permission rules. The trace check above still fails a run that reads outside the snapshot.
- Each new Claude Code version can change these flags. Re-run these checks before raising the tested version.
