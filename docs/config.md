# Configuration

OpenQodex reads `.openqodex.yaml` at the root of the repository. Every key is optional. With no file, the defaults apply, and OpenQodex warns but never blocks.

`--config <path>` reads another file instead.

An unknown key prints a warning and is ignored. A value of the wrong type stops the run with exit 2 and names the key.

## A full example

```yaml
version: 1
review:
  block_on_severity: critical
  paths:
    exclude: ["vendor/**", "**/*.min.js", "*.min.js"]
  disabled_rules: ["gitleaks:generic-api-key", "lens:react-*"]
  include_fixtures: false
scanners:
  disable: [brakeman]
  custom:
    - source: https://github.com/aquasecurity/trivy
      run: trivy config --format sarif --output {report} {target}
```

## Severity

OpenQodex uses one scale: `critical`, `major`, `minor`, `nitpick`, `info`. Scanner severities map onto it:

- critical to `critical`
- high to `major`
- medium to `minor`
- low to `nitpick`
- info to `info`

## version

`1`, the only version. Optional.

## review.block_on_severity

One of `critical`, `major`, `minor`, `nitpick`, `info`. The default is unset.

- Unset: OpenQodex warns and never blocks. No command exits 1. The push gate never denies a push.
- Set: the verdict is `blocked` when a finding on a changed line is at or above this severity. `scan` and `review` exit 1. The push gate denies a push unless a finished review of the current change passed.

Findings outside the changed lines never count toward the verdict.

## review.paths.exclude

A list of globs. The default is an empty list. A matching file is left out of the change. The brief does not show it, and no finding in it is kept. Scanners do not receive it as a changed file. A scanner that reads a whole project, such as brakeman or golangci-lint, may still read it.

Globs match the path from the repository root, with forward slashes:

- `*` matches any characters except `/`.
- `**` matches any characters, `/` included.
- `?` matches one character except `/`.

There is no negation and no character class.

A `**/` prefix does not match a file at the repository root. `**/*.min.js` matches `web/app.min.js` but not `app.min.js`. To match both, list `**/*.min.js` and `*.min.js`.

## review.disabled_rules

A list of globs matched against a finding's citation, `<source>:<rule>`. A matching finding is dropped. The default is an empty list.

- `gitleaks:generic-api-key` drops one gitleaks rule.
- `semgrep:python.lang.*` drops a family of semgrep rules.
- `lens:react-*` drops agent findings that cite a review pattern whose name starts with `react-`.
- `custom:trivy:*` drops every finding of the custom scanner named `trivy`.

## review.include_fixtures

`true` or `false`. The default is `false`.

With `false`, scanner findings in test fixtures, mocks, stubs, fakes and snapshots are dropped. A path counts when one of its folders is `fixtures`, `__fixtures__`, `mocks`, `__mocks__`, `snapshots`, `__snapshots__`, `fakes`, `stubs` or `testdata`. It also counts when the file name holds `.fixture.`, `.mock.` or `.stub.` (or their plurals), or ends in `.snap`. Test files themselves are not dropped.

## scanners.disable

A list of built-in scanner names to switch off. The names are `semgrep`, `gitleaks`, `sqllint`, `osv-scanner`, `actionlint`, `hadolint`, `shellcheck`, `ruff`, `brakeman`, `rubocop`, `bandit`, `oxlint` and `golangci`. A disabled scanner is listed in the report as disabled.

## scanners.custom

A list of custom scanners. Each one needs two keys:

```yaml
scanners:
  custom:
    - source: https://github.com/aquasecurity/trivy
      run: trivy config --format sarif --output {report} {target}
```

A custom scanner never runs until you approve it with `openqodex trust`. `custom-scanners` explains the step.

### source

The GitHub link of the scanner's repository, `https://github.com/<owner>/<repo>`. Required.

### run

The command line. Required. OpenQodex splits it into words and starts the first word as the program. It never runs the line through a shell, so pipes, `&&` and `$VAR` have no effect.

Three placeholders are filled in:

- `{report}`: the file the scanner writes its report to.
- `{target}`: the files to scan. See `target`.
- `{repo}`: the repository root.

### name

The scanner's name in the report, as `custom:<name>`. The default is the repository name from `source`. Letters, digits, dot, dash and underscore only. Two entries cannot share a name.

### version

The release to use, such as `0.58.1`. The default is the latest release at the time you run `openqodex trust`.

### format

`sarif` or `json-map`. The default is `sarif`. `json-map` reads any JSON report through a `map` block.

### map

Required when `format` is `json-map`. Each value is a dotted path into the report, with `[n]` for a list index.

- `items`: the path to the list of results. `.` means the report itself is the list. Required.
- `file`: the file path in one result. Required.
- `line`: the start line. Required.
- `end_line`: the end line. Optional.
- `rule`: the rule id. Required.
- `severity`: the scanner's severity. Optional.
- `message`: the message. Required.
- `reference`: a link for the rule. Optional.
- `severity_map`: maps the scanner's severity words to `critical`, `high`, `medium`, `low` or `info`. A word not in the map reads as `medium`.

`custom-scanners` has a worked example.

### paths

A list of globs. The scanner runs only when a changed file matches one, and receives only matching files. The default is every changed file.

### target

`changed` or `repo`. The default is `changed`.

- `changed`: `{target}` is the changed files.
- `repo`: `{target}` is the repository root.

Either way, only findings on changed lines are kept.

### timeout_seconds

A whole number of seconds. The default is `120`.

### install

How OpenQodex gets the scanner. The default downloads the GitHub release asset that fits your machine. Use one of these forms instead:

- `install: path`: use the program already on your `PATH`. Nothing is downloaded.
- `install: { asset: <name> }`: the release asset to download, when OpenQodex cannot pick one.
- `install: { binary: <path> }`: the program's path inside the asset, when it is not at the top.
- `install: { sha256: <hex> }`: the expected sha256 of the asset, in lowercase hex.
- `install: { npm: <package@version> }`: install the scanner from npm.
- `install: { uv: <package==version> }`: install the scanner from PyPI through uv.

`asset`, `binary` and `sha256` combine. `npm` and `uv` stand alone.
