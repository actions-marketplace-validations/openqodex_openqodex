# Scanners

OpenQodex has thirteen built-in scanners. Each one runs only when the change holds a file it reads. Every downloaded scanner is pinned to one version. OpenQodex never uses a copy of a built-in scanner from your `PATH`.

Pinned versions do not make findings identical on every machine. semgrep fetches its registry rule packs at run time, and OpenQodex does not pin their version.

Every scanner reads the whole changed file. OpenQodex keeps only the findings on changed lines.

## Where scanners come from

Scanners download on first use into `~/.openqodex/tools/<scanner>/<version>/`. `OPENQODEX_HOME` moves that folder.

- GitHub release files are checked against the sha256 pinned in the package before they are unpacked.
- semgrep and bandit install from PyPI through uv, into one Python 3.11 that OpenQodex manages. uv comes from your `PATH` when present. Otherwise OpenQodex downloads a pinned uv.
- oxlint installs from npm, with the npm that ships beside your Node. Package install scripts are switched off.
- brakeman and rubocop install from RubyGems with your Ruby's `gem` command.

A scanner install that takes longer than 45 seconds keeps going in the background. The report lists that scanner as installing. The scanner joins the next run. `openqodex doctor --install` installs every scanner and waits.

Installed scanners take more disk than their downloads. The eight scanners the demo needs take about 700 MB of disk on an Apple Silicon Mac. semgrep with its Python takes about 440 MB of that.

OpenQodex does not install Ruby or Go. Without them, the report lists the scanners that need them as not installed, with the reason.

## Status in the report

The report lists every selected scanner with one status. A scanner left out with `--only` or `--skip` is not listed.

- `ran`: it ran.
- `no_matching_files`: the change holds no file it reads.
- `installing`: it is downloading for the first time. It joins the next run.
- `not_installed`: it could not be installed here. The reason says why.
- `failed`: it ran and broke. The reason holds its error.
- `disabled`: `scanners.disable` names it, or `--offline` skipped it.
- `untrusted`: a custom scanner you have not approved.

A scanner problem never changes the exit code.

## Changed scanner settings

Several scanners read settings or an ignore list from the repository, as OpenQodex runs them. At the repository root only: gitleaks `.gitleaks.toml`, `gitleaks.toml` and `.gitleaksignore`; semgrep `.semgrepignore`; hadolint `.hadolint.yaml` and `.hadolint.yml`; actionlint `.github/actionlint.yaml` and `.github/actionlint.yml`. In any folder: ruff `ruff.toml` and `.ruff.toml`, and `pyproject.toml` when the change touches its `[tool.ruff` table; shellcheck `.shellcheckrc` and `shellcheckrc`; osv-scanner `osv-scanner.toml`. A change to one of them can hide that scanner's findings.

In a review, each such changed file is a major candidate of that scanner, rule `settings-file`, on its first changed line; the reviewer verifies it and raises it or drops it with a reason. In a scan (`scan`, which the pre-commit hook and the Action run) nobody can clear it, so it is a minor finding and counts toward the verdict. The scanner still reads the changed file. `--only`, `--skip` and `scanners.disable` leave it out with its scanner.

## Suppression comments

A comment in the code can tell a scanner to skip a line, such as `# nosec` for bandit. The scanner obeys it and reports nothing there. So each such comment on a line the change adds is a candidate of the scanner it silences, rule `openqodex.suppression-added`, on that line. It is raised whether or not that scanner is installed, and only in a file that scanner checks. Its message names the comment and the scanner, never the rest of the line, which can hold a secret.

In a review, the reviewer verifies it and raises it or drops it with a reason. In a scan it is a minor finding and counts toward the verdict, so `block_on_severity: minor` blocks on it. The scanner still obeys the comment. A comment the change did not add raises nothing, and neither does `review --all`. `--only`, `--skip` and `scanners.disable` leave it out with its scanner, and `review.disabled_rules: ["*:openqodex.suppression-added"]` turns it off.

A comment counts only where its scanner reads it. OpenQodex finds the comments of the whole file first, so the same text inside a string, a multi-line string or a heredoc does not count. semgrep and gitleaks obey their marker anywhere on the line, in a string too, and so does OpenQodex. A file over 5 MB is not read for these comments.

| Scanner | Comment | Where it counts | Checked against |
|---|---|---|---|
| semgrep | `nosemgrep` or `nosem`, in any case, after a space | anywhere on the line | the 1.94.0 binary; [docs](https://docs.semgrep.dev/ignoring-files-folders-code) |
| gitleaks | `gitleaks:allow` | anywhere on the line | the 8.21.2 binary; [detect.go](https://github.com/gitleaks/gitleaks/blob/v8.21.2/detect/detect.go) |
| bandit | `# nosec`, with or without the space | anywhere in a Python comment | the 1.9.4 binary; [manager.py](https://github.com/PyCQA/bandit/blob/1.9.4/bandit/core/manager.py) |
| ruff | `# noqa` in any case; `# ruff: noqa` and `# flake8: noqa` | anywhere in a Python comment; the file forms on a line of their own | the 0.8.4 binary; [noqa.rs](https://github.com/astral-sh/ruff/blob/0.8.4/crates/ruff_linter/src/noqa.rs) |
| shellcheck | `# shellcheck disable=` | a shell comment | the 0.10.0 binary; [Parser.hs](https://github.com/koalaman/shellcheck/blob/v0.10.0/src/ShellCheck/Parser.hs) |
| hadolint | `# hadolint ignore=`, `# hadolint global ignore=`, `# hadolint stage ignore=` | a Dockerfile comment line | the 2.15.1 binary; [Pragma.hs](https://github.com/hadolint/hadolint/blob/v2.15.1/src/Hadolint/Pragma.hs) |
| oxlint | `eslint-disable`, `oxlint-disable`, each also with `-line` or `-next-line` | the start of a `//` or `/* */` comment | the 1.71.0 binary; [disable_directives.rs](https://github.com/oxc-project/oxc/blob/oxlint_v1.71.0/crates/oxc_linter/src/disable_directives.rs) |
| golangci | `//nolint`; gosec's `#nosec` and `//gosec:disable` | a `//` comment for `//nolint`; the start of a comment line for `#nosec` | source only: [nolint_filter.go](https://github.com/golangci/golangci-lint/blob/v2.12.2/pkg/result/processors/nolint_filter.go), [gosec analyzer.go](https://github.com/securego/gosec/blob/v2.26.1/analyzer.go) |
| rubocop | `# rubocop:disable` and `# rubocop:todo` with a cop name or `all` | a Ruby comment, `=begin` blocks included | source only: [directive_comment.rb](https://github.com/rubocop/rubocop/blob/v1.69.2/lib/rubocop/directive_comment.rb) |

actionlint, brakeman, osv-scanner and sqllint have no inline comment. actionlint ([usage](https://github.com/rhysd/actionlint/blob/v1.7.7/docs/usage.md)) and osv-scanner ([configuration](https://google.github.io/osv-scanner/configuration/)) skip findings only through their settings files; brakeman ([ignoring false positives](https://brakemanscanner.org/docs/ignoring_false_positives/)) only through its ignore file.

The comments are found by a small reader per comment family, not a full parser. Text in JSX, a regular expression in an unusual place, or `<<` inside shell arithmetic can be read wrongly on a rare line.

## semgrep

- Version: 1.94.0.
- Runs when: any file changed.
- Needs: Python 3.11, which OpenQodex downloads through uv. About 86 MB with uv and bandit, measured on Apple Silicon.
- Rules: the registry packs `p/default`, `p/security-audit` and `p/secrets`.
- Sends: semgrep fetches those rule packs from the Semgrep registry on each run. It runs with its metrics switched off. The rules are never bundled in the OpenQodex package.
- `--offline` skips it. The report lists it as disabled.

## gitleaks

- Version: 8.21.2.
- Runs when: any file changed.
- Needs: nothing. 2.9 MB on Apple Silicon, 3.0 MB on Linux x64.
- Writes: links the changed files into a temporary folder outside the repo and scans that folder. It reads the repo's `.gitleaks.toml` or `gitleaks.toml` when present.
- gitleaks writes its raw report to a temporary file outside the repo. That file holds the matched secrets. OpenQodex deletes it when the run ends.
- Sends: nothing.
- Secrets it finds are redacted from the brief, every report file and the terminal. No file OpenQodex keeps holds the secret.

## bandit

- Version: 1.9.4.
- Runs when: a `.py` or `.pyi` file changed.
- Needs: the same Python as semgrep.
- Sends: nothing.

## ruff

- Version: 0.8.4.
- Runs when: a `.py` or `.pyi` file changed.
- Needs: nothing. 9.9 MB on Apple Silicon, 11.2 MB on Linux x64.
- Reads the repo's own ruff settings. It runs with fixes and its cache switched off, so it changes no file.
- Sends: nothing.

## oxlint

- Version: 1.71.0.
- Runs when: a `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`, `.mts` or `.cts` file changed.
- Needs: npm, which ships with Node. About 7.3 MB on Apple Silicon, 8.2 MB on Linux x64.
- Uses OpenQodex's own settings. A config file in the repo is not loaded.
- Sends: nothing.

## osv-scanner

- Version: 1.9.2.
- Runs when: one of these lockfiles changed: `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock`, `go.mod`, `go.sum`, `requirements.txt`, `Pipfile.lock`, `poetry.lock`, `Gemfile.lock`, `composer.lock`, `pom.xml`, `gradle.lockfile`, `pubspec.lock`, `mix.lock`, `conan.lock`.
- Needs: network access to osv.dev. 31.8 MB on Apple Silicon, 32.1 MB on Linux x64.
- Sends: the names and versions of the dependencies in those lockfiles, to osv.dev. It never sends code.
- `--offline` skips it. The report lists it as disabled.

## actionlint

- Version: 1.7.7.
- Runs when: a `.yml` or `.yaml` file under `.github/workflows/` changed.
- Needs: nothing. 2.0 MB on Apple Silicon, 2.1 MB on Linux x64.
- Sends: nothing.

## hadolint

- Version: 2.15.1.
- Runs when: a Dockerfile changed: `Dockerfile`, `Dockerfile.<name>` or `<name>.dockerfile`.
- Needs: nothing. 102.6 MB on Apple Silicon, 55.7 MB on Linux x64.
- Sends: nothing.

## shellcheck

- Version: 0.10.0.
- Runs when: a `.sh` or `.bash` file changed.
- Needs: `xz` to unpack the download. 7.2 MB on Apple Silicon, 2.4 MB on Linux x64.
- Sends: nothing.

## golangci-lint

- Version: 2.12.2. Its name in `.openqodex.yaml` is `golangci`.
- Runs when: a `.go` file changed. It checks the packages that hold the changed files.
- Needs: Go on your `PATH`. 14.4 MB on Apple Silicon, 15.0 MB on Linux x64.
- Uses OpenQodex's own settings, with gosec switched on. A `.golangci.yml` in the repo is not loaded. It never rewrites `go.mod` or `go.sum`.
- golangci-lint 2.12.2 is built with Go 1.26. With a newer Go on your PATH it cannot check the code. The report then lists golangci as failed, with the reason.
- Runs with the Go module proxy off. The modules the repo needs must already be in your Go module cache. Nothing is downloaded.
- Sends: nothing.

## brakeman

- Version: 6.2.1.
- Runs when: a Ruby or Rails file changed, and the repo has a `Gemfile` and an `app/` folder. The files are `.rb`, `.rake`, `.gemspec`, `.erb`, `.haml`, `.slim`, `Gemfile`, `Rakefile` and `config.ru`.
- Needs: Ruby 2.7 or newer. It installs from RubyGems.
- Uses OpenQodex's own settings. The repo's brakeman config is not loaded.
- Sends: nothing.
- Licence: the Brakeman Public Use License, which is not an open source licence. OpenQodex does not bundle brakeman. It downloads brakeman at run time onto your machine. Read the licence before you use it, or switch it off with `scanners.disable: [brakeman]`.

## rubocop

- Version: 1.69.2, with rubocop-rails 2.28.0 and rubocop-performance 1.23.0.
- Runs when: a `.rb`, `.rake` or `.gemspec` file, a `Gemfile` or a `Rakefile` changed.
- Needs: Ruby 2.7 or newer. It installs from RubyGems.
- Uses OpenQodex's own settings. A `.rubocop.yml` in the repo is not loaded, because it can load Ruby code.
- Sends: nothing.

## sqllint

- Version: part of OpenQodex.
- Runs when: a `.sql` file changed.
- Needs: nothing. It runs inside OpenQodex and downloads nothing.
- Checks Postgres migrations for common mistakes, such as a privileged function left callable by every role.
- Sends: nothing.

## Choosing scanners

- `scanners.disable` in `.openqodex.yaml` switches built-in scanners off.
- `--only` and `--skip` on `scan` and `review` pick scanners for one run.
- `custom-scanners` explains how to add any other scanner.
