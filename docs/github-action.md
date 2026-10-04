# GitHub Action

The OpenQodex Action runs `openqodex scan` on a pull request's change. It uploads the findings to GitHub code scanning as SARIF. No model is involved: the Action runs the scanners only, and its first output line says it is not a review. The full review runs on your machine with `openqodex review`.

## Example workflow

Save this as `.github/workflows/openqodex.yml`:

```yaml
name: OpenQodex

on:
  pull_request:

permissions:
  contents: read
  security-events: write
  actions: read

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: openqodex/openqodex@v0
```

- `fetch-depth: 0` fetches the full history. The scan needs the pull request's base commit, which a shallow checkout does not have.
- `security-events: write` lets the Action upload SARIF to code scanning.
- `actions: read` is read by the SARIF upload in a private repository.
- `contents: read` lets the job check out the code.

## Inputs

- `version`: the `openqodex` version to run. The default is the version the Action was released with.
- `upload-sarif`: `true` or `false`. The default is `true`. Set it to `false` to skip the code scanning upload.
- `block-on-severity`: `info`, `nitpick`, `minor`, `major` or `critical`. The job fails on a finding on a changed line at or above it. When set, it wins over `review.block_on_severity` in the repository's config. Empty (the default) uses the config.
- `fail-on-tool-error`: `true` or `false`. The default is `false`. With `true`, the job fails when OpenQodex itself could not run the scan or install the scanners.
- `config-from`: `base` or `head`. The default is `base`. In a pull request, `base` reads the OpenQodex config from the pull request's base commit, and `head` reads the one the pull request carries. Other events always read the checked-out config.

## Outputs

- `status`: `passed`, `blocked` (a finding met the block severity) or `tool-failed` (OpenQodex could not run the scan).

## The config a pull request can change

In a `pull_request` workflow the checkout is the pull request's own code, so its `.openqodex/config.yaml` or `.openqodex.yaml` is the pull request author's. That file can hide findings: `review.disabled_rules`, `review.severity_threshold`, `review.paths.exclude`, `scanners.disable` and `review.block_on_severity` all live there. So in a pull request the Action reads the config from the base commit instead. It writes the base commit's `.openqodex/config.yaml`, or else its `.openqodex.yaml`, to a file under the runner's temporary folder with `git show`, and passes it to OpenQodex with `--config`. A base commit with neither file gives the built-in defaults. The base commit is fetched first when the checkout lacks it.

A team that wants each pull request's own config set `config-from: head`.

`block-on-severity` in the workflow also wins over any config, since the workflow file lives on your base branch:

```yaml
      - uses: openqodex/openqodex@v0
        with:
          block-on-severity: major
```

## What it does

1. Sets up Node 22.
2. Restores `~/.openqodex/tools` from the Actions cache, keyed on the runner and the `openqodex` version.
3. In a pull request with `config-from: base`, writes the base commit's config to a file under the runner's temporary folder.
4. Runs `npx -y openqodex@<version> doctor --install`, which installs every scanner and waits. A failure here is handled like a scan that could not run (below), and the scan is skipped.
5. Runs `npx -y openqodex@<version> scan --base <pull request base commit> --format sarif`, with `--config` from step 3 when there is one. The SARIF goes to a new folder under the runner's temporary folder, never into the checkout.
6. Uploads that SARIF to code scanning, when `upload-sarif` is `true` and the scan wrote a report.
7. Fails the job when the scan exited 1, or exited 2 with `fail-on-tool-error: true`.

The scan exits 1 only when `block-on-severity` or the config's `review.block_on_severity` is set and a finding on a changed line meets it. Without either, the job never fails on findings. A scan that fails for its own reasons, for example on a config file it cannot read, exits 2. The same holds when the scanner install fails. The job then shows a warning annotation titled "OpenQodex did not run" with the last line OpenQodex printed (control characters and colon runs removed), writes the same line to the job summary, and sets `status` to `tool-failed`. It does not fail unless `fail-on-tool-error` is `true`.

## Config

Outside a pull request, and with `config-from: head`, the Action reads the repository's config like every other command. Custom scanners need an approval stored on the machine that runs them. The runner has none, so the Action lists custom scanners as `untrusted` and skips them.

## Pre-commit

The repository also ships a pre-commit hook for the pre-push stage. Add this to `.pre-commit-config.yaml`:

```yaml
repos:
  - repo: https://github.com/openqodex/openqodex
    rev: v0.4.0
    hooks:
      - id: openqodex-scan
```

Then install the pre-push hook:

```
pre-commit install --hook-type pre-push
```

The hook runs `npx -y openqodex@<version> scan` on the commits not yet pushed plus the working tree. It stops the push only when the scan exits 1. A scan that fails for its own reasons never stops the push. The hook needs Node 22, npx and `sh` on your machine.
