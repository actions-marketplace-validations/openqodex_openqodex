# Quickstart

## Paste this prompt into your agent

```
Install the OpenQodex skill with `npx skills add openqodex/openqodex`.
Then review my current change with openqodex and tell me the verdict and the findings.
```

The agent installs the skill, runs the review and tells you the result. The steps below do the same by hand.

## Before you start

- Node 22 or newer, and git.
- macOS or Linux. On Windows, use WSL.
- A git repository with a change in it.

## 1. Install into your agent

Run this in your own terminal, not inside the agent:

```
npx openqodex init
```

`init` finds Claude Code, Cursor, Codex CLI and Cline on your machine. It prints each file it will write, then asks once. `--yes` skips the question. `agents` lists every file for each agent.

`init` also starts the scanner downloads that your repo needs, in the background. Running it outside the agent matters: some agents run commands in a sandbox that cannot download.

Codex only: open Codex, run `/hooks` and trust the OpenQodex hook. Codex runs a new hook only after you trust it.

## 2. Ask for a review

Say to your agent:

```
review my change with openqodex
```

The agent runs `openqodex review --agent`. That command works out the change, runs the scanners and prints a brief. The agent verifies each scanner finding, reviews the change itself, and writes its findings to a file. Then it runs `openqodex review --finalize`, which checks those findings without a model and writes the report.

## 3. Read the report

The agent tells you the verdict and the most serious findings. The full report is in `.openqodex/reviews/<time>-<id>/report.md` in your repo. `.openqodex/` ignores itself in git, so `git status` does not change.

The verdict is `passed` unless `.openqodex.yaml` sets `review.block_on_severity` and a finding meets it. With no config, OpenQodex warns and never blocks.

## Try it on the demo repo

```
npx openqodex demo /tmp/openqodex-demo
```

`demo` builds a small repo with planted bugs: a secret, a SQL injection, a bad Dockerfile, a vulnerable lockfile, a shell bug and a workflow injection. It scans the change and prints the report. Then open the folder in your agent and ask for a review.

## Without an agent

`openqodex scan` runs the scanners on the change and prints the report:

```
npx openqodex scan
```

It is the same check the git hook, the pre-commit hook and the GitHub Action run.

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
