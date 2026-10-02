# Security

This page says what OpenQodex runs, what it sends where, and what it writes. Report a vulnerability through GitHub's private vulnerability reporting on the openqodex/openqodex repository. Never open a public issue for one.

## What runs

- The `openqodex` CLI, on your Node.
- The built-in scanners that fit the change, from `~/.openqodex/tools/`. Each is pinned to one version. A built-in scanner is never taken from your `PATH`.
- Custom scanners from `.openqodex.yaml` that you approved with `openqodex trust`.
- git, from your `PATH`.

OpenQodex starts every program with an argument list, never through a shell. Scanners get a small set of environment variables: `PATH`, `HOME`, `TMPDIR`, `LANG`, the `LC_` variables, the proxy variables, and what the scanner itself needs. Your other variables, such as API keys, are not passed on.

A repository can hold config files that make a scanner run code or rewrite files. OpenQodex does not load such files for oxlint, golangci-lint, brakeman and rubocop. It uses its own settings for them. ruff and gitleaks read the repository's own settings for rules only. ruff runs with fixes switched off.

## The trust step

A custom scanner is an arbitrary command. It runs on your machine with your permissions. The config file that names it comes from whatever repository you cloned. So nothing installs or runs a custom scanner until you approve that exact entry:

```
npx openqodex trust
```

`trust` downloads the release asset to a quarantine folder before it asks. Nothing is installed or run before your yes. `scan` and `review` never download a custom scanner. `trust` prints the version, the asset, its sha256, the program and the run line, then asks yes or no. The approval covers that repository and that entry only. An edited entry needs a new approval. `scan` and `review` skip an unapproved entry and list it as `untrusted`.

The stored sha256 is checked against the project's checksum file when the project publishes one. Otherwise it is the hash of your first download. `custom-scanners` explains the difference.

Agents that follow the OpenQodex skill are told never to run `openqodex trust` without asking you.

## What is sent where

OpenQodex and the built-in scanners send no code anywhere. The review runs on the model your agent already uses, which sees what the agent reads. A custom scanner you approved does whatever its own command does.

OpenQodex and the built-in scanners use the network for these things only:

- Scanner downloads on first use. GitHub release files are checked against sha256 sums pinned in the package. semgrep and bandit come from PyPI through uv, with a Python 3.11 that uv downloads. oxlint comes from npm. brakeman and rubocop come from RubyGems. These package installs are pinned by version.
- Semgrep rule packs. semgrep fetches `p/default`, `p/security-audit` and `p/secrets` from the Semgrep registry on each run. Its metrics are off. The rules are never bundled in the package.
- The dependency check. When the change holds a lockfile, osv-scanner sends the names and versions of the dependencies in it to osv.dev. It never sends code.
- Custom scanners. `openqodex trust` reads the release from the GitHub API and downloads the asset. After approval, a custom scanner does whatever its own command does.

golangci-lint runs with the Go module proxy off, so it downloads no modules.

`--offline` skips osv-scanner and semgrep, which the report lists as disabled. It also turns scanner downloads off.

OpenQodex sends no telemetry. See `telemetry`.

## Secrets

When gitleaks finds a secret in the change, OpenQodex removes it from the brief, every report file and the terminal. It keeps the length and sha256 of each secret, to redact any text the agent quotes.

gitleaks writes its raw report to a temporary file outside the repository. That file holds the matched secrets. OpenQodex deletes it when the run ends. No file OpenQodex keeps holds the secret.

A secret is redacted only when a scanner matched it. When gitleaks did not run, the brief shows the change as it is.

## Where files are written

In your home folder, under `~/.openqodex/` (`OPENQODEX_HOME` moves it):

- `tools/<scanner>/<version>/`: the scanners.
- `tools/uv-python/`: the Python 3.11 for semgrep and bandit.
- `cache/`: the download caches for uv and npm.
- `runtime/<version>/` and `bin/openqodex`: the copy of the package and the launcher that the hooks call, written by `init`.
- `install.json`: what `init` and `hook install` wrote, so an uninstall removes only that.
- `trust.json`: your approvals of custom scanners.

In the repository, under `.openqodex/` only:

- `.gitignore`, holding `*`, so the folder ignores itself and `git status` does not change.
- `reviews/<time>-<id>/`: one folder per run, holding the brief, the scan result, the agent's findings and the reports. OpenQodex keeps the newest 20.
- `latest.json`: points at the newest run.

The agent settings and skill files `init` writes are listed in `agents`.

The change itself is worked out without writing inside `.git`. OpenQodex uses a temporary copy of the index and a temporary object folder.
