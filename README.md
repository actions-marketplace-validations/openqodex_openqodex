<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/openqodex/openqodex/main/.github/assets/readme-banner-dark.png">
  <img alt="OpenQodex" src="https://raw.githubusercontent.com/openqodex/openqodex/main/.github/assets/readme-banner-light.png" width="1280">
</picture>

# OpenQodex

[![npm version](https://img.shields.io/npm/v/openqodex)](https://www.npmjs.com/package/openqodex)
[![licence](https://img.shields.io/badge/licence-Apache--2.0-blue)](https://github.com/openqodex/openqodex/blob/main/LICENSE)
[![CI](https://github.com/openqodex/openqodex/actions/workflows/ci.yml/badge.svg)](https://github.com/openqodex/openqodex/actions/workflows/ci.yml)
[![Discussions](https://img.shields.io/github/discussions/openqodex/openqodex)](https://github.com/openqodex/openqodex/discussions)

AI agents: read the [agent guide for this release](https://github.com/openqodex/openqodex/blob/openqodex@0.12.0/docs/for-agents.md). After the install, `~/.openqodex/bin/openqodex guide for-agents` prints the same guide.

OpenQodex reviews your code change before you push it. Your change is the commits you have not pushed plus everything uncommitted. OpenQodex runs on your machine, from your coding agent or your terminal. First, it runs the scanners that fit the files you changed. A scanner is a program that checks code without a model, such as gitleaks or semgrep. OpenQodex keeps only the scanner findings on the lines you changed. Then it starts a reviewer: a separate Claude Code or Codex process on your own login. By default, the agent that wrote the code does not review it. Scripts then check that the reviewer answered every scanner finding and was given every changed line. You choose which findings your agent fixes.

## Where it runs

| Coding agent | Starts a review | Can be the reviewer | Push gate |
|---|---|---|---|
| Claude Code | yes | yes | yes |
| Codex CLI | yes | yes | yes, after you trust the hook in Codex |
| Cursor | yes | no | no, a rule asks Cursor to review |
| Cline | yes | no | no, a rule asks Cline to review |

In Cursor and Cline, the review needs Claude Code or Codex installed as the reviewer. A push gate is a hook that looks for a review before your agent runs `git push`. The git pre-push hook that `init` adds does the same for a push from any tool.

## Requirements

- Node 22 or newer, and git.
- macOS or Linux. CI tests both. On Windows, use WSL; no test runs there.
- For a full review: Claude Code or Codex, installed and logged in. You need no other key and no account.
- Some scanners need a runtime that OpenQodex does not install: Ruby for brakeman and rubocop, Go for golangci-lint, Cargo for cargo-deny.

## Install

For people, in your terminal:

```
npx openqodex init
```

`init` finds Claude Code, Cursor, Codex CLI and Cline on your machine. It lists every file it will write and asks once. It starts the scanner downloads that your repository needs. Then it reviews your current change when a reviewer can start.

After that, say to your agent: "review my change with openqodex". In your own terminal, run `~/.openqodex/bin/openqodex review`. That path is the launcher, a small script that `init` writes. An `npx` install puts no `openqodex` on your `PATH`.

For agents, the same install with no question:

```
npx -y openqodex@0.12.0 init --yes --agent <host>
```

`<host>` is `claude-code`, `codex`, `cursor` or `cline`. Codex runs commands in a sandbox with no network by default. From Codex, run this line in your own terminal.

The [quickstart](https://github.com/openqodex/openqodex/blob/main/docs/quickstart.md) has a prompt to paste into your agent.

To install the skill alone, with no push gate and no scanner download, run `npx skills add openqodex/openqodex -g`. A later `init` replaces that skill with the one it keeps up to date.

OpenQodex collects no usage data, and the built-in scanners send no code; the [privacy page](https://github.com/openqodex/openqodex/blob/main/docs/privacy.md) lists every network use.

<!-- recording: added before launch -->

## What it does today

- `openqodex review` reviews your change in one command. It writes `report.html`, `report.md`, `report.json` and `report.sarif`. SARIF is a standard JSON format for scanner results.
- At the end, it prints a receipt: the verdict, one line per finding and the path of `report.html`.
- Your agent shows you the receipt and asks "Fix all, or tell me which?". It fixes only the findings you name.
- `review --all` reviews the whole repository. `review <branch>` and `review '#42'` review a branch or a pull request.
- A review is complete only when every stage ran. Otherwise it prints "Review incomplete" with what is missing, and exits 2.
- The push gate and the git pre-push hook look for a review of what you push. They warn by default. They block only when `.openqodex/config.yaml` sets `review.block_on_severity`.
- The GitHub Action runs the full review on a pull request when the workflow gives it an Anthropic API key. Without a key, it runs the scanners only, as the pre-commit hook does.
- `openqodex graph` answers questions about the code, such as who calls a function. `init` gives your agent the same questions as tools, through an MCP server. That is a local tool server that your agent starts. For the Cline VS Code extension, `init` prints the entry for you to add.
- `--offline` skips semgrep, osv-scanner, kubeconform and cargo-deny, the four scanners that use the network. It also turns scanner downloads off.
- `npx openqodex demo` builds a small repository with planted bugs and scans it.

## What it does not do yet

- No reviewer other than Claude Code or Codex. Cursor cannot be the reviewer, because `cursor-agent` cannot be limited to reading.
- Without a reviewer, `review` prints "Full review unavailable" and exits 2. It saves the scanner findings, unchecked, to a file. It also names a fallback in which your coding agent reviews the change itself.
- Codex cannot be the reviewer when `review` runs inside the Codex sandbox.
- No review on your own API key, except in the GitHub Action.
- No Homebrew formula, no install script and no Docker image. Install through npm.
- No offline copy of the vulnerability database. The dependency check asks osv.dev.
- No review finds every problem. A review report names each stage that did not run.

## Built-in scanners

OpenQodex has 22 built-in scanners. A scanner runs only when your change holds a file it reads. Some scanners also read the project or folder around a changed file. OpenQodex then keeps only the findings on changed lines. Each scanner that needs a download gets it on first use, pinned to one version.

| What it checks | Built-in scanners |
|---|---|
| Secrets in code | 1 |
| Security problems in code | 3 |
| Dependencies with known vulnerabilities | 2 |
| Lint | 5 |
| GitHub Actions workflows | 2 |
| Dockerfiles, Terraform, Kubernetes and CloudFormation | 6 |
| SQL and database migrations | 3 |

The [scanner list](https://github.com/openqodex/openqodex/blob/main/docs/scanners.md) gives each scanner, its version, the files it reads and what it does not check.

## Add a scanner from GitHub

You or your agent can configure a compatible scanner from GitHub. Then you approve it before it runs.

1. Add the scanner to `.openqodex/config.yaml` in your repository:

   ```yaml
   scanners:
     custom:
       - source: https://github.com/Bearer/bearer
         run: bearer scan {target} --format sarif --output {report} --quiet --disable-version-check
         target: repo
   ```

2. Approve it with `npx openqodex trust`. It downloads the release to a quarantine folder, shows what will run, and asks yes or no.
3. Check it with `npx openqodex scan --only custom:bearer`. The next review includes it.

To use your agent, say: "add https://github.com/Bearer/bearer to OpenQodex as a custom scanner". The agent writes the entry. The skill tells it never to run `openqodex trust` without asking you first.

A compatible scanner meets these limits:

- It writes SARIF, or one JSON document that a `map` block in the config turns into findings.
- It installs from a GitHub release file for your system, an exact npm or PyPI version, or your `PATH`.
- It runs only where you approved it. So the GitHub Action never runs it on a GitHub-hosted runner.

Bearer CLI is under the Elastic License 2.0, which is not an open source licence. The [custom scanner guide](https://github.com/openqodex/openqodex/blob/main/docs/custom-scanners.md) explains every key.

## Packages

| Package | What it is |
|---|---|
| [`openqodex`](https://www.npmjs.com/package/openqodex) | The CLI as one file with no runtime dependencies, with the skill, the agent templates, the docs and the demo beside it. |

You can also import `openqodex` as a [Node library](https://github.com/openqodex/openqodex/blob/main/docs/library.md). The workspace packages under `packages/` are bundled into it and are not published.

## Documentation

The docs ship inside the package. `npx openqodex guide <topic>` prints one page in your terminal.

- [Quickstart](https://github.com/openqodex/openqodex/blob/main/docs/quickstart.md)
- [Agent guide](https://github.com/openqodex/openqodex/blob/main/docs/for-agents.md)
- [Commands](https://github.com/openqodex/openqodex/blob/main/docs/cli.md)
- [Configuration](https://github.com/openqodex/openqodex/blob/main/docs/config.md)
- [What init writes for each agent](https://github.com/openqodex/openqodex/blob/main/docs/agents.md)
- [GitHub Action](https://github.com/openqodex/openqodex/blob/main/docs/github-action.md)
- [Security](https://github.com/openqodex/openqodex/blob/main/docs/security.md)
- [All pages](https://github.com/openqodex/openqodex/blob/main/docs/index.md)

## Made by Qodex

[![Made by Qodex](https://raw.githubusercontent.com/openqodex/openqodex/main/.github/assets/made-by-qodex.svg)](https://qodex.ai?utm_source=openqodex&utm_medium=readme)

OpenQodex is made by [Qodex](https://qodex.ai?utm_source=openqodex&utm_medium=readme), which also runs a hosted review on every pull request.

## Telemetry

None. semgrep runs with its own metrics switched off. The [telemetry page](https://github.com/openqodex/openqodex/blob/main/docs/telemetry.md) says more.

## Security

Report a vulnerability through GitHub's private vulnerability reporting, as the [security policy](https://github.com/openqodex/openqodex/blob/main/SECURITY.md) says. Never open a public issue for one.

## Status

OpenQodex is on the way to 1.0. Commands, flags and the config file can change between minor releases. The [changelog](https://github.com/openqodex/openqodex/blob/main/packages/cli/CHANGELOG.md) records every release.

Licensed under [Apache 2.0](https://github.com/openqodex/openqodex/blob/main/LICENSE). The [NOTICE](https://github.com/openqodex/openqodex/blob/main/NOTICE) file gives the scanners' licences.
