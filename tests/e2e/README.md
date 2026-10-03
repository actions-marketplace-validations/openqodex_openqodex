# End-to-end tests

The built CLI, run as a real subprocess on the demo repo with the real scanner binaries. Nothing is faked. Use Node 22 with pnpm 9 and build first:

```sh
PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm build
PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm test:e2e
```

`OPENQODEX_E2E_HOME` selects the shared scanner tools folder. It defaults to `<os tmpdir>/openqodex-e2e-home`. The suite runs `doctor --install` into it once before the scanner cases; the first install from an empty folder may take 20 minutes, later runs reuse it. Each subprocess gets its own temporary `HOME`, so the real home folder is never touched.

`OPENQODEX_E2E_OFFLINE=1` skips the semgrep, osv-scanner and custom GitHub release assertions, with a printed reason. With `CI` set, the builtin scanner check fails when any scanner was skipped (brakeman and rubocop need Ruby, golangci-lint needs Go).

Every case guards one failure, named in its title. The groups:

- `demo-flow`: one demo repo through init, the push hook, scan, review --agent and review --finalize; planted bugs found, the secret never shown, the repository unchanged by each command.
- `review-finalize`: submissions finalize must reject, finalizing an older run by its path, a critical finding that blocks.
- `block`, `scopes`, `no-tools`, `offline`, `git-hook`, `hook-links`, `custom-scanner`, `clean-repo`, `cli`: one behaviour each.
- `adapters`: each of the thirteen builtin scanners on a tiny planted input (`packages/scanners/test/adapters.subprocess.test.ts`).

Receipts go to `tests/e2e/runs/<yyyymmdd-hhmmss>/` (gitignored, path printed at the end). Each command saves its command line, exit code, duration, stdout and stderr; the demo scan also saves `report.json`, `report.md`, `report.sarif` and the terminal output.
