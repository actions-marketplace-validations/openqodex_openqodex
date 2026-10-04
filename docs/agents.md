# Agents

OpenQodex runs from Claude Code, Cursor, Codex CLI and Cline. `openqodex init` installs it into each one it finds. Whichever agent asks for the review, the review itself runs in a reviewer process OpenQodex starts: Claude Code or Codex, on your own login, with no other key. Cursor is not used as a reviewer (`security` says why); in Cursor and Cline the review works when Claude Code or Codex is installed too. Without either, `review` names the command with which the agent you are in reviews the change itself (see "Who reviews, by what is installed").

## Run init

Run it in your own terminal, not inside the agent:

```
npx openqodex init
```

`init` prints every file it will write and asks once. `--agent <name>` picks agents by hand: `claude-code`, `cursor`, `codex`, `cline` or `all`. `--dry-run` prints the plan and writes nothing.

Inside a repository, `init` also asks: "Add the git pre-push hook, so every push from this repo is checked for a review, from an agent or by hand?" The default is yes. `--hook pre-push` or `--hook none` answers without asking, and `--yes` answers yes. The answer is recorded for that repository, so a second `init` does not ask again. The hook is described under "A git hook for every tool" below.

## The instruction section

`init` adds a short marked section to each agent's instruction file. It prints the section before writing it:

```
<!-- openqodex:start -->
## Review with OpenQodex
- When a feature or fix is done, and before any push, review it with the openqodex skill: "review my change with openqodex".
- OpenQodex starts its own reviewer process for the review: the agent that wrote the code does not judge its own work.
- Do not push on a blocked verdict unless the developer says so after seeing the findings.
- The report is in `.openqodex/reviews/`.
<!-- openqodex:end -->
```

The tables below name the file for each agent. Cursor has no instruction file in the home folder, so its rule in the repository carries the same section. In an existing file, the section is appended and your own text stays as it is. `--uninstall` removes exactly that section, and nothing around it.

## The team section in the repository

Inside a repository, `init` in user scope also asks: "Add a review section to this repo's CLAUDE.md and AGENTS.md, so teammates' agents review before they push too?" The default is yes, and `--yes` answers yes. `--no-repo` answers no. The answer is recorded for that repository and asked no more; `--yes` or `--no-repo` on a later `init` replaces it.

The section goes into `CLAUDE.md` and `AGENTS.md` at the root of the repository, and `init` creates a file that is not there. It is meant for a teammate who has installed nothing, so it names only the pinned `npx` command:

```
<!-- openqodex:start -->
## Review with OpenQodex before you push
- Before any `git push`, run `npx -y openqodex@<version> review` from the repository root. It takes one to three minutes: allow it up to ten minutes, or run it in the background and wait for it to exit.
- Show the developer the report it prints, exactly as printed. OpenQodex starts its own reviewer process: the agent that wrote the code does not judge its own work.
- Do not push on a blocked verdict unless the developer says so after seeing the findings.
- The report is in `.openqodex/reviews/`.
<!-- openqodex:end -->
```

The two files show in `git status`, and `init` says to commit them. `init` writes neither file through a symbolic link. A section you edited is yours: a later `init` and `--uninstall` leave it as it is. `--uninstall` removes our untouched section, and deletes a file only when `init` created it and nothing else is in it. In project scope the same two files carry the instruction section instead, never both.

## The review runs in its own reviewer process

The skill tells the agent to run one command, `review`, wait for it, and show you the report exactly as printed. The agent does not review the change itself and starts no subagent. `review` starts a fresh reviewer process with no memory of the agent's session, inside a frozen copy of the change. Claude Code starts with none of your settings or instruction files and read, search and list tools only. Codex starts in a read-only sandbox with none of your config or the repository's instruction files; it still loads your global `~/.codex/AGENTS.md`. The report says which reviewer ran; the tool writes that line, never the model.

A review takes one to three minutes. Agents often stop a command after two minutes, so the skill tells the agent to allow up to ten minutes or run it in the background; `review` prints a line every 15 seconds while the reviewer works.

The reviewer edits nothing and runs none of the repository's code. Claude Code has no shell. Codex has a shell whose commands can read the copy of the change and the system folders, and cannot write or reach the network.

## Who reviews, by what is installed

| Installed | What `review` gives you |
|---|---|
| Claude Code, logged in | A fresh Claude Code process that OpenQodex starts reviews the change. |
| Codex, logged in, and no Claude Code (or Claude Code logged out) | A fresh Codex process that OpenQodex starts reviews the change. |
| Both, logged in | The agent you run `review` from reviews: Codex from Codex, Claude Code from Claude Code. From anywhere else, Claude Code. `--reviewer codex` or `reviewer: codex` in `~/.openqodex/config.yaml` picks Codex. |
| Only Cursor (or both logged out), or Codex inside Codex's own sandbox | "Full review unavailable", exit 2, and a fallback: run `review --agent` and the agent you are in follows the brief it prints, then `review --finalize`. That report says on its first line after the verdict "Reviewed by the coding agent you are using." |
| None of them | "Full review unavailable", exit 2, and the scanner findings saved to a file as unchecked candidates, never as a review. The fallback line prints too, but no agent is there to follow it. |

The skill tells the agent to follow the fallback when `review` prints it. The push hooks count a fallback review as reviewed, with one line naming who reviewed.

## The repo folder

Inside a repository, `init` creates two files in `.openqodex/`, and so does the first `review` or `scan` there:

- `.openqodex/config.yaml`: the config, every key at its default with a comment. `config` lists every key. It is not created while a `.openqodex.yaml` sits at the root of the repository; that file is still read, and `init` says how to move it.
- `.openqodex/custom-instructions.md`: what a reviewer of this repository must know: conventions, what never to flag, what always to check. The review brief carries its text word for word. A file over 32 KB stops the review with a message; nothing in it is cut. The brief shows it to the reviewer as quoted text from the repository, because anyone who can commit can change it. It can widen or narrow what the reviewer flags, and a candidate dropped because of it says so in the report; it cannot give the reviewer a tool, skip a check or change the finding shape.

Both are meant to be committed, so the whole team shares them. A file that exists is never touched. `.openqodex/.gitignore` keeps the review reports out of git, so after the first run `git status` shows only these files and the `.gitignore`.

## User scope and project scope

The default is user scope. `init` writes into your home folder, so one install works in every repository. A rule file it must put inside a repository is added to `.git/info/exclude`, so it does not show in `git status`. The two repo folder files and the team section above are the exception: they are meant to be committed.

`--project` writes the files into the repository instead, for a team to commit. Run it inside a git repository.

## The launcher

In user scope, the push gate hooks, the skill and the Cursor and Cline rules call a launcher, not npx. Every user-scope install gets it, with or without a hook. `init` copies the package to `~/.openqodex/runtime/<version>/` and checks the copy runs. It writes the version to the first line of `~/.openqodex/runtime/current`, then writes `~/.openqodex/bin/openqodex`, a small script that runs the copy that line names with your Node. When the line is missing, is not a version, or names a copy that is gone, the script runs the version `init` installed. The hooks and the skill's commands call that script by its full path, so they do not depend on npx or your `PATH`. A copy is never changed once written: when a folder of the same version with other contents is in the way, `init` stops and names it.

The user-scope skill is a short stub: when to run, who reviews (the reviewer process OpenQodex starts), and one command, `<launcher> guide skill`, which prints the full procedure of the version the launcher runs, with every command written for the launcher. No file `init` writes in user scope names a version or holds the procedure, so an update changes none of them. In user scope the Cursor and Cline rules call the launcher too, and say to run `<launcher> guide skill` when the skill is not loaded.

In project scope, the hooks, the skill and the rules call `npx -y openqodex@<version>` and the skill holds the full procedure, because the launcher path would not exist on a teammate's machine. These files, and the review section `init` adds to a repository's `CLAUDE.md` and `AGENTS.md`, stay on the version they name: an update never changes them. Run `init` again to move them.

## Claude Code

| What | User scope | Project scope |
|---|---|---|
| Skill | `~/.claude/skills/openqodex/SKILL.md` | `.claude/skills/openqodex/SKILL.md` |
| Push gate hook | merged into `~/.claude/settings.json` | merged into `.claude/settings.json` |
| Instructions | a marked section in `~/.claude/CLAUDE.md` | a marked section in `CLAUDE.md` |
| Permission rules | merged into `permissions.allow` of `~/.claude/settings.json` | none |

The hook is one `PreToolUse` entry. It matches the `Bash` tool and runs only for `git push` commands. It calls `openqodex hook check`.

In user scope, `init` adds rules so Claude Code runs these review commands without asking, and the agent can review unattended: `<launcher> review` and `review --all`, each also with ` --offline` at the end, plus `guide`, `guide skill` and `guide <topic>`. Each rule matches one exact line, so the same command with any other flag, such as `--output` or `--config`, a branch or a pull request, or chained with `&&`, still asks you. `scan`, `doctor`, `trust`, `update`, `init` and `report` still ask you. The rules of earlier versions for `review --agent` and `review --finalize` are removed by the next `init`. Project scope writes no permission rule: a committed settings file would decide for every teammate. A rule you already had is left alone, and `init --uninstall` removes only the rules `init` added. When a later version grants a different set, the next `init` removes the rules an earlier version added and adds the new ones. When your home path holds a space or another character the shell would read, the launcher is written in single quotes in the skill and in the rules alike. When the launcher's path holds `*`, which Claude Code reads as a wildcard, `init` writes no rule and says so in one line; Claude Code then asks before each review command.

A skill, rule or permission rule an earlier `init` wrote, such as the full-text skill of 0.2.1, is replaced by the next `init` only while it is still exactly as written. One you edited is left as it is, and `init` says so.

Neither the skill `init` writes nor `guide skill` carries the sentence that tells an agent to prefer `~/.openqodex/bin/openqodex`: in user scope the launcher already runs every command, and in project scope the skill keeps the version the team committed.

## Codex CLI

| What | User scope | Project scope |
|---|---|---|
| Skill | `~/.agents/skills/openqodex/SKILL.md` | `.agents/skills/openqodex/SKILL.md` |
| Instructions | a marked section in `$CODEX_HOME/AGENTS.md` (`~/.codex/AGENTS.md` by default) | a marked section in `AGENTS.md` |
| Push gate hook | merged into `~/.codex/hooks.json` | merged into `.codex/hooks.json` |

Codex runs the hook before every shell command. `hook check` returns at once and prints nothing when the command is not a `git push`.

Codex runs a new hook only after you trust it. Open Codex, run `/hooks`, and trust the OpenQodex hook. Until then, Codex skips the push gate. A project hook also needs the project itself to be trusted in Codex.

## Cursor

| What | User scope | Project scope |
|---|---|---|
| Skill | `~/.cursor/skills/openqodex/SKILL.md` | `.agents/skills/openqodex/SKILL.md` |
| Rule | `.cursor/rules/openqodex.mdc` in the repository, excluded from git | `.cursor/rules/openqodex.mdc` |

Cursor has no rule file in the home folder, so the rule always goes in the repository. In user scope, run `init` inside each repository where you want the rule. The rule applies to every chat, carries the instruction section, and tells Cursor to run `review` before any `git push`. The review itself needs Claude Code or Codex installed: `cursor-agent` cannot be held to reading only, so it is not a reviewer.

OpenQodex writes no Cursor hook. The rule asks Cursor to review, but nothing stops a push from Cursor.

## Cline

| What | User scope | Project scope |
|---|---|---|
| Skill | `~/.cline/skills/openqodex/SKILL.md` | `.cline/skills/openqodex/SKILL.md` |
| Rule | `~/Documents/Cline/Rules/openqodex.md` | `.clinerules/openqodex.md` |

OpenQodex writes no Cline hook. The rule carries the instruction section and asks Cline to review before any `git push`.

## What the push gate does

The gate runs in Claude Code and Codex, through the hooks above, and in the git pre-push hook below. It looks for the record `review` wrote for exactly the change being pushed, in your own `~/.openqodex/receipts/`. Report files a branch carries under `.openqodex/` never count. It never scans, never starts a review, and never approves a push for you: your agent's own permission prompt for `git push` still applies.

- A complete review of this change that passed: the gate says nothing.
- A complete review of this change that is blocked: the gate denies the push when `review.block_on_severity` is set, with the counts and the report path.
- No review of this change: one line asking you to run `openqodex review`. With `review.block_on_severity` set, the gate denies the push, so an agent runs the review and tries again.
- An incomplete review of this change: one line saying so. It never blocks.
- A review from the older two-step protocol (`review --agent`, then `--finalize`): it counts as reviewed, with one line naming who reviewed.

`OPENQODEX_SKIP=1` in the environment lets the push through and says so. It is your switch, not your agent's.

The hook never breaks a push by accident. When `hook check` itself fails, it prints the reason on stderr and lets the agent go on.

## A git hook for every tool

The git pre-push hook covers pushes from any tool, by an agent or by hand. `init` asks to add it; to add it to a repository later:

```
npx openqodex hook install
```

Before each push it runs `openqodex hook pre-push` through the launcher. For each branch the push sends, it measures the change from the commit the remote already holds for that branch, or, for a new branch, from the merge base with the default branch (`review.default_base`, else the remote's default branch), to the pushed commit. It then looks for the review recorded in your home for exactly that change. When there is none, it also accepts the newest complete review whose range contains the push: its base is the push's base or an ancestor of it, the push's base is an ancestor of the pushed commit (so not a force push over work the review never saw), and the change from its base to the pushed commit is exactly the change it reviewed. So a branch reviewed with no upstream set, which a review measures from the default branch, still counts when it is pushed over its remote tip, while a push of another branch, or of work changed after the review, counts as not reviewed. When a branch the remote has is not reviewed and has no upstream here, the line says to set the upstream (`git branch --set-upstream-to <remote>/<branch>`), run `openqodex review`, then push. It prints the gate's line on stderr and nothing from the scanners. It stops the push only when the config sets `review.block_on_severity` and the review is missing or blocked. A lookup that fails for its own reasons never stops the push.

## Other ways to install

- The skill alone: `npx skills add openqodex/openqodex`. This writes the skill but no hook.
- Claude Code plugin: the repository holds a plugin marketplace with an `openqodex` plugin. The plugin carries the skill and the push gate hook. Its hook calls `npx -y openqodex@<version>`.

## Inside a sandbox

Some agents run commands in a sandbox that cannot reach the network or write outside the project. There, the first review cannot download scanners, and the reviewer may not reach its model or write in `~/.openqodex/`. Inside Codex's sandbox a second Codex does not start at all: with Codex as the reviewer, `review` prints "Full review unavailable" and the fallback. Each scanner reports why it was left out. Run this once in your own terminal for the scanners, and run `review` there when the reviewer cannot start inside the sandbox:

```
npx openqodex doctor --install
```

The review writes its reports inside the repository, in `.openqodex/`, and its temporary copy of the change in `~/.openqodex/checkouts/`.

## Uninstall

```
npx openqodex init --uninstall
```

Add `--project` to remove project files. `init` records what it wrote in `~/.openqodex/install.json`. `--uninstall` removes only what that record holds:

- A skill or rule file is removed only when it is unchanged since `init` wrote it.
- The instruction section is removed from each file; your own text in that file stays.
- In the repository you run it in: the git pre-push hook, when it is still the one OpenQodex wrote, and the `.openqodex/config.yaml` and `.openqodex/custom-instructions.md` that `init` created, when they are unchanged and not committed.
- The hook entry is removed from the settings file. Other settings stay. When `init` saved a backup and nothing else changed, the backup is put back.
- The `.git/info/exclude` lines are removed.
- The launcher and the runtime copies are removed when no hook still calls them. The git pre-push hook counts as one.

Scanners stay in `~/.openqodex/tools/`. Delete that folder to remove them too.
