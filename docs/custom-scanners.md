# Custom scanners

You or your agent can configure a compatible scanner from GitHub. Then you approve it before it runs. Its findings join the same report as the built-in scanners. OpenQodex keeps only the findings on changed lines.

A custom scanner is a command that runs on your machine with your permissions. Only `openqodex trust` downloads a custom scanner, and it asks you first. `scan` and `review` never download one. Nothing is installed or run before you approve that exact entry.

## What makes a scanner compatible

- It writes SARIF, a standard JSON format for scanner results. Or it writes one JSON document, which a `map` block turns into findings. OpenQodex cannot read plain text, HTML or JSON Lines.
- It installs in one of these ways: a file of its GitHub release for your system and CPU, an exact npm version, an exact PyPI version, or a program on your `PATH`.
- It runs only where you approved it. The approval lives in your home folder, so the GitHub Action never runs it on a GitHub-hosted runner.

## Add one

Add an entry to `.openqodex/config.yaml` in your repository. This entry adds Bearer CLI, which writes SARIF:

```yaml
scanners:
  custom:
    - source: https://github.com/Bearer/bearer
      run: bearer scan {target} --format sarif --output {report} --quiet --disable-version-check
      target: repo
```

- `source`: the scanner's GitHub repository.
- `run`: the command line. OpenQodex splits it into words and starts the first word as the program. It never uses a shell.

Three placeholders are filled in:

- `{report}`: the file the scanner writes its report to. With no `{report}` in `run`, OpenQodex reads the report from the scanner's standard output.
- `{target}`: the changed files, or the repository root when `target: repo` is set.
- `{repo}`: the repository root.

`config` lists every optional key: `name`, `version`, `format`, `map`, `paths`, `target`, `timeout_seconds` and `install`.

Bearer CLI is under the Elastic License 2.0, which is not an open source licence. Check the licence of any scanner you add.

## Add one through your agent

Say to your agent: "add https://github.com/Bearer/bearer to OpenQodex as a custom scanner". The agent reads the scanner's README for its SARIF or JSON flag. It writes the entry in `.openqodex/config.yaml`. The openqodex skill tells it never to run `openqodex trust` without asking you first. After you approve the entry, the agent runs `~/.openqodex/bin/openqodex scan --only custom:<name>` and tells you what it found.

`for-agents` gives agents the same steps.

## Approve it

```
npx openqodex trust
```

For each entry that is new or changed, `trust` does these steps:

1. It reads the release from the GitHub API. Without `version`, it takes the latest release.
2. It picks the release asset for your system and CPU.
3. It downloads the asset to a quarantine folder. Nothing is unpacked onto the tool path or run yet.
4. It checks the asset against the project's checksum file, when the project publishes one.
5. It prints what will run and asks yes or no.

The printout shows the name, source, version, install form, asset, download URL and sha256. It also shows the checksum check, the program path, the run line, the paths and the target. Read it before you answer.

On yes, the asset is installed and the approval is stored. On no, the scanner is skipped until you approve it.

## How the asset is chosen

OpenQodex matches words in each asset's file name:

- system: `darwin`, `macos`, `osx`, `apple` or `linux`;
- CPU: `arm64`, `aarch64`, `x86_64`, `amd64`, `x64` or `64bit`;
- format: `.tar.gz`, `.tar.xz`, `.zip`, or a bare program.

When no asset matches, or more than one does, `trust` stops. It prints the candidates and the line to add. Name the asset by hand. `{version}`, `{os}` and `{arch}` stand for the version and the name words above, so one line fits every machine:

```yaml
    - source: https://github.com/Bearer/bearer
      run: bearer scan {target} --format sarif --output {report} --quiet --disable-version-check
      target: repo
      install:
        asset: "bearer_{version}_{os}_{arch}.tar.gz"
```

The name must match exactly one asset.

Other install forms:

- `install: path`: use the program on your `PATH`. Nothing is downloaded. `trust` records the program's sha256. When the program changes, the scanner is skipped until you approve it again.
- `install: { npm: <package@1.2.3> }`: install from npm. The spec must name an exact version.
- `install: { uv: <package==1.2.3> }`: install from PyPI through uv. The spec must name an exact version.

## What the stored hash means

`trust` records the sha256 of the asset it downloaded.

When the project publishes a checksum file and the asset matched it, that hash was checked against upstream. Otherwise the stored hash is only the hash of your first download. This is trust on first use: it does not prove the first download was genuine. The printout says which of the two applies.

## Where approvals are stored

Approvals live in `~/.openqodex/trust.json`. Each one is keyed by the repository root and a hash of the entry and the resolved asset. An approval in one repository does not cover another.

Any edit to the entry changes its hash. The scanner is then skipped as `untrusted` until you run `openqodex trust` again.

- `openqodex trust --list` shows each custom scanner and its state.
- `openqodex trust --revoke <name>` removes one approval.
- `openqodex doctor` shows the state of each custom scanner too.

## Report formats

### SARIF

SARIF is a standard JSON format for scanner results. Many scanners write it with a flag. It is the default `format`.

OpenQodex reads each result's rule id, file, start and end line, and message. The severity comes from a `security-severity` score. A score on the result wins over a score on its rule:

- 9 or more: critical
- 7 or more: high
- 4 or more: medium
- above 0: low
- 0: info

Without a score, the SARIF level decides: `error` is high, `warning` is medium, `note` is low, `none` is info. Anything else is medium.

### Worked example: Bearer CLI with SARIF

Bearer CLI checks code for security and privacy problems, such as a weak hash.

```yaml
scanners:
  custom:
    - source: https://github.com/Bearer/bearer
      run: bearer scan {target} --format sarif --output {report} --quiet --disable-version-check
      target: repo
```

- `target: repo` passes the repository root, because `bearer scan` scans a folder.
- `--disable-version-check` stops Bearer from asking for a newer release. Check what any scanner you add sends before you approve it.
- `--quiet` keeps its progress messages short.
- Findings appear in the report as `custom:bearer:<rule id>`, such as `custom:bearer:javascript_lang_weak_hash_md5`.

On 2026-10-12, on an Apple Silicon Mac, `trust` picked `bearer_2.1.1_darwin_arm64.tar.gz` and checked it against the project's checksum file. A scan of the demo repository with a changed JavaScript file that used MD5 reported that rule on the changed line.

### json-map

For a scanner that cannot write SARIF, `json-map` reads its JSON report through a `map` block. Each value is a dotted path into the report, with `[n]` for a list index. `items` points at the list of results. The other paths are read from each result.

### Worked example: gosec with json-map

gosec checks Go code for security problems. Its JSON report looks like this:

```json
{
  "Issues": [
    { "severity": "HIGH", "rule_id": "G101", "details": "Potential hardcoded credentials",
      "file": "/home/me/app/config.go", "line": "12" }
  ]
}
```

The entry:

```yaml
scanners:
  custom:
    - source: https://github.com/securego/gosec
      run: gosec -fmt json -out {report} -no-fail {repo}/...
      paths: ["**/*.go", "*.go"]
      format: json-map
      map:
        items: Issues
        file: file
        line: line
        rule: rule_id
        severity: severity
        message: details
        severity_map:
          HIGH: high
          MEDIUM: medium
          LOW: low
```

- `items: Issues` points at the list.
- `file` may be absolute. OpenQodex turns a path inside the repository into a repository path.
- `line` may be a number or a string of digits. A result without a file or a line is skipped.
- `severity_map` turns gosec's words into the scanner scale. A word not in the map reads as medium.
- `-no-fail` keeps gosec from exiting with an error when it finds something.
