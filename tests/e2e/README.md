# End-to-end tests

Use Node 22 with pnpm 9. Build the real CLI first:

```sh
PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm build
PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm test:e2e
```

`OPENQODEX_E2E_HOME` selects the shared scanner tools folder. It defaults to `<os tmpdir>/openqodex-e2e-home`. Each subprocess gets a separate temporary `HOME`. The suite runs `doctor --install` once before scanner cases and keeps its output in the receipt. The first install may take 20 minutes. `OPENQODEX_E2E_OFFLINE=1` skips network assertions for Semgrep, OSV Scanner, and the custom GitHub release, with a printed reason. `CI=1` makes missing runtimes fail the adapter group.

Receipts go to `tests/e2e/runs/<yyyymmdd-hhmmss>/`. Each case saves its command, exit code, stdout, and stderr. The main demo case also saves report JSON, Markdown, SARIF, and terminal output. The folder is gitignored and printed at the end.

The custom scanner case requires the custom scanner stream to be merged. Until then it documents the expected flow but cannot pass on this branch.
