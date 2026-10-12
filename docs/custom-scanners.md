# Custom scanners

You or your agent can configure a compatible scanner from GitHub. Then you approve it before it runs.

A finding is one problem at one place in the code, with a severity. A custom scanner's findings join the same report as the built-in scanners' findings. OpenQodex keeps the findings on changed lines. It drops findings in test fixtures and in rules you switched off.

A custom scanner is a command that runs on your machine with your permissions. `scan` and `review` never download or install a custom scanner. Only `openqodex trust` does that. OpenQodex runs a custom scanner only after you approve its exact entry.

## What makes a scanner compatible

- It writes SARIF, a standard JSON format for scanner results. Or it writes one JSON document, which a `map` block turns into findings.
- OpenQodex cannot read plain text, HTML or JSON Lines.
- It installs in one of four ways:
  - a release asset for your system and CPU;
  - an exact npm version;
  - an exact PyPI version;
  - a program on your `PATH`.
- OpenQodex runs it only when `~/.openqodex/trust.json` on that machine holds your approval of that exact entry. A fresh GitHub-hosted runner holds none, so the GitHub Action skips it there.

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
- `run`: the command line. OpenQodex splits it into words. It starts the first word as the program. It uses no shell.

OpenQodex fills in three placeholders:

- `{report}`: the file that the scanner writes its report to. With no `{report}` in `run`, OpenQodex reads the report from the scanner's standard output.
- `{target}`: by default, the changed files. With `target: repo`, the repository root.
- `{repo}`: the repository root.

`config` lists the optional keys: `name`, `version`, `format`, `map`, `paths`, `target`, `timeout_seconds` and `install`.

Bearer CLI is under the Elastic License 2.0, which is not an open source licence. Check the licence of each scanner you add.

## Add one through your agent

Say to your agent: "add https://github.com/Bearer/bearer to OpenQodex as a custom scanner".

1. The agent reads the scanner's README for its SARIF or JSON flag.
2. The agent writes the entry in `.openqodex/config.yaml`.
3. The agent asks you to approve the entry. The openqodex skill tells it never to run `openqodex trust` without asking you first.
4. After your approval, the agent runs `~/.openqodex/bin/openqodex scan --only custom:<name>`. Then it tells you what the scanner found.

`for-agents` gives agents the same steps.

## Approve it

```
npx openqodex trust
```

`trust` handles each entry that is new or changed since your last approval. What it does depends on the install form.

For a release asset, the default form:

1. `trust` reads the release from the GitHub API. Without `version`, it takes the latest release.
2. It picks the release asset for your system and CPU.
3. It downloads the asset into a quarantine folder. It does not unpack the asset onto the tool path, and it does not run it.
4. It checks the asset against the project's checksum file, when the project publishes one.
5. It prints what will run. Then it asks yes or no.

For `install: path`, `trust` downloads nothing. It records the sha256 of the program on your `PATH`, prints what will run, and asks.

For `install: { npm: ... }` or `install: { uv: ... }`, `trust` downloads nothing before it asks. It installs the exact version only after your yes.

The printout shows the name, the source, the version and the install form. It shows the asset, the download URL and the sha256. It also shows the checksum check, the program path, the run line, the paths and the target. Read it before you answer.

On yes, `trust` installs the scanner and stores your approval. On no, OpenQodex skips the scanner until you approve it.

## How trust picks a release asset

`trust` matches words in the file name of each release asset:

- system: `darwin`, `macos`, `osx`, `apple` or `linux`;
- CPU: `arm64`, `aarch64`, `x86_64`, `amd64`, `x64` or `64bit`;
- format: `.tar.gz`, `.tar.xz`, `.zip`, or a bare program.

When no release asset matches, `trust` stops. When more than one matches, `trust` also stops. It prints the matching release assets and the line to add.

Name the release asset by hand. `{version}` stands for the version. `{os}` and `{arch}` stand for the system and CPU words above. So one line fits each supported system: macOS and Linux, on arm64 and x64.

```yaml
    - source: https://github.com/Bearer/bearer
      run: bearer scan {target} --format sarif --output {report} --quiet --disable-version-check
      target: repo
      install:
        asset: "bearer_{version}_{os}_{arch}.tar.gz"
```

The name must match exactly one release asset.

The other install forms:

- `install: path`: OpenQodex uses the program on your `PATH`. When that program changes, OpenQodex skips the scanner until you approve it again.
- `install: { npm: <package@1.2.3> }`: OpenQodex installs from npm. The spec must name an exact version.
- `install: { uv: <package==1.2.3> }`: OpenQodex installs from PyPI through uv. The spec must name an exact version.

## What the stored hash means

`trust` records the sha256 of the release asset it downloaded.

Some projects publish a checksum file. When the release asset matched it, `trust` checked the hash against upstream. Otherwise, the stored hash is only the hash of your first download. This is trust on first use: it does not prove that the first download was genuine. The printout says which of the two applies.

## Where approvals are stored

`trust` stores approvals in `~/.openqodex/trust.json`. It keys each one by the repository root and a hash of the entry and the resolved release asset. An approval in one repository does not cover another.

An edit to the entry changes its hash. OpenQodex then skips the scanner as `untrusted` until you run `openqodex trust` again.

- `openqodex trust --list` shows each custom scanner and its state.
- `openqodex trust --revoke <name>` removes one approval.
- `openqodex doctor` also shows the state of each custom scanner.

## Report formats

### SARIF

SARIF is a standard JSON format for scanner results. Many scanners write it when you pass a flag. It is the default `format`.

OpenQodex reads the rule id, the file, the start and end line, and the message of each result. A scanner severity is one of `critical`, `high`, `medium`, `low` and `info`. OpenQodex takes it from a `security-severity` score. A score on the result wins over a score on its rule:

- 9 or more: critical
- 7 or more: high
- 4 or more: medium
- above 0: low
- 0: info

Without a score, the SARIF level decides. `error` is high, `warning` is medium, `note` is low and `none` is info. Any other level is medium.

The report uses its own scale: `critical`, `major`, `minor`, `nitpick` and `info`. OpenQodex maps critical to critical, high to major, medium to minor, low to nitpick and info to info.

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
- `--disable-version-check` stops Bearer from asking for a newer release. Check what each scanner you add sends before you approve it.
- `--quiet` stops Bearer from printing what its help calls non-essential messages.
- Findings appear in the report as `custom:bearer:<rule id>`, such as `custom:bearer:javascript_lang_weak_hash_md5`.

This example was tested on 2026-10-12 on an Apple Silicon Mac. `trust` picked `bearer_2.1.1_darwin_arm64.tar.gz`. It checked that release asset against the project's `checksums.txt`. The test then added a JavaScript file that used MD5 to the demo repository. `scan --only custom:bearer` reported `javascript_lang_weak_hash_md5` on the changed line.

### json-map

Use `json-map` for a scanner that cannot write SARIF. OpenQodex reads its JSON report through a `map` block. Each value is a dotted path into the report, with `[n]` for a list index. `items` points at the list of results. OpenQodex reads the other paths from each result.

### Example: gosec with json-map

gosec checks Go code for security problems. This example shows the shape of a `map` block; no test runs it. gosec's JSON report looks like this:

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
- `line` may be a number or a string of digits. OpenQodex skips a result that has no file or no line.
- `severity_map` turns gosec's words into the scanner scale. OpenQodex reads a word that is not in the map as medium.
- `-no-fail` keeps gosec from exiting with an error when it finds something.

The end-to-end test of custom scanners runs actionlint from its GitHub release with `json-map` (`tests/e2e/custom-scanner.test.ts`).
