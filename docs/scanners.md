# Scanners

OpenQodex has thirteen built-in scanners. Each one runs only when the change holds a file it reads. Every downloaded scanner is pinned to one version. OpenQodex never uses a copy of a built-in scanner from your `PATH`.

Pinned versions do not make findings identical on every machine. semgrep fetches its registry rule packs at run time, and OpenQodex does not pin their version.

Every scanner reads the whole changed file. OpenQodex keeps only the findings on changed lines.

## Which scanners run, and why

One selector decides which scanners a set of files calls for, the same way for a review, a scan, `init`, `doctor --install` and the GitHub Action. A review and a scan ask it about the change. `init`, `doctor --install` and the Action ask it about every file of the repository (tracked files and untracked files git does not ignore), to download ahead what its reviews will need.

The selector looks at, in this order:

1. The config: a scanner in `scanners.disable` never runs or downloads, and a path in `review.paths.exclude` calls for nothing.
2. The file's name: its extension or basename, as each scanner below lists.
3. The file's project: the nearest folder, from the file's own up to the repository root, that holds a manifest (`package.json`, `Gemfile`, `Gemfile.lock`, `pyproject.toml`, `requirements*.txt`, `Pipfile`, `go.mod`, `Cargo.toml`, `pom.xml`, `build.gradle`, `build.gradle.kts` or `composer.json`). OpenQodex reads that project's dependency names from those files as text. It never runs, loads or evaluates them, reads only regular files inside the repository, never through a link, and none over 1 MB. A file in no project, or a project whose manifests say nothing, still gets every check its name calls for; it only gets no framework rules.
4. For a file with no extension, its first line: a `#!` line that names sh, bash, dash or ksh makes it a shell script. OpenQodex reads at most the first 256 bytes of such a file. For a `.yaml` or `.yml` file, its content: a line that starts with `apiVersion:` and one that starts with `kind:`, each with a value, in one document make it a Kubernetes object, unless the file holds `{{` (a Helm or Go template). OpenQodex reads at most the first 64 KB of such a file.
5. A reason the scanner must not run at all: `--offline` for semgrep, osv-scanner, kubeconform and cargo-deny.

What a project's dependencies switch on:

| Project | Read from | What changes |
|---|---|---|
| React or React Native | `react`, `react-native` or `expo` in `package.json` | oxlint runs its react and jsx-a11y rules on the project's files |
| Next.js | `next` in `package.json` | oxlint also runs its nextjs rules |
| Django, FastAPI, Airflow | `django`, `fastapi` or `apache-airflow` in `pyproject.toml` (its dependency lists), a `requirements*.txt` or a `Pipfile` | ruff adds its `DJ`, `FAST` or `AIR` rules |
| Rails | `rails` or `railties` in the folder's `Gemfile` or `Gemfile.lock`, and `config/application.rb` or `bin/rails` in that folder | brakeman runs, in that folder; rubocop loads its Rails cops |

`init` prints one line per scanner it downloads, saying why, such as `brakeman: Rails app in backend/` or `oxlint: JavaScript or TypeScript files, such as web/app/page.tsx; React, accessibility and Next.js rules in web/`. `init --dry-run` prints the same lines and downloads nothing. `doctor` prints them under "This repository needs", and the Action prints them in its plan step. A scan records the projects of the changed files and their frameworks in `scan.json`.

## Where scanners come from

Scanners download on first use into `~/.openqodex/tools/<scanner>/<version>/`. `OPENQODEX_HOME` moves that folder.

- GitHub release files are checked against the sha256 pinned in the package before they are unpacked.
- semgrep and bandit install from PyPI through uv, each into a Python 3.11 environment of its own, with one Python that OpenQodex manages. uv comes from your `PATH` when present. Otherwise OpenQodex downloads a pinned uv.
- brakeman and rubocop install from RubyGems with your Ruby's `gem` command.
- Each PyPI and RubyGems scanner installs from a lock file: `locks/<scanner>-<platform>.txt` in the package, with every package of the scanner's dependency tree at one version and with its sha256. Each file is checked against that sha256 before it is installed. semgrep and bandit get exactly the packages of their lock, each from its wheel, so no build script runs. RubyGems installs from the checked files, or keeps a gem Ruby itself ships when that one meets the requirement, and never fetches from the network. The install folder is `<version>-<the lock's sha256>`, so a lock whose pins moved installs afresh.

A scanner install that takes longer than 45 seconds keeps going in the background. The report lists that scanner as installing. The scanner joins the next run. `openqodex doctor --install` installs the scanners the repository's files call for and waits; `--all-scanners` installs every scanner.

Once a month a workflow in this repository (`.github/workflows/pin-bump.yml`) looks for a scanner release that is at least seven days old and newer than its pin. For each one it opens a pull request with the new pin, its sha256 or its new lock file, and the result of the gate run on it. A person merges it.

The workflow moves the kubeconform binary only. The schemas kubeconform validates against are pinned apart, in `toolchain.json` under `kubeconform.schemas`: one commit of `yannh/kubernetes-json-schema` and one Kubernetes version. Refresh them by hand when a new Kubernetes minor version is out: pick a commit of that repository that holds the version's `-standalone-strict` folder, set `commit` and `kubernetes` together, and run the kubeconform real-binary checks (`packages/scanners/test/adapters-kube-rust.subprocess.test.ts`). The schema cache is kept per commit, so a new commit downloads afresh.

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

Several scanners read settings or an ignore list from the repository, as OpenQodex runs them. At the repository root only: gitleaks `.gitleaks.toml`, `gitleaks.toml` and `.gitleaksignore`; semgrep `.semgrepignore`; hadolint `.hadolint.yaml` and `.hadolint.yml`; actionlint `.github/actionlint.yaml` and `.github/actionlint.yml`; zizmor `.github/zizmor.yml`, `.github/zizmor.yaml`, `zizmor.yml` and `zizmor.yaml`; squawk `.squawk.toml`. In any folder: ruff `ruff.toml` and `.ruff.toml`, and `pyproject.toml` when the change touches its `[tool.ruff` table; shellcheck `.shellcheckrc` and `shellcheckrc`; osv-scanner `osv-scanner.toml`; sqlfluff `.sqlfluff` and `.sqlfluffignore`; cargo-deny `deny.exceptions.toml` and `.deny.exceptions.toml`. A change to one of them can hide that scanner's findings.

In a review, each such changed file is a major candidate of that scanner, rule `settings-file`, on its first changed line; the reviewer verifies it and raises it or drops it with a reason. In a scan (`scan`, which the pre-commit hook and the Action run) nobody can clear it, so it is a minor finding and counts toward the verdict. The scanner still reads the changed file. `scanners.disable` leaves it out with its scanner. `--only` and `--skip` do not, since they pick scanners for one run and the file still silences the scanner in every other run. A changed settings file in a fixture folder is listed too: a config outside the folder can extend it (ruff's `extend`), so it can hide findings in code that is not a fixture.

## Suppression comments

A comment in the code can tell a scanner to skip a line, such as `# nosec` for bandit. The scanner obeys it and reports nothing there. So each such comment on a line the change adds is a candidate of the scanner it silences, rule `openqodex.suppression-added`, on that line. It is raised whether or not that scanner is installed, and only in a file that scanner checks. Its message names the comment and the scanner, never the rest of the line, which can hold a secret.

In a review, the reviewer verifies it and raises it or drops it with a reason. In a scan it is a minor finding and counts toward the verdict, so `block_on_severity: minor` blocks on it. The scanner still obeys the comment. A comment the change did not add raises nothing, and neither does `review --all`. `scanners.disable` leaves it out with its scanner; `--only` and `--skip` do not. `review.disabled_rules: ["*:openqodex.suppression-added"]` turns it off. A comment in a fixture file is left out like a scanner's finding there, unless `review.include_fixtures` is on: it only silences findings in its own file, which are left out too.

`review.severity_threshold` never hides an added suppression comment or a changed settings file, in a scan or as a finding the reviewer raised: since the scanner reports nothing there, the report always lists them.

A comment counts where its scanner reads it, and the match is never narrower than the scanner's. For the scanners that read only comments, OpenQodex finds the comments of the whole file first, so the same text inside a string, a multi-line string or a heredoc does not count. It reads the code inside an f-string field, a shell `$( )` or backticks (also inside double quotes and an unquoted heredoc) as code, as the scanners do. semgrep and gitleaks obey their marker anywhere on the line, in a string too, and so does OpenQodex. A string, heredoc, template, raw string or block comment left open at the end of the file is read as code, so it hides nothing after it. A Dockerfile heredoc opens only in `RUN`, `COPY` and `ADD`, as BuildKit reads it. A shell heredoc ends where shellcheck ends it: `<<"E\"OF"` at a line `E\"OF`, with blanks allowed after the word. A file over 1,000,000 bytes raises no semgrep candidate, since semgrep skips it; a file over 64 MB is not read at all. The readers take time in proportion to the file, whatever it holds.

| Scanner | Comment | Where it counts | Checked against |
|---|---|---|---|
| semgrep | `nosemgrep` or `nosem`, in any case | anywhere on the line | the 1.94.0 binary; [docs](https://docs.semgrep.dev/ignoring-files-folders-code) |
| gitleaks | `gitleaks:allow` | anywhere on the line | the 8.21.2 binary; [detect.go](https://github.com/gitleaks/gitleaks/blob/v8.21.2/detect/detect.go) |
| bandit | `# nosec`, with or without the space | anywhere in a Python comment | the 1.9.4 binary; [manager.py](https://github.com/PyCQA/bandit/blob/1.9.4/bandit/core/manager.py) |
| ruff | `# noqa` in any case; `# ruff: noqa` and `# flake8: noqa`; `isort: skip`, `isort: skip_file`, `# isort: off` | anywhere in a Python comment; `# ruff: noqa` and `# flake8: noqa` on a line of their own | the 0.8.4 binary; [noqa.rs](https://github.com/astral-sh/ruff/blob/0.8.4/crates/ruff_linter/src/noqa.rs), [directives.rs](https://github.com/astral-sh/ruff/blob/0.8.4/crates/ruff_linter/src/directives.rs) |
| shellcheck | `disable=` or `extended-analysis=false` anywhere after `# shellcheck` | a shell comment | the 0.10.0 binary; [Parser.hs](https://github.com/koalaman/shellcheck/blob/v0.10.0/src/ShellCheck/Parser.hs) |
| hadolint | `# hadolint ignore=`, `# hadolint global ignore=`, `# hadolint stage ignore=` | a Dockerfile comment line, also inside a continued instruction | the 2.15.1 binary; [Pragma.hs](https://github.com/hadolint/hadolint/blob/v2.15.1/src/Hadolint/Pragma.hs) |
| oxlint | `eslint-disable`, `oxlint-disable`, each also with `-line` or `-next-line` | the start of a `//` or `/* */` comment | the 1.86.0 binary; [disable_directives.rs](https://github.com/oxc-project/oxc/blob/oxlint_v1.86.0/crates/oxc_linter/src/disable_directives.rs) |
| golangci | `//nolint`; a comment that says `code generated`, `do not edit` or `autogenerated file` in any case; gosec's `#nosec` and `//gosec:disable` | a `//` comment for `//nolint`; a comment before the `package` line for the generated-file words, which skip the whole file; the start of a comment line for `#nosec` | source only: [nolint_filter.go](https://github.com/golangci/golangci-lint/blob/v2.12.2/pkg/result/processors/nolint_filter.go), [exclusion_generated_file_matcher.go](https://github.com/golangci/golangci-lint/blob/v2.12.2/pkg/result/processors/exclusion_generated_file_matcher.go), [gosec analyzer.go](https://github.com/securego/gosec/blob/v2.26.1/analyzer.go) |
| rubocop | `# rubocop:disable` and `# rubocop:todo` with a cop name or `all` | a Ruby comment, `=begin` blocks included | source only: [directive_comment.rb](https://github.com/rubocop/rubocop/blob/v1.69.2/lib/rubocop/directive_comment.rb) |
| zizmor | `# zizmor: ignore[` and a rule list, with one blank after the `#` and after the colon | anywhere on the line: zizmor reads each line of a finding from its first `#`, so for some of its audits it obeys the comment inside a `run:` block or a quoted value too | the 1.30.1 binary; [location.rs](https://github.com/zizmorcore/zizmor/blob/v1.30.1/crates/zizmor/src/finding/location.rs) |
| squawk | `squawk-ignore` and `squawk-ignore-file`, with a rule list or without; `squawk-disable-assume-in-transaction` | the start of a `--` or `/* */` comment, after blanks; never in a string, a dollar-quoted body or a quoted identifier. Block comments nest, as Postgres reads them | the 2.66.0 binary; [ignore.rs](https://github.com/sbdchd/squawk/blob/v2.66.0/crates/squawk_linter/src/ignore.rs) |
| kube-linter | the annotation keys `ignore-check.kube-linter.io/<check>` and `kube-linter.io/ignore-all` | a key of a YAML or JSON mapping, in block or flow style, quoted or with escapes, and a key an alias or a merge key brings in (counted on the alias's line); never in a comment or a value. A file the YAML parser cannot read, or one over 4 MB, is read line by line instead | the 0.8.3 binary; [ignore.go](https://github.com/stackrox/kube-linter/blob/v0.8.3/pkg/ignore/ignore.go) |
| sqlfluff | `noqa`, `noqa:` with rules, `noqa: disable=` and `noqa: enable=` | anywhere on the line after `--`, `#` or `/*`, and at the start of a line: SQLFluff reads it at the start of a comment or after the comment's last `--`, and which text is a comment depends on the dialect | the 4.3.0 binary; [noqa.py](https://github.com/sqlfluff/sqlfluff/blob/4.3.0/src/sqlfluff/core/rules/noqa.py) |

Where OpenQodex is wider than the scanner, it errs towards a candidate the reviewer drops: semgrep's marker also counts without the space before it and in any comment form, ruff's `# isort: off` with extra blanks, a `disable=` inside a quoted value or a trailing note of a shellcheck directive, a hadolint or rubocop comment whose rule list the scanner would reject, a `# ruff: noqa` or generated-file comment the scanner reads differently, the text of JSX or a Ruby `__END__` block read as code, and everything after an opener left open. hadolint 2.15.1 cannot parse a Dockerfile with a heredoc at all and reports only a parse error, so its comments there are moot.

actionlint, brakeman, osv-scanner, sqllint, kubeconform and cargo-deny have no inline comment. actionlint ([usage](https://github.com/rhysd/actionlint/blob/v1.7.7/docs/usage.md)) and osv-scanner ([configuration](https://google.github.io/osv-scanner/configuration/)) skip findings only through their settings files; brakeman ([ignoring false positives](https://brakemanscanner.org/docs/ignoring_false_positives/)) only through its ignore file; cargo-deny ([configuration](https://embarkstudios.github.io/cargo-deny/checks/cfg.html)) only through its `deny.toml`, which OpenQodex does not load; kubeconform skips only what its command line names.

The comments are found by a small reader per comment family, not a full parser. Where it cannot tell a regular expression from a division (Ruby `total /2`, JavaScript `} / 2`), it also reads a comment that starts in the skipped text. On a rare line it can still read less than the scanner: in shell, a `case` pattern inside `$( )` ends it early; in Ruby, `buf <<"x"` that appends a string is read as a heredoc. An unchanged comment that silences lines the change adds, such as an `eslint-disable-next-line` above a new line or a file-level `# ruff: noqa`, raises nothing.

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
- In a Django, FastAPI or Airflow project it adds ruff's `DJ`, `FAST` or `AIR` rules with `--extend-select`, on top of the repo's own selection. ruff applies a command-line selection after the repo's settings, so an `ignore` there does not take these rules off again; a `# noqa`, `per-file-ignores` and `review.disabled_rules` (such as `ruff:DJ001`) do.
- Sends: nothing.

## oxlint

- Version: 1.86.0.
- Runs when: a `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`, `.mts` or `.cts` file changed.
- Needs: nothing. 5.3 MB on Apple Silicon, 6.1 MB on Linux x64.
- Uses OpenQodex's own settings. A config file in the repo is not loaded.
- In a React or React Native project it switches on oxlint's own react and jsx-a11y rules, and in a Next.js project its nextjs rules too. They are built into the binary. Where oxlint ran its react rules on every changed file, the review pattern for an incomplete `useEffect` dependency list is not handed to the reviewer: oxlint checks it (`react-hooks/exhaustive-deps`).
- Sends: nothing.

## osv-scanner

- Version: 2.6.0.
- Runs when: one of these lockfiles changed: `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, `Pipfile.lock`, `poetry.lock`, `pdm.lock`, `uv.lock`, `pylock.toml`, a `.txt` file with `requirements` in its name, `Gemfile.lock`, `gems.locked`, `composer.lock`, `Cargo.lock`, `go.mod`, `pom.xml`, `gradle.lockfile`, `buildscript-gradle.lockfile`, `gradle/verification-metadata.xml`, `packages.lock.json`, `packages.config`, `<name>.deps.json`, `pubspec.lock`, `mix.lock`, `conan.lock`, `renv.lock`, `cabal.project.freeze`, `stack.yaml.lock`. Not `go.sum` or `package.json`: osv-scanner reads neither, and their change lands in `go.mod` or the lockfile beside them.
- Needs: network access to osv.dev. 52.6 MB on Apple Silicon, 54.9 MB on Linux x64.
- Sends: the names and versions of the dependencies in those lockfiles, to osv.dev. It never sends code. Its other lookups are switched off: no transitive resolution of a `pom.xml` through deps.dev (`--no-resolve`), no file hashes of vendored C and C++ code (`--experimental-disable-plugins directory`), no reachability analysis (`--no-call-analysis all`).
- Advisories that osv-scanner groups as aliases of one another are one finding, under the group's RustSec id when it has one, otherwise its first id.
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
- Runs when: a `.sh` or `.bash` file changed, or a file with no extension whose first line (`#!`) names sh, bash, dash or ksh, such as `bin/deploy` starting `#!/usr/bin/env bash`.
- Needs: `xz` to unpack the download. 7.2 MB on Apple Silicon, 2.4 MB on Linux x64.
- Sends: nothing.

## golangci-lint

- Version: 2.12.2. Its name in `.openqodex/config.yaml` is `golangci`.
- Runs when: a `.go` file changed. It checks the packages that hold the changed files.
- Needs: Go on your `PATH`. 14.4 MB on Apple Silicon, 15.0 MB on Linux x64.
- Uses OpenQodex's own settings, with gosec switched on. A `.golangci.yml` in the repo is not loaded. It never rewrites `go.mod` or `go.sum`.
- golangci-lint 2.12.2 is built with Go 1.26. With a newer Go on your PATH it cannot check the code. The report then lists golangci as failed, with the reason.
- Runs with the Go module proxy off. The modules the repo needs must already be in your Go module cache. Nothing is downloaded.
- Sends: nothing.

## brakeman

- Version: 6.2.1.
- Runs when: a Ruby or Rails file changed inside a Rails app: a folder whose `Gemfile` or `Gemfile.lock` names `rails` or `railties` and that holds `config/application.rb` or `bin/rails`. The files are `.rb`, `.rake`, `.gemspec`, `.erb`, `.haml`, `.slim`, `Gemfile`, `Rakefile` and `config.ru`. A `Gemfile` and an `app/` folder alone prove nothing: a React Native app with Expo Router has both.
- Runs in the Rails app's folder, wherever it sits in the repository, once per app the change touches. Its paths are rebased onto the repository root.
- Needs: Ruby 3.0 or newer. It installs from RubyGems.
- Uses OpenQodex's own settings. The repo's brakeman config is not loaded.
- Sends: nothing.
- Licence: the Brakeman Public Use License, which is not an open source licence. OpenQodex does not bundle brakeman. It downloads brakeman at run time onto your machine. Read the licence before you use it, or switch it off with `scanners.disable: [brakeman]`.

## rubocop

- Version: 1.69.2, with rubocop-rails 2.28.0 and rubocop-performance 1.23.0.
- Runs when: a `.rb`, `.rake` or `.gemspec` file or a `Rakefile` changed. Not a `Gemfile` alone: it declares gems, and the cops written for it are outside the Lint, Security and Performance cops OpenQodex keeps.
- Loads the Rails cops only for a file in a Rails app (see brakeman).
- Needs: Ruby 2.7 or newer. It installs from RubyGems.
- Uses OpenQodex's own settings. A `.rubocop.yml` in the repo is not loaded, because it can load Ruby code.
- Sends: nothing.

## sqllint

- Version: part of OpenQodex.
- Runs when: a `.sql` file changed.
- Needs: nothing. It runs inside OpenQodex and downloads nothing.
- Checks Postgres migrations for common mistakes, such as a privileged function left callable by every role.
- Sends: nothing.

## zizmor

- Version: 1.30.1.
- Runs when: a GitHub workflow changed (a `.yml` or `.yaml` file directly under `.github/workflows/`, the files actionlint checks), an action's metadata file changed (`action.yml` or `action.yaml`, in any folder), or `.github/dependabot.yml` or `.github/dependabot.yaml` changed.
- Needs: nothing. 8.4 MB on Apple Silicon, 9.2 MB on Linux x64.
- Finds security problems in those files: text an attacker controls expanded into a script (template injection), dangerous triggers such as `pull_request_target`, actions not pinned to a commit, credentials left in the checkout, default permissions, and Dependabot updates that run a dependency's code.
- Runs offline (`--offline`): the audits that ask the GitHub API do not run, and no GitHub token reaches it.
- Reads the repo's zizmor settings: the first of `.github/zizmor.yml`, `.github/zizmor.yaml`, `zizmor.yml` and `zizmor.yaml` at the repository root. They hold rule settings only: a rule switched off, ignore entries, allow lists and severity changes. A zizmor settings file anywhere else is not read.
- Severity: zizmor's own. A finding zizmor reports with low confidence ranks one step lower.
- Sends: nothing.
- Licence: MIT ([LICENSE](https://github.com/zizmorcore/zizmor/blob/v1.30.1/LICENSE)).

## trivy

- PLACEHOLDER trivy: the builder of this scanner replaces this line.

## squawk

- Version: 2.66.0.
- Runs when: a `.sql` file changed, the files sqllint checks.
- Needs: nothing. 16.9 MB on Apple Silicon, 25.7 MB on Linux x64.
- Finds Postgres migration steps that lock or rewrite a busy table, or lose data: an index built without `CONCURRENTLY`, a constraint or foreign key added without `NOT VALID`, a `NOT NULL` column with no default, a column type change, a dropped or renamed column or table.
- Severity: its rules that ask for a habit rank low: `IF NOT EXISTS`, lock and statement timeouts, `bigint`, `text`, `timestamptz` and identity columns. The rest rank medium.
- Reads the repo's `.squawk.toml` at the repository root: rules left out or added, paths left out, the Postgres version, and whether a transaction wraps each file. A `.squawk.toml` anywhere else is not read.
- Sends: nothing. OpenQodex never runs its `upload-to-github` command.
- Licence: Apache-2.0 or MIT, at your choice ([LICENSE-APACHE](https://github.com/sbdchd/squawk/blob/v2.66.0/LICENSE-APACHE), [LICENSE-MIT](https://github.com/sbdchd/squawk/blob/v2.66.0/LICENSE-MIT)).

## kube-linter

- Version: 0.8.3.
- Runs when: a `.yaml` or `.yml` file that holds a Kubernetes object changed (see "Which scanners run, and why").
- Needs: nothing. 15.3 MB on Apple Silicon, 16.5 MB on Linux x64.
- Finds workload and access risks in each object: a privileged container or one that can gain privileges, host network, PID or IPC namespaces, the Docker socket or another sensitive host path mounted, a writable host mount, unsafe sysctls or proc mounts, a cluster-admin role binding, a `*` in an RBAC rule, a container that may run as root or with a writable root file system, `NET_RAW` kept, a secret in an environment variable, the `latest` image tag, an SSH port exposed, a probe on a port the container does not open, an invalid port name, a selector that does not match its pods, and CPU or memory left unset.
- Runs kube-linter's default checks less the two that need objects from other files (`dangling-service`, `non-existent-service-account`: OpenQodex passes only the changed files), plus `wildcard-in-rules`, `cluster-admin-role-binding`, `writable-host-mount` and `unsafe-proc-mount`.
- Severity: the privilege, host mount, host namespace, sysctl and RBAC checks rank high. Running as root, a writable root file system, `NET_RAW`, a secret or duplicate in the environment, the `latest` tag, the port checks, a selector mismatch and a removed API version rank medium. CPU and memory, anti-affinity, disruption budgets, a Job's time to live and the deprecated `serviceAccount` field rank low.
- Anchors each finding on the line of the field its check is about, read from the manifest by a YAML parser, since kube-linter reports an object and never a line. A field the object lacks anchors on the nearest field it has.
- Uses OpenQodex's own settings. A `.kube-linter.yaml` in the repo is not loaded: a custom check there can download schemas from any address and write a folder anywhere.
- Obeys the ignore annotations on an object; see "Suppression comments".
- Sends: nothing.
- Licence: Apache-2.0 ([LICENSE](https://github.com/stackrox/kube-linter/blob/v0.8.3/LICENSE)).

## tflint

- PLACEHOLDER tflint: the builder of this scanner replaces this line.

## kubeconform

- Version: 0.8.0.
- Runs when: a `.yaml` or `.yml` file that holds a Kubernetes object changed, the files kube-linter checks.
- Needs: network access to raw.githubusercontent.com for schemas. 7.3 MB on Apple Silicon, 7.5 MB on Linux x64.
- Finds an object the Kubernetes API would refuse: a field the API does not have (a misspelling, or a field at the wrong level), a value of the wrong type, a required field missing, a value outside its allowed list. A file that does not read as Kubernetes objects is one finding over the whole file.
- Validates in strict mode against the JSON schemas of Kubernetes 1.37.1 from one commit of [yannh/kubernetes-json-schema](https://github.com/yannh/kubernetes-json-schema), both pinned in `toolchain.json`. A kind with no schema there, such as a custom resource, is skipped.
- Severity: a wrong type, a missing required field, a value outside its list and a file that does not read rank high; a field the API does not have ranks medium.
- Anchors each error on the line of its field, as for kube-linter.
- Reads no settings file.
- Sends: a request for each kind's schema file, such as `deployment-apps-v1.json`, to raw.githubusercontent.com, so the requests name the kinds you use. It never sends a manifest. Schemas are cached under `~/.openqodex/cache/kubeconform/<commit>/`, so each kind is fetched once.
- `--offline` skips it. The report lists it as disabled.
- Licence: Apache-2.0 ([LICENSE](https://github.com/yannh/kubeconform/blob/v0.8.0/LICENSE)); the schemas are Apache-2.0 too.

## cargo-deny

- Version: 0.20.2.
- Runs when: a `Cargo.lock` changed. A `Cargo.lock` with no `Cargo.toml` beside it is named in the reason and not checked.
- Needs: your Rust toolchain's Cargo, and the project's crates already in your Cargo cache, as after one `cargo build` or `cargo fetch`. OpenQodex does not install Rust and never downloads crates; a crate missing from the cache is named in the reason, with the `cargo fetch` to run. Network access to github.com for the RustSec advisory database. 4.5 MB on Apple Silicon, 4.9 MB on Linux x64.
- Finds, from the [RustSec advisory database](https://rustsec.org): a crate version with a known vulnerability, unsound code or no maintainer, and a crate from a git repository or a registry other than crates.io. Not licences and not banned crates.
- Severity: a vulnerability ranks high; unsound code and a crate source other than crates.io rank medium; an unmaintained crate, an informational notice and a git source with no commit named rank low.
- Anchors each finding on the crate's entry in `Cargo.lock`, from its `name` line to its `version` line. osv-scanner reports the same advisory on the same lines: the report keeps one, the higher severity, and names the other scanner.
- Uses OpenQodex's own settings. The repo's `deny.toml` is not loaded: it can name advisory database addresses and a database folder anywhere. Cargo runs from a folder outside the repository, with your toolchain named by its real files, so the repo's `.cargo/config.toml` (a rustc wrapper, a source replacement) and `rust-toolchain.toml` are never read and no toolchain is installed. Cargo runs offline and never rewrites `Cargo.lock`.
- Reads `deny.exceptions.toml` or `.deny.exceptions.toml` beside the project or above it. It holds licence exceptions only, which OpenQodex does not check, but a broken one stops cargo-deny.
- Sends: nothing about your code or your crates. It fetches the RustSec advisory database from github.com into `~/.openqodex/cache/cargo-deny/`.
- `--offline` skips it. The report lists it as disabled.
- Licence: MIT or Apache-2.0, at your choice ([LICENSE-MIT](https://github.com/EmbarkStudios/cargo-deny/blob/0.20.2/LICENSE-MIT), [LICENSE-APACHE](https://github.com/EmbarkStudios/cargo-deny/blob/0.20.2/LICENSE-APACHE)).

## checkov

- PLACEHOLDER checkov: the builder of this scanner replaces this line.

## sqlfluff

- Version: 4.3.0.
- Runs when: a `.sql` file changed, the files sqllint checks.
- Needs: Python 3.11, which OpenQodex downloads through uv, as for semgrep and bandit. About 4.6 MB of packages on Apple Silicon, 6.0 MB on Linux x64.
- Finds queries that return a wrong result or hold dead code: a comparison with `NULL` by `=` (CV05), a set query whose sides return different numbers of columns (AM07), a join with no condition (AM08), a reference to a table that is not in `FROM` (RF01), a table alias used twice (AL04), a column alias used twice (AL08), a CTE never used (ST03), an outer-joined table never used (ST11). Only these rules run, whatever the repo's settings select: SQLFluff's layout, capitalisation and quoting rules fire on almost every line of hand-written SQL.
- Severity: CV05, AM07, AM08, RF01 and AL04 rank medium; AL08, ST03 and ST11 rank low; a rule the repo's settings list under `warnings` ranks info.
- Reads SQLFluff's settings as SQLFluff finds them, in the folder of each changed file and the folders above it: `.sqlfluff`, the `[sqlfluff` sections of `setup.cfg`, `tox.ini`, `pep8.ini` and `pyproject.toml`, and `.sqlfluffignore`. They choose the dialect, the rules left out and the rules that only warn. Where none names a dialect, it reads the file as `postgres`. Your own SQLFluff settings folder (`~/Library/Application Support/sqlfluff` or `~/.config/sqlfluff`) is not read.
- Never runs code from the repo: it always uses SQLFluff's raw templater with no library path, whatever the settings name, so a Jinja macro library or a dbt project is never loaded. Jinja and dbt templates are not expanded.
- A statement it cannot parse in the dialect is not checked, and its parse error is not reported. A file over 20,000 bytes is skipped, as SQLFluff does unless its settings raise the limit.
- Sends: nothing.
- Licence: MIT ([LICENSE.md](https://github.com/sqlfluff/sqlfluff/blob/4.3.0/LICENSE.md)).

## Choosing scanners

- `scanners.disable` in `.openqodex/config.yaml` switches built-in scanners off.
- `--only` and `--skip` on `scan` and `review` pick scanners for one run.
- `custom-scanners` explains how to add any other scanner.
