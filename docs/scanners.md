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
