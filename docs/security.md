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

Agents that follow the OpenQodex skill are told never to run `openqodex trust` without asking you. In user scope, `init` adds rules so Claude Code runs exactly `review` and `review --all` (each also with ` --offline`), `guide` and `guide <topic>` through the launcher without asking. It removes the rules for the older two-step lines (`review --agent`, `review --finalize`) that an earlier `init` added. A review of a branch or a pull request names its target, so Claude Code asks before each one. An `ask` or `deny` rule in your own or your organisation's managed Claude Code settings still wins over these. Any other flag, any other command (`scan`, `doctor`, `trust`, `update`, `init`, `report`) and `init --project` grant nothing.

## What is sent where

OpenQodex and the built-in scanners send no code anywhere. The review runs on the model your Claude Code login uses: the reviewer process sends it the brief and what the reviewer reads (see "The reviewer process"). A custom scanner you approved does whatever its own command does.

OpenQodex and the built-in scanners use the network for these things only:

- Scanner downloads on first use. GitHub release files are checked against sha256 sums pinned in the package. semgrep and bandit come from PyPI through uv, with a Python 3.11 that uv downloads. oxlint comes from npm. brakeman and rubocop come from RubyGems. These package installs are pinned by version.
- Semgrep rule packs. semgrep fetches `p/default`, `p/security-audit` and `p/secrets` from the Semgrep registry on each run. Its metrics are off. The rules are never bundled in the package.
- The dependency check. When the change holds a lockfile, osv-scanner sends the names and versions of the dependencies in it to osv.dev. It never sends code.
- Custom scanners. `openqodex trust` reads the release from the GitHub API and downloads the asset. After approval, a custom scanner does whatever its own command does.
- The daily version check, for an install made with `init`. See "Updates" below.
- A review of a branch or a pull request (`review <branch>`, `review '#<number>'`). git fetches the branch or `pull/<number>/head` from your remote with its own credentials, and `gh`, when it is installed and signed in, is asked for the pull request's base. OpenQodex reads no token. The target is checked out in `~/.openqodex/checkouts/`, a folder only you can open, with every git hook and filter switched off, so checking it out runs nothing from it, and a link in it becomes a small plain file. The scanners you approved for this repository do run on the target's files, with this repository's settings; one named only in the target's config never runs. If you review pull requests from people you do not trust, approve only custom scanners that do not execute the code they scan.

golangci-lint runs with the Go module proxy off, so it downloads no modules.

`--offline` skips osv-scanner and semgrep, which the report lists as disabled. It also turns scanner downloads off and the version check. A review of a branch or a pull request with `--offline` fetches nothing and calls no `gh`.

## Updates

An install made with `npx openqodex init` runs through the launcher `~/.openqodex/bin/openqodex`. After a `review`, `scan`, `hook check` or `hook pre-push` that the launcher started, at most once every 24 hours, OpenQodex starts a background process and the command exits without waiting for it.

What it sends: GET requests to `registry.npmjs.org` only, over https, with no body and no header but the user agent `openqodex/<version>`. First the openqodex package's release list. Then, for a newer release, its tarball and its attestations. Nothing about you, your code or your repository is sent. Every redirect must stay on `registry.npmjs.org`.

What it installs: a release that is newer than the running one, in the same major version, at least 24 hours old, not deprecated, not a prerelease, and fit for your Node. Before any of its code runs:

- the tarball's sha512 must equal the registry's `dist.integrity`;
- its SLSA provenance must verify in full with Sigstore: the certificate chain to the Fulcio roots, the certificate transparency entry, the transparency log entry and the signature;
- the signing certificate must be issued to `https://github.com/openqodex/openqodex/.github/workflows/release.yml@refs/heads/main` by `https://token.actions.githubusercontent.com`, compared exactly;
- the signed statement must name `pkg:npm/openqodex@<version>` with the downloaded tarball's sha512.

A stolen npm publish token is therefore not enough to reach your machine: the release must come out of this repository's release workflow on `main`. The 24 hour age is a window to deprecate a bad release before installs take it.

The Sigstore trust data (Fulcio roots, log keys) ships inside each release, so verification makes no other network call. When Sigstore rotates a key that an old release does not know, that release cannot verify newer ones. It stays on its version and says once how to update by hand: `npx openqodex@latest init`.

A verified release is unpacked into a temporary folder under `~/.openqodex/runtime/`. A link in the tarball, or a path that leaves the folder, stops it. No install script runs. The new copy must print its own version. Only then, holding the lock below, the updater checks again that updates are still on, that OpenQodex is still installed and that no other update, rollback or `init` changed the active version meanwhile. It then renames the copy to `~/.openqodex/runtime/<version>/` and switches `~/.openqodex/runtime/current` by a second rename. A version folder is never replaced: when one with other contents is already there, the release is skipped. An update writes no agent file and nothing inside a repository.

The lock: while `init`, `init --uninstall`, `hook install`, `update --rollback`, `update --off`, `update --on` or an update's switch runs, OpenQodex briefly opens a listener on 127.0.0.1, on a port between 20000 and 32000 derived from the path of `~/.openqodex`, so that two of them never run at once; it accepts no data and answers nothing, and the operating system closes it when the process ends, however it ends. When the listener cannot be opened at all, those commands stop with one line saying why, and the daily check skips the switch. The port is predictable, so a local program that holds it stops install, uninstall and updates until it lets go; nothing is installed or changed while it is held. A command that waited 60 seconds for it names the port and the line that shows the holder (`lsof -nP -iTCP:<port> -sTCP:LISTEN`), and the daily check records the same as its last error, which `openqodex update --status` and `doctor` show.

Updates are off with `openqodex update --off`, `update: off` in `~/.openqodex/config.yaml`, `OPENQODEX_AUTO_UPDATE=0`, `--offline` or `OPENQODEX_OFFLINE=1`, and whenever `CI` is set. A run through `npx` or a project-scope file never checks.

OpenQodex sends no telemetry. See `telemetry`.

## The reviewer process

`openqodex review` starts Claude Code (`claude -p`) as its reviewer. Codex and Cursor are not used as reviewers: with the versions tested, one loads your global instructions and does not report every command it runs, and the other cannot be limited to reading. `docs/internal-reviewer-drivers.md` in the repository records the tests. It sends the review brief and the files the reviewer reads to the model your Claude Code login uses, as any Claude Code session does. The reviewer:

- reads a snapshot of the change in `~/.openqodex/checkouts/`, never your folder. Secrets the scanners found are redacted in every file of the snapshot first, and a file too large to check is left out of it.
- has the read, search and list tools only: no shell, no edits, no web, no MCP server, no subagent. The one exception is the web: `reviewer_web: on` in `~/.openqodex/config.yaml` adds Claude Code's WebSearch and WebFetch. It is off by default. A reviewer that reads private code and untrusted text from the change and can open web addresses can be talked into putting that code into a web address. Turn it on only when you accept that risk. Claude Code's own permission rules refuse a read outside the snapshot; that is the boundary. OpenQodex also checks every tool call in the agent's event stream and marks the review incomplete when one names a path outside the snapshot, an unknown tool or an input it cannot read; that is the alarm.
- loads none of your Claude Code settings, hooks, plugins, memory or `CLAUDE.md` files, and none of the repository's.
- gets an environment built from a short allowlist: the variables Claude Code needs to run and find its login (`PATH`, `HOME`, `USER`, `CLAUDE_CONFIG_DIR`, proxy settings, `ANTHROPIC_*` keys, and cloud provider variables only when Claude Code is set to that provider). Other tokens in your shell, such as `GITHUB_TOKEN` or `NPM_TOKEN`, never reach it.

The reviewer runs with session saving off (`--no-session-persistence`). After real runs with Claude Code 2.1.289, no transcript, history line or project entry for a snapshot was found in the Claude Code configuration folder. Claude Code's own logs and telemetry follow its own settings.

The run folder of a review holds the brief, the scan, the reviewer's answer and the list of its tool calls (paths and line ranges, never file contents). Each file is created readable by you only, and secrets are redacted in all of them.

## Secrets

When gitleaks finds a secret in the change, OpenQodex removes it from the brief, every report file and the terminal. It keeps the length and sha256 of each secret, to redact any text the agent quotes.

gitleaks writes its raw report to a temporary file outside the repository. That file holds the matched secrets. OpenQodex deletes it when the run ends. No file OpenQodex keeps holds the secret.

A secret is redacted only when a scanner matched it. When gitleaks did not run, the brief shows the change as it is.

## Where files are written

In your home folder, under `~/.openqodex/` (`OPENQODEX_HOME` moves it):

- `tools/<scanner>/<version>/`: the scanners.
- `tools/uv-python/`: the Python 3.11 for semgrep and bandit.
- `cache/`: the download caches for uv and npm.
- `runtime/<version>/` and `bin/openqodex`: the copy of the package and the launcher that the hooks call, written by `init`. Updates add copies beside it; a copy is never changed after it is written. `init` and `openqodex update` remove copies older than 7 days, except the one `init` installed, the current one and the previous one.
- `runtime/current`: the version the launcher runs, and on a second line the version a rollback goes back to.
- `update.json`: the state of the version check, private to you.
- `config.yaml`: your own settings: `update`, `reviewer` (which agent reviews) and `reviewer_web` (the reviewer's web tools, off by default).
- `install.json`: what `init` and `hook install` wrote, so an uninstall removes only that.
- `receipts/<repo id>/`: one small record per reviewed change, readable by you only, written by `review` at the end of a run (and by `review --finalize` for the older two-step protocol, only for a run whose scan this machine ran). The push hooks decide from these records only. The files under the repository's `.openqodex/` are the readable report, never the proof: a branch can carry those files, so a record found only there counts as no review. The check inside your agent is a reminder about your current work: it does not know what a push sends. For a plain `git push` it asks whether your current work has a passing review; any other push command it cannot tell, and says so (a deny when `block_on_severity` is set). The git pre-push hook that `init` offers is the check that sees the exact commits a push sends, and `git push --no-verify` skips it. `init` and `openqodex update` remove records older than 30 days.
- `runs/<repo id>/`: one record per `review --agent` run, readable by you only: the change and the hashes of the run files it wrote, so `review --finalize` can tell a run this machine scanned from one a branch carries. Removed with the receipts.
- `trust.json`: your approvals of custom scanners.

In the repository, under `.openqodex/` only:

- `config.yaml` and `custom-instructions.md`: the team's config and instructions for the reviewer, created once and never touched after. They are meant to be committed.
- `.gitignore`: keeps the run state below out of git, so after the first run `git status` shows only the two files above and the `.gitignore`.
- `reviews/<time>-<id>/`: one folder per run, holding the brief, the scan result, the reviewer's answer, the list of its tool calls and the reports. OpenQodex keeps the newest 20.
- `latest.json`: points at the newest review, for you and older tools; the push gate does not trust it (see `receipts/` above). `latest-scan.json` points at the newest scan.

OpenQodex never reads or writes `.openqodex/` or the root `.openqodex.yaml` through a symbolic link, at the file or at any folder above it inside the repository. A link there stops the command with one line naming it, or, for a run file such as `latest.json`, counts as no file. Only regular files are read there, each within a size limit, so a link or a device in their place cannot hang a run.

The agent settings and skill files `init` writes are listed in `agents`.

The change itself is worked out without writing inside `.git`. OpenQodex uses a temporary copy of the index and a temporary object folder.
