# Agents

OpenQodex runs inside Claude Code, Cursor, Codex CLI and Cline. `openqodex init` installs it into each one it finds. The review then runs on the agent's own model, with no key.

## Run init

Run it in your own terminal, not inside the agent:

```
npx openqodex init
```

`init` prints every file it will write and asks once. `--agent <name>` picks agents by hand: `claude-code`, `cursor`, `codex`, `cline` or `all`. `--dry-run` prints the plan and writes nothing.

## User scope and project scope

The default is user scope. `init` writes into your home folder, so one install works in every repository. A file it must put inside a repository is added to `.git/info/exclude`, so `git status` does not change.

`--project` writes the files into the repository instead, for a team to commit. Run it inside a git repository.

## The launcher

In user scope, the push gate hooks call a launcher, not npx. `init` copies the package to `~/.openqodex/runtime/<version>/` and checks the copy runs. It then writes `~/.openqodex/bin/openqodex`, a small script that runs that copy with your Node. The hooks call that script by its full path, so they do not depend on npx or your `PATH`.

In project scope, the hooks call `npx -y openqodex@<version>`, because the launcher path would not exist on a teammate's machine.

## Claude Code

| What | User scope | Project scope |
|---|---|---|
| Skill | `~/.claude/skills/openqodex/SKILL.md` | `.claude/skills/openqodex/SKILL.md` |
| Push gate hook | merged into `~/.claude/settings.json` | merged into `.claude/settings.json` |

The hook is one `PreToolUse` entry. It matches the `Bash` tool and runs only for `git push` commands. It calls `openqodex hook check`.

## Codex CLI

| What | User scope | Project scope |
|---|---|---|
| Skill | `~/.agents/skills/openqodex/SKILL.md` | `.agents/skills/openqodex/SKILL.md` |
| Instructions | not written | a marked section in `AGENTS.md` |
| Push gate hook | merged into `~/.codex/hooks.json` | merged into `.codex/hooks.json` |

Codex runs the hook before every shell command. `hook check` returns at once and prints nothing when the command is not a `git push`.

Codex runs a new hook only after you trust it. Open Codex, run `/hooks`, and trust the OpenQodex hook. Until then, Codex skips the push gate. A project hook also needs the project itself to be trusted in Codex.

## Cursor

| What | User scope | Project scope |
|---|---|---|
| Skill | `~/.cursor/skills/openqodex/SKILL.md` | `.agents/skills/openqodex/SKILL.md` |
| Rule | `.cursor/rules/openqodex.mdc` in the repository, excluded from git | `.cursor/rules/openqodex.mdc` |

Cursor has no rule file in the home folder, so the rule always goes in the repository. In user scope, run `init` inside each repository where you want the rule. The rule applies to every chat and tells Cursor to review before any `git push`.

OpenQodex writes no Cursor hook. The rule asks Cursor to review, but nothing stops a push from Cursor.

## Cline

| What | User scope | Project scope |
|---|---|---|
| Skill | `~/.cline/skills/openqodex/SKILL.md` | `.cline/skills/openqodex/SKILL.md` |
| Rule | `~/Documents/Cline/Rules/openqodex.md` | `.clinerules/openqodex.md` |

OpenQodex writes no Cline hook. The rule asks Cline to review before any `git push`.

## What the push gate does

The gate runs in Claude Code and Codex, through the hooks above. It never approves a push for you: your agent's own permission prompt for `git push` still applies.

Without `review.block_on_severity` in `.openqodex.yaml`, the gate never stops a push:

- When a finished review of the current change has findings, it adds the finding counts and the report path. A clean review adds nothing.
- When none exists, it adds a note that the change was not reviewed and how to review it.

With `review.block_on_severity` set, the gate denies the push unless a finished review of the current change passed. The reason names the next step.

`OPENQODEX_SKIP=1` in the environment lets the push through and says so. It is your switch, not your agent's.

The hook never breaks a push by accident. When `hook check` itself fails, it prints the reason on stderr and lets the agent go on.

## A git hook for every tool

For pushes from any tool, add a git pre-push hook to one repository:

```
npx openqodex hook install
```

It runs `openqodex scan` before each push, through the launcher. It stops the push only when `.openqodex.yaml` sets `review.block_on_severity` and the scan meets it. A scan that fails for its own reasons never stops the push. `init` never installs it. `cli` has the details.

## Other ways to install

- The skill alone: `npx skills add openqodex/openqodex`. This writes the skill but no hook.
- Claude Code plugin: the repository holds a plugin marketplace with an `openqodex` plugin. The plugin carries the skill and the push gate hook. Its hook calls `npx -y openqodex@<version>`.

## Inside a sandbox

Some agents run commands in a sandbox that cannot reach the network or write outside the project. There, the first review cannot download scanners. Each scanner reports why it was left out, and the review runs with what is available. Run this once in your own terminal to fix it:

```
npx openqodex doctor --install
```

The review writes its files inside the repository, in `.openqodex/`. So it works in a sandbox that can write only the project.

## Uninstall

```
npx openqodex init --uninstall
```

Add `--project` to remove project files. `init` records what it wrote in `~/.openqodex/install.json`. `--uninstall` removes only what that record holds:

- A skill or rule file is removed only when it is unchanged since `init` wrote it.
- The hook entry is removed from the settings file. Other settings stay. When `init` saved a backup and nothing else changed, the backup is put back.
- The `.git/info/exclude` lines are removed.
- The launcher and the runtime copies are removed when no hook still calls them. The git pre-push hook counts as one.

Scanners stay in `~/.openqodex/tools/`. Delete that folder to remove them too.
