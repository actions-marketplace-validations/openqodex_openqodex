# Custom scanners

You can add any scanner by its GitHub link. Its findings join the same report as the built-in scanners. Only findings on changed lines are kept.

A custom scanner is an arbitrary command that runs on your machine with your permissions. Only `openqodex trust` downloads a custom scanner, and it asks you first. `scan` and `review` never download one. Nothing is installed or run before you approve that exact entry.

## Add one

Two lines in your repository's `.openqodex/config.yaml`:

```yaml
scanners:
  custom:
    - source: https://github.com/aquasecurity/trivy
      run: trivy config --format sarif --output {report} {target}
```

- `source`: the scanner's GitHub repository.
- `run`: the command line. OpenQodex splits it into words and starts the first word as the program. It never uses a shell.

Three placeholders are filled in:

- `{report}`: the file the scanner writes its report to.
- `{target}`: the changed files, or the repository root when `target: repo` is set.
- `{repo}`: the repository root.

`config` lists every optional key: `name`, `version`, `format`, `map`, `paths`, `target`, `timeout_seconds` and `install`.

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
    - source: https://github.com/aquasecurity/trivy
      run: trivy config --format sarif --output {report} {target}
      install:
        asset: "trivy_{version}_{os}-{arch}.tar.gz"
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

### Worked example: trivy with SARIF

trivy checks infrastructure files such as Terraform and Kubernetes manifests.

```yaml
scanners:
  custom:
    - source: https://github.com/aquasecurity/trivy
      run: trivy config --format sarif --output {report} {target}
      paths: ["**/*.tf", "*.tf", "**/*.yaml", "*.yaml"]
      target: repo
```

- `paths` limits the scanner to changes that hold Terraform or YAML files.
- `target: repo` passes the repository root, because `trivy config` scans a folder.
- Findings appear in the report as `custom:trivy:<rule id>`.

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
