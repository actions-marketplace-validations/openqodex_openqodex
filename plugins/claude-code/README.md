# OpenQodex for Claude Code

OpenQodex is open source AI code review that runs before you push. One command runs the scanners that fit your change on the lines you changed, then starts a separate reviewer: a fresh Claude Code or Codex process that checks every scanner finding and is given every changed line. Scripts check the reviewer's answer and print one report.

## What the plugin installs

- The `openqodex` skill. It tells Claude to run one command, `openqodex review`, wait for it, and show you the report exactly as printed. Claude does not review the change itself.
- A push hook. Before Claude runs `git push`, the hook runs `openqodex hook check` through npx, pinned to the plugin's version. It looks for a review of exactly what is pushed; it does not scan or review by itself. By default it never stops a push: it adds a line saying whether the change was reviewed. When `.openqodex.yaml` sets `review.block_on_severity`, it denies the push unless a finished review of the current change passed.

## How to use it

Say to Claude:

```
review my change with openqodex
```

The change is the commits not yet pushed plus everything uncommitted. To review the whole repository instead, say "review the whole repo with openqodex". A review takes one to three minutes.

## What it needs

Claude Code or Codex, installed and logged in: the reviewer runs on that login, on your own plan. No other key and no account. OpenQodex needs Node 22 or newer and git, on macOS or Linux. On Windows, use WSL.

## Where the report goes

Each run writes a folder under `.openqodex/reviews/` in your repository, with `report.md`, `report.json` and `report.sarif`. The report says which reviewer ran.

## What it runs and sends

The hook and the skill run the `openqodex` package from npm, pinned to one version. The reviewer process sends the brief and what it reads to the model your Claude Code or Codex login uses. By default the reviewer can also search the web; `reviewer_web: off` in `~/.openqodex/config.yaml` removes that. The built-in scanners download on first use into `~/.openqodex/tools/`, each pinned to one version. semgrep fetches its rule packs from the Semgrep registry on each run. When the change holds a lockfile, osv-scanner sends dependency names and versions to osv.dev. OpenQodex and the built-in scanners send no code anywhere, and OpenQodex collects no telemetry. A custom scanner named in `.openqodex.yaml` never runs until you approve it with `openqodex trust`, and then does whatever its own command does. The privacy page lists every network use.

## Learn more

- Docs: https://github.com/openqodex/openqodex/tree/main/docs
- Security: https://github.com/openqodex/openqodex/blob/main/docs/security.md
- Privacy: https://github.com/openqodex/openqodex/blob/main/docs/privacy.md

Licensed under Apache 2.0.
