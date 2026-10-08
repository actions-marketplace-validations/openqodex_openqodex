<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/openqodex/openqodex/main/.github/assets/readme-banner-dark.png">
  <img alt="OpenQodex" src="https://raw.githubusercontent.com/openqodex/openqodex/main/.github/assets/readme-banner-light.png" width="1280">
</picture>

# OpenQodex

[![npm version](https://img.shields.io/npm/v/openqodex)](https://www.npmjs.com/package/openqodex)
[![licence](https://img.shields.io/badge/licence-Apache--2.0-blue)](LICENSE)
[![CI](https://github.com/openqodex/openqodex/actions/workflows/ci.yml/badge.svg)](https://github.com/openqodex/openqodex/actions/workflows/ci.yml)

OpenQodex is open source AI code review for Claude Code and Codex. It runs before you push, from your coding agent or your terminal. One command, `openqodex review`, works out your change: the commits not yet pushed plus everything uncommitted. It runs the scanners that fit the changed files and keeps only findings on the lines you changed. Then it starts its own reviewer, a separate Claude Code or Codex process that reads a frozen copy of the change. The reviewer checks every scanner finding and is given every changed line. OpenQodex checks its answer with scripts and prints one report. It needs Claude Code or Codex installed and logged in, and no other key, account or server.

## Install

For humans, in your terminal:

```
npx openqodex init
```

`init` finds Claude Code, Cursor, Codex CLI and Cline on your machine. It prints every file it will write and asks once. Then it names the reviewer it found, or what to fix, and reviews your change, or asks what to review when there is none. After that, say to your agent "review my change with openqodex", or run `~/.openqodex/bin/openqodex review` yourself: `init` prints that full path, since an npx install puts no `openqodex` on your `PATH`.

For agents, the same install, run by the agent for itself with no question:

```
npx -y openqodex@0.8.1 init --yes --agent <host>
```

`<host>` is `claude-code`, `codex`, `cursor` or `cline`. Or paste this prompt into your agent:

```
Install OpenQodex for yourself with `npx -y openqodex@0.8.1 init --yes --agent <host>`, where <host> is the agent you are: claude-code, codex, cursor or cline. Run it from this repository and allow it up to ten minutes: when a reviewer can start, it ends with a review of my current change.
Then tell me the verdict and the findings, or what its last lines say is missing.
```

Codex runs commands in a sandbox that cannot write outside the project or download: from Codex, run the line in your own terminal instead.

The skill alone, with no push check, launcher or scanner download: `npx skills add openqodex/openqodex -g`. A later `init` replaces it with the skill it keeps up to date.

OpenQodex needs Node 22 or newer and git. It runs on macOS and Linux. On Windows, use WSL.

<!-- recording: added before launch -->

## What it does today

Four commands: `init`, `review`, `update` and `trust`. The commands hooks and agents call are listed in [docs/plumbing.md](docs/plumbing.md).

- `openqodex review` runs the whole review in one command: a frozen copy of the change, the scanners, the code graph, a reviewer process OpenQodex starts, script checks of its answer, and one report in the terminal and in `report.md`, `report.json` and `report.sarif`.
- `openqodex review --all` reviews the whole repository. `openqodex review <branch>` and `openqodex review '#42'` review a branch or a pull request that is not your current work. OpenQodex fetches it, checks it out in a temporary folder and reviews what it added since it left its base.
- The reviewer is Claude Code (`claude -p`) or Codex (`codex exec`). `auto` picks the agent you run the command from, then Claude Code, then Codex; `--reviewer` or `reviewer:` in `~/.openqodex/config.yaml` picks one.
- Claude Code starts with read, search and list tools only, inside the copy of the change, with none of your settings, hooks, plugins, memory or instruction files. Its event stream shows every read, so the report lists the files it read.
- Codex starts in a read-only sandbox that confines reads to the copy of the change and the system folders, with no network for its commands and none of your config, plugins, hooks or the repository's instruction files. It still loads your global `~/.codex/AGENTS.md`, and its event stream does not show every command, so the report says its reads were not recorded. [docs/internal-reviewer-drivers.md](docs/internal-reviewer-drivers.md) gives the tests.
- A review is complete only when every stage ran, every scanner finding was raised or dropped with a reason, and every changed line was in front of the reviewer: in the brief, in a later message from OpenQodex, or, for Claude Code, in a file it read. Anything else prints "Review incomplete" with what is missing, and exits 2.
- A change that only deletes code, such as a removed check, can still carry a finding: the lines next to a deletion count as changed.
- Thirteen built-in scanners. Every downloaded scanner is pinned to one version. Each runs only when the change holds a file it reads.
- A suppression comment the change adds, such as `# nosec`, and a changed scanner settings file are shown, since the scanner then stays silent: the reviewer checks each one, and a scan counts it as a minor finding.
- Any scanner by its GitHub link, after you approve it with `openqodex trust`.
- A push gate for Claude Code and Codex, and an optional git pre-push hook. Both look for a review of exactly what is pushed; neither scans or reviews by itself. They warn by default and block only when `.openqodex/config.yaml` sets `review.block_on_severity`.
- A GitHub Action that runs the full review on a pull request when the workflow gives it an Anthropic API key, and the scanners only (`openqodex scan`) without one. A pre-commit hook that runs the scanners only; it is not a review.
- `npx openqodex demo` builds a small repo with planted bugs and scans it.

## What it does not do yet

- The separate reviewer process needs Claude Code or Codex. Without either, `review` prints "Full review unavailable", says what is missing, saves the unchecked scanner findings to a file it names, and names the command with which the agent you are in reviews the change itself (`review --agent`). That report says which agent reviewed.
- No Cursor reviewer. `cursor-agent` has no way to limit its tools to reading or to skip your rules and settings.
- Codex cannot be the reviewer when `openqodex review` runs inside Codex's own sandbox: a second Codex does not start there. `review` then prints "Full review unavailable" and the `review --agent` command.
- A review takes one to three minutes and uses your own Claude Code or Codex plan.
- No review finds everything. The promise is that every stage runs, every scanner finding is checked, every changed line is put in front of the reviewer, and anything skipped is named.
- No review on your own API key without Claude Code or Codex.
- No tool server for agents (MCP).
- No Homebrew formula, no install script and no Docker image. Install through npm.
- No Windows support outside WSL.
- No offline copy of the vulnerability database. The dependency check asks osv.dev.

## First run

Scanners download on first use into `~/.openqodex/tools/`. Only the scanners your change needs download. The table below gives each download size.

Installed scanners take more disk than their downloads. The eight scanners the demo needs take about 700 MB of disk on an Apple Silicon Mac. semgrep with its Python takes about 440 MB of that.

A scanner install that takes longer than 45 seconds keeps going in the background. The report lists that scanner as installing. The scanner joins the next run. The review `init` ends with waits up to two minutes, since `init` has just started the downloads. To install every scanner up front, run `npx openqodex doctor --install`.

One measured first run: an Apple Silicon Mac, an empty tool folder, a line of 2 MB per second. The first `openqodex demo` printed its report in under a minute. That report held the scanners that had finished installing and listed the rest as installing. The next `scan` included all eight scanners. Your times depend on your line.

OpenQodex does not install language runtimes. brakeman and rubocop need Ruby 2.7 or newer. golangci-lint needs Go. Without them, the report lists those scanners as not installed, with the reason.

## Built-in scanners

| Scanner | Version | Runs when the change holds | Needs | Download (Apple Silicon, Linux x64) |
|---|---|---|---|---|
| semgrep | 1.94.0 | any file | Python 3.11, downloaded through uv | about 86 MB with bandit, measured on Apple Silicon |
| gitleaks | 8.21.2 | any file | nothing | 2.9 MB, 3.0 MB |
| bandit | 1.9.4 | `.py`, `.pyi` | the same Python as semgrep | included with semgrep |
| ruff | 0.8.4 | `.py`, `.pyi` | nothing | 9.9 MB, 11.2 MB |
| oxlint | 1.71.0 | `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`, `.mts`, `.cts` | npm, which ships with Node | 7.3 MB, 8.2 MB |
| osv-scanner | 1.9.2 | a lockfile, such as `package-lock.json` or `go.sum` | network access to osv.dev | 31.8 MB, 32.1 MB |
| actionlint | 1.7.7 | `.github/workflows/*.yml` | nothing | 2.0 MB, 2.1 MB |
| hadolint | 2.15.1 | a Dockerfile | nothing | 102.6 MB, 55.7 MB |
| shellcheck | 0.10.0 | `.sh`, `.bash` | `xz` to unpack | 7.2 MB, 2.4 MB |
| golangci-lint | 2.12.2 | `.go` | Go | 14.4 MB, 15.0 MB |
| brakeman | 6.2.1 | a Ruby or Rails file, in a repo with a `Gemfile` and an `app/` folder | Ruby 2.7 or newer; see its licence below | from RubyGems, not measured |
| rubocop | 1.69.2 | `.rb`, `.rake`, `.gemspec`, `Gemfile`, `Rakefile` | Ruby 2.7 or newer | from RubyGems, not measured |
| sqllint | built in | `.sql` | nothing, it runs inside OpenQodex | none |

[docs/scanners.md](docs/scanners.md) lists every file each scanner reads and what each one sends.

brakeman's licence is the Brakeman Public Use License, which is not an open source licence. OpenQodex does not bundle brakeman. It downloads brakeman at run time onto your machine. `scanners.disable: [brakeman]` switches it off.

## Add any scanner

Add a scanner by its GitHub link in your repo's `.openqodex/config.yaml`:

```yaml
scanners:
  custom:
    - source: https://github.com/aquasecurity/trivy
      run: trivy config --format sarif --output {report} {target}
```

A custom scanner is a command that runs on your machine. It never runs until you approve it:

```
npx openqodex trust
```

`trust` picks the release asset for your machine and downloads it. It shows the version, the asset, its sha256 and the run line, then asks yes or no. An edited entry needs a new approval. [docs/custom-scanners.md](docs/custom-scanners.md) explains each step.

## What goes over the network

- Scanner downloads on first use: GitHub release files checked against pinned sha256 sums, and pinned packages from PyPI, npm and RubyGems.
- Semgrep rule packs (`p/default`, `p/security-audit`, `p/secrets`), fetched from the Semgrep registry on each run.
- When the change holds a lockfile, osv-scanner sends dependency names and versions to osv.dev. It never sends code.
- The reviewer: Claude Code sends the review brief and the files it reads from the copy of the change to the model your Claude Code login uses. It can also open web pages (WebSearch and WebFetch); `reviewer_web: off` in `~/.openqodex/config.yaml` removes the web tools.
- The reviewer, when it is Codex: Codex sends the conversation, which holds the brief, your global `~/.codex/AGENTS.md` and the output of the commands it runs in the copy of the change, to the model your Codex login uses. It can also use Codex's cached web search unless `reviewer_web: off` is set; its commands get no network either way.

- `openqodex trust` reads the custom scanner's release from the GitHub API and downloads it.
- `openqodex review <branch>` or `review '#<number>'` fetches that branch or pull request from your remote with git, and asks `gh` for the pull request's base when `gh` is installed.
- For an install made with `init`, a version check at most once a day: the openqodex release list from registry.npmjs.org, and for a newer release its tarball and signed build record. It sends no code and nothing about you.

`--offline` skips osv-scanner and semgrep and turns scanner downloads, the version check, and the fetch and `gh` call of a branch or pull request review off.

The built-in scanners send no code anywhere. The reviewer's model sees the brief and what the reviewer reads, as with any Claude Code or Codex session. A custom scanner you approved does whatever its own command does. [docs/security.md](docs/security.md) gives the full list.

## Updates

An install made with `npx openqodex init` from 0.3.0 on keeps itself up to date. At most once a day, after a review, a scan or a push check, a background process looks for a new release. The command never waits for it. A release is installed only when it is at least 24 hours old and its signed build record (npm provenance) shows it was built by this repository's release workflow. It goes into a folder of its own beside the version you run, and the switch is one rename of a small file, so a failed or interrupted update leaves the working version in place. An update never rewrites your agent files: in user scope they call the launcher, and the skill asks it for the procedure of whatever version is active. The next command says once which version it moved to. `openqodex update --rollback` goes back.

Turn it off with `openqodex update --off`, `update: off` in `~/.openqodex/config.yaml` or `OPENQODEX_AUTO_UPDATE=0`. It is also off with `--offline` and when `CI` is set.

These do not update: files committed with `init --project`, the review section `init` adds to a repository's `CLAUDE.md` and `AGENTS.md`, the skill from `npx skills add` until the next `init` replaces it, the GitHub Action pin, and machines that are offline or stop background processes. An active install is usually one to two days behind a release. An install made with any earlier version needs one `npx openqodex init` to start updating.

## Packages

| Package | What it is |
|---|---|
| [`openqodex`](https://www.npmjs.com/package/openqodex) | One package. It holds the CLI as one bundled file with no runtime dependencies. The skill, the agent templates, the docs, the review patterns and the demo ship as separate files beside it. |

`@openqodex/core` and `@openqodex/scanners` are internal workspace packages. The CLI bundles them, and they are not published.

## Documentation

The docs ship inside the package. `npx openqodex guide <topic>` prints a page offline.

- [Quickstart](docs/quickstart.md)
- [Commands](docs/cli.md)
- [Plumbing commands](docs/plumbing.md)
- [Configuration](docs/config.md)
- [Scanners](docs/scanners.md)
- [Custom scanners](docs/custom-scanners.md)
- [Agents](docs/agents.md)
- [GitHub Action](docs/github-action.md)
- [Security](docs/security.md)
- [Privacy](docs/privacy.md)
- [FAQ](docs/faq.md)

## Telemetry

None. OpenQodex sends no usage data. semgrep runs with its own metrics switched off. See [docs/telemetry.md](docs/telemetry.md) and the privacy policy, [docs/privacy.md](docs/privacy.md).

## Security

Report a vulnerability through GitHub's private vulnerability reporting on this repo. Never open a public issue for one. See [SECURITY.md](https://github.com/openqodex/openqodex/blob/main/SECURITY.md).

## Status

OpenQodex is new and on the way to 1.0. Commands, flags and the config file can change between minor releases. [CHANGELOG.md](https://github.com/openqodex/openqodex/blob/main/CHANGELOG.md) records every change.

## Made by Qodex

[![Made by Qodex](https://raw.githubusercontent.com/openqodex/openqodex/main/.github/assets/made-by-qodex.svg)](https://qodex.ai?utm_source=openqodex&utm_medium=readme)

OpenQodex is made by [Qodex](https://qodex.ai?utm_source=openqodex&utm_medium=readme), which also runs a hosted review on every pull request.

Licensed under [Apache 2.0](LICENSE). See [NOTICE](NOTICE) for the scanners' licences.
