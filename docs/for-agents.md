# OpenQodex for AI agents

This page is for an AI coding agent that installs or configures OpenQodex for a developer. A person reads the README instead.

This page describes `openqodex@0.12.0`. The same page ships in the package. After the install, `~/.openqodex/bin/openqodex guide for-agents` prints the copy for the installed version.

The review procedure is not on this page. It is in the openqodex skill, which `init` installs. Run `guide skill` to read it (see "Review a change").

## Words

- Change: the commits not yet pushed plus everything uncommitted, untracked files included.
- Changed lines: the lines the change adds or edits.
- Scanner: a program that checks code without a model, such as gitleaks or semgrep.
- Built-in scanner: one of the 22 built-in scanners that ship with OpenQodex.
- Custom scanner: a scanner that the repository's config adds by its GitHub link.
- Approve: what `openqodex trust` does for a custom scanner. A custom scanner never runs before the developer approves it.
- Finding: one problem at one place in the code, with a severity.
- Reviewer: the separate Claude Code or Codex process that `review` starts. It reads a frozen copy of the change.
- Receipt: what `review` prints at the end: the verdict, one line per finding and the path of `report.html`.
- Verdict: `passed` or `blocked`.
- Push gate: the Claude Code or Codex hook that looks for a review before `git push`.
- Launcher: `~/.openqodex/bin/openqodex`, the script that `init` writes. The hooks and the skill run OpenQodex through it.
- SARIF: a standard JSON format for scanner results.
- MCP server: a local tool server that an agent starts. OpenQodex's server answers questions about the code graph.

## Before you install

Run these commands from the developer's repository.

| Check | Command | What you need |
|---|---|---|
| Node | `node --version` | 22 or newer |
| git | `git --version` | any version |
| A reviewer | `claude --version`, `codex --version` | Claude Code or Codex, logged in |

Without Claude Code or Codex, OpenQodex still installs. A review then prints "Full review unavailable". Tell the developer before you install.

OpenQodex runs on macOS and Linux. On Windows, it needs WSL, and no test runs there.

## Install

1. Run this command from the repository. Put the agent you are in place of `<host>`: `claude-code`, `codex`, `cursor` or `cline`.

   ```
   npx -y openqodex@0.12.0 init --yes --agent <host>
   ```

2. Run it in the background. Wait until it exits. It downloads scanners and then reviews the change, which can take several minutes.
3. Find the line that starts with `First review:`. It says `finished`, `incomplete`, `skipped` or `unavailable`.
4. Show the developer the receipt above that line, as printed.

Do not use `npx skills add openqodex/openqodex` for the install. It installs the skill alone, with no push gate and no launcher.

In Codex, the sandbox has no network by default. Ask the developer to run the install line in their own terminal.

After the install:

- Codex: the developer opens Codex, runs `/hooks`, and trusts the OpenQodex hook. Until then, Codex skips the push gate.
- Every agent: the agent reads its MCP servers when it starts. Ask the developer to restart the agent, so it gets the code graph tools.
- Cursor: the rule goes into each repository. Run `init` again in each repository that needs it.
- Cline with the VS Code extension: `init` prints an MCP server entry. The developer adds it in Cline's "Configure MCP Servers".

## What init wrote

`init` writes into the developer's home folder by default (user scope). With `--project`, it writes the agent files into the repository instead, for the team to commit.

| Agent | Skill | Instructions | Push gate |
|---|---|---|---|
| Claude Code | `~/.claude/skills/openqodex/SKILL.md` | a section in `~/.claude/CLAUDE.md` | a hook in `~/.claude/settings.json` |
| Codex CLI | `~/.agents/skills/openqodex/SKILL.md` | a section in `~/.codex/AGENTS.md` | a hook in `~/.codex/hooks.json` |
| Cursor | `~/.cursor/skills/openqodex/SKILL.md` | the rule `.cursor/rules/openqodex.mdc` in the repository | none |
| Cline | `~/.cline/skills/openqodex/SKILL.md` | the rule `~/Documents/Cline/Rules/openqodex.md` | none |

In the repository, `init` also writes these files:

- `.openqodex/config.yaml`: the repository's config. The team commits it.
- `.openqodex/custom-instructions.md`: what a reviewer of this repository must know. The team commits it.
- A review section in `CLAUDE.md` and `AGENTS.md`, for teammates who installed nothing. `--no-repo` leaves it out.
- The git pre-push hook. `--hook none` leaves it out.

The [agents page](agents.md) lists every file for both scopes, with the MCP server files.

## Review a change

The skill holds the procedure. Run this from the repository, then follow what it prints from step 1:

```
~/.openqodex/bin/openqodex guide skill
```

In project scope, the launcher may not exist on this machine. Then run `npx -y openqodex@0.12.0 guide skill`.

A review can take minutes. The reviewer stops after 30 minutes for a change, and after 2 hours with `--all`. Many agents stop a command sooner. So run the review in the background and wait until it exits.

## Add a scanner from GitHub

The developer can ask you to add a scanner by its GitHub link. You write the config entry. The developer approves it.

1. Read the scanner's README. Find the flag that makes it write SARIF.
2. If it cannot write SARIF, find the flag that makes it write one JSON document. JSON Lines and plain text cannot be read.
3. Find how it installs. OpenQodex can use a GitHub release file for macOS or Linux. It can also use an exact npm or PyPI version, or a program on `PATH`.
4. Add the entry under `scanners.custom` in `.openqodex/config.yaml`.
5. Ask the developer to approve it with `~/.openqodex/bin/openqodex trust`. The skill's rule: never run `openqodex trust` without asking the developer first.
6. After the approval, run `~/.openqodex/bin/openqodex scan --only custom:<name>`. Tell the developer its status and its findings.

An entry with SARIF output:

```yaml
scanners:
  custom:
    - source: https://github.com/Bearer/bearer
      run: bearer scan {target} --format sarif --output {report} --quiet --disable-version-check
      target: repo
```

The keys:

| Key | What it is |
|---|---|
| `source` | the scanner's GitHub link, `https://github.com/<owner>/<repo>` |
| `run` | the command line. OpenQodex splits it into words and starts no shell |
| `name` | the scanner's name in the report. Default: the last part of `source` |
| `version` | a release tag. Default: the latest release |
| `format` | `sarif` (the default) or `json-map` |
| `map` | for `json-map`: dotted paths to the list of results and to each result's file, line, rule, severity and message |
| `paths` | globs of the files that make it run. Default: every changed file |
| `target` | `changed` (the default) passes the changed files; `repo` passes the repository root |
| `timeout_seconds` | default 120 |
| `install` | an asset name pattern, `path`, `{ npm: <package@1.2.3> }` or `{ uv: <package==1.2.3> }` |

`{report}` in `run` is the file the scanner writes its report to. With no `{report}`, OpenQodex reads the report from the scanner's standard output. `{target}` is the changed files, or the repository root with `target: repo`. `{repo}` is the repository root.

Tell the developer when a scanner is not compatible, and why. The GitHub Action runs a custom scanner only on a runner that holds an approval. A GitHub-hosted runner never does.

`~/.openqodex/bin/openqodex guide custom-scanners` gives the asset rules, the `json-map` example and what the stored hash proves.

## Configure the repository

The config belongs to the team. Change it only when the developer asks.

| Key in `.openqodex/config.yaml` | What it does |
|---|---|
| `review.block_on_severity` | blocks a push at or above this severity. Default: never block |
| `review.paths.exclude` | globs of files left out of the change |
| `review.disabled_rules` | scanner rules to drop, such as `ruff:F401` |
| `scanners.disable` | built-in scanners to switch off, by name |
| `scanners.custom` | custom scanners (see above) |

Write what a reviewer of this repository must know in `.openqodex/custom-instructions.md`. The review brief quotes it word for word.

`~/.openqodex/bin/openqodex guide config` lists every key.

## Messages and what to do

| OpenQodex prints | What you do |
|---|---|
| `Full review unavailable` | Tell the developer what it says is missing. If it names a fallback command, follow it. |
| `Review incomplete` | Tell the developer what it says is missing. Never present the scanner findings as a review. |
| a scanner `installing` | Tell the developer. The scanner joins the next run. |
| a scanner `not installed` or `needs Ruby`, `needs Go`, `needs Cargo` | Tell the developer the reason. OpenQodex does not install language runtimes. |
| a scanner `untrusted` | A custom scanner is not approved. The developer decides. |
| a scanner `disabled` | The config or `--offline` switched it off. |
| files from an older version, and an `init` command | Tell the developer in one line. Give them the command. Run it only if they ask. |
| `OpenQodex had a problem. Nothing has been sent.` | Follow the skill's rule for this message. Never choose to send the report yourself. |

In a sandbox that cannot download, the scanners cannot install. Ask the developer to run `npx -y openqodex@0.12.0 doctor --install` in their own terminal, inside the repository.

## What leaves the machine

- The reviewer sends the brief and the files it reads to the model of the developer's own login.
- By default, the reviewer can also search the web. `reviewer_web: off` in `~/.openqodex/config.yaml` turns that off.
- Four of the built-in scanners use the network, and none sends code. semgrep downloads its rule packs. osv-scanner sends dependency names and versions to osv.dev. kubeconform downloads Kubernetes schemas. cargo-deny downloads the RustSec advisory database.
- `--offline` skips semgrep, osv-scanner, kubeconform and cargo-deny, and turns scanner downloads off.
- A custom scanner does whatever its own command does.

The [privacy page](privacy.md) lists every network use.

## Remove OpenQodex

```
~/.openqodex/bin/openqodex init --uninstall
```

It removes what `init` wrote. It keeps every file and section that the developer edited. The scanners stay in `~/.openqodex/tools/`.

## Read more offline

`~/.openqodex/bin/openqodex guide <topic>` prints one page of the docs. The topics are the file names in `docs/`, such as `quickstart`, `cli`, `config`, `scanners`, `custom-scanners`, `agents`, `security` and `privacy`.
