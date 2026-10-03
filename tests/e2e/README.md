# End-to-end tests

The built CLI, run as a real subprocess on the demo repo with the real scanner binaries. Nothing is faked. Use Node 22 with pnpm 9 and build first:

```sh
PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm build
PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm test:e2e
```

`OPENQODEX_E2E_HOME` selects the shared scanner tools folder. It defaults to `<os tmpdir>/openqodex-e2e-home`. The suite runs `doctor --install` into it once before the scanner cases; the first install from an empty folder may take 20 minutes, later runs reuse it. Each subprocess gets its own temporary `HOME`, so the real home folder is never touched.

`OPENQODEX_E2E_OFFLINE=1` skips the semgrep, osv-scanner and custom GitHub release assertions, with a printed reason. With `CI` set, the builtin scanner check fails when any scanner was skipped (brakeman and rubocop need Ruby, golangci-lint needs Go).

Every subprocess also gets `OPENQODEX_AUTO_UPDATE=0`, so a command run through the launcher starts no update worker. The `self-update` cases remove it.

Two variables are a test seam for the update worker, honoured only when `OPENQODEX_E2E=1` is also set: `OPENQODEX_UPDATE_AS=<x.y.z>` makes the worker choose releases as if it ran that version, and `OPENQODEX_UPDATE_MIN_AGE_MS=<ms>` replaces the 24 hour age rule. Verification is never skipped. With them, a temp-home install really downloads and verifies a published release.

Every case guards one failure, named in its title. The groups:

- `demo-flow`: one demo repo through init, the push hook, scan, review --agent and review --finalize; planted bugs found, the secret never shown, the repository unchanged by each command.
- `review-finalize`: submissions finalize must reject, finalizing an older run by its path, a critical finding that blocks.
- `block`, `scopes`, `no-tools`, `offline`, `git-hook`, `hook-links`, `custom-scanner`, `clean-repo`, `cli`: one behaviour each.
- `update-verify`: release verification against the real published 0.2.0 tarball and its real attestations.
- `self-update`: the update worker against the real registry, in a temp home holding a launcher install of this build: the command does not wait for the worker, the real 0.2.0 is downloaded, verified, run and skipped (it has no `__refresh` command), a skipped version is not downloaded again, and with nothing newer nothing is installed. `packages/cli/test/self-update.test.ts` covers the trigger, the switches, activation, retention, rollback and finalize without the registry.
- `adapters`: each of the thirteen builtin scanners on a tiny planted input (`packages/scanners/test/adapters.subprocess.test.ts`).

Receipts go to `tests/e2e/runs/<yyyymmdd-hhmmss>/` (gitignored, path printed at the end). Each command saves its command line, exit code, duration, stdout and stderr; the demo scan also saves `report.json`, `report.md`, `report.sarif` and the terminal output.
