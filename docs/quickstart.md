# Quickstart

## Paste this prompt into your agent

```
Install the OpenQodex skill with `npx skills add openqodex/openqodex`.
Then review my current change with openqodex and tell me the verdict and the findings.
```

The agent installs the skill, runs the review and tells you the result. The steps below do the same by hand.

## Before you start

- Node 22 or newer, and git.
- Claude Code or Codex, installed and logged in. It is the reviewer OpenQodex starts. Without either, `review` runs the scanners, says "Full review unavailable", and names the command with which the agent you are in reviews the change itself.
- macOS or Linux. On Windows, use WSL.
- A git repository with a change in it.

## 1. Install into your agent

Run this in your own terminal, not inside the agent:

```
npx openqodex init
```

`init` finds Claude Code, Cursor, Codex CLI and Cline on your machine. It prints each file it will write, for you and for the team, then asks once: "Write these files?". `--yes` skips the question. `agents` lists every file for each agent.

Inside a repository, `init` also:

- adds the git pre-push hook, so every push from that repository is checked for a review, from an agent or by hand. `--hook none` leaves it out.
- adds one line to each agent's global instruction file, such as `~/.claude/CLAUDE.md` for Claude Code: before any push, review the change with the openqodex skill. It prints the line before writing it.
- adds a review section to the repository's `CLAUDE.md` and `AGENTS.md`, so a teammate's agent reviews before it pushes too. `--no-repo` leaves it out.
- creates `.openqodex/config.yaml` and `.openqodex/custom-instructions.md`. Commit both. Write in `custom-instructions.md` what a reviewer of your repository must know: conventions, what never to flag, what always to check. The review brief carries it word for word.

After writing, `init` lists what it wrote for you, with the command that undoes it (`init --uninstall` through the launcher), and what it wrote for the team, to commit. `init --project` instead keeps everything inside the repository, for the team to commit.

`init` also starts the scanner downloads that your repo needs, in the background. Running it outside the agent matters: some agents run commands in a sandbox that cannot download.

Last, `init` reviews: when the repository has a change, it runs `openqodex review` and prints the report. When it has none, it asks what to review: the whole repository, a pull request, a branch, or not now. With `--yes` or without a terminal it prints the three commands instead of asking. `--no-review` skips this step. The review uses the scanners already installed and never fails `init`.

Codex only: open Codex, run `/hooks` and trust the OpenQodex hook. Codex runs a new hook only after you trust it.

## 2. Ask for a review

Say to your agent:

```
review my change with openqodex
```

The agent runs `openqodex review` and shows you the report it prints. That one command works out the change, copies it to a temporary folder, runs the scanners and the code graph, and starts its own reviewer: a separate Claude Code or Codex process that reads that copy. The reviewer checks every scanner finding and is given every changed line; a script checks its answer, and OpenQodex prints the report. It takes one to three minutes and uses your Claude Code or Codex plan. You can run the same command in your terminal.

To review the whole repository instead of one change, say:

```
review my whole repo with openqodex
```

The agent runs `openqodex review --all`. The scanners check every file, and the brief tells the reviewer where to start: the most-called functions and the files with the most scanner hits. See `docs/cli.md` for the details.

To review a teammate's branch or a pull request before it merges, without leaving your own work, say:

```
review the branch feature/login with openqodex
review pull request #42 with openqodex
```

The agent runs `openqodex review feature/login` or `openqodex review '#42'`. OpenQodex fetches the branch or the pull request, checks it out in a temporary folder and reviews what it added since it left its base. Your working folder is not touched. See "Reviewing a branch or a pull request" in `docs/cli.md`.

## 3. Read the report

The agent shows you the report as OpenQodex printed it: the verdict, the counts, and for each finding where it is, the problem, why it matters and the fix. A complete review means every stage ran, every scanner finding was checked and every changed line was put in front of the reviewer; anything not covered is named. It does not mean nothing was missed. The same report is in `.openqodex/reviews/<time>-<id>/report.md` in your repo. `.openqodex/.gitignore` keeps the reports out of git; `git status` shows only the two files above and that `.gitignore`, the first time.

The verdict is `passed` unless `.openqodex/config.yaml` sets `review.block_on_severity` and a finding meets it. With no config, OpenQodex warns and never blocks.

## Try it on the demo repo

```
npx openqodex demo /tmp/openqodex-demo
```

`demo` builds a small repo with planted bugs: a secret, a SQL injection, a bad Dockerfile, a vulnerable lockfile, a shell bug and a workflow injection. It scans the change and prints the scanner report. Then run `openqodex review` in that folder, or open it in your agent and ask for a review.

## Without an agent

Run the review yourself:

```
npx openqodex review
```

`openqodex scan` runs the scanners only and prints their findings unchecked. It is the check the pre-commit hook runs, and the GitHub Action without an Anthropic API key; it is not a review.

## First run

Scanners download on first use into `~/.openqodex/tools/`. Only the scanners your change needs download. A scanner still installing after 45 seconds keeps going in the background. The report lists it as installing. It joins the next run.

One measured first run: an Apple Silicon Mac, an empty tool folder, a line of 2 MB per second. The first `demo` printed its report in under a minute. That report held the scanners that had finished installing and listed the rest as installing. The next `scan` included all eight scanners the demo needs. They take about 700 MB of disk.

To download every scanner now:

```
npx openqodex doctor --install
```

## Next

- `config`: block pushes at a severity, exclude paths, switch scanners off.
- `custom-scanners`: add any scanner by its GitHub link.
- `security`: what runs and what is sent where.
