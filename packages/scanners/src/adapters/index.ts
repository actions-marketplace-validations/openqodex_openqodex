// The thirteen builtin scanners. Each adapter gates itself on the changed
// files (`wants`), so the toolchain is never asked for a tool the change
// does not need, and runs its tool from the resolved path (`run`).
import type { AdapterResult, BuiltinScanner, DiffCoverage, ResolvedTool } from "@openqodex/core";
import { actionlint } from "./actionlint.js";
import { bandit } from "./bandit.js";
import { brakeman } from "./brakeman.js";
import { gitleaks } from "./gitleaks.js";
import { golangci } from "./golangci.js";
import { hadolint } from "./hadolint.js";
import { osvScanner } from "./osv-scanner.js";
import { oxlint } from "./oxlint.js";
import { rubocop } from "./rubocop.js";
import { ruff } from "./ruff.js";
import { semgrep } from "./semgrep.js";
import { shellcheck } from "./shellcheck.js";
import { sqllint } from "./sql-lint.js";

export type Adapter = {
  source: BuiltinScanner;
  // True when this scanner has something to check in the change.
  wants(changedPaths: string[], repoDir: string): boolean;
  // A reason this scanner must not run at all (for example dependency
  // lookups while offline), known before any tool is resolved.
  skip?(): string | null;
  // `tool` is null only for the in-process sqllint. `coverage` is the
  // changed lines, for adapters that choose between places to anchor a
  // finding.
  run(args: {
    repoDir: string;
    changedPaths: string[];
    tool: ResolvedTool | null;
    coverage?: DiffCoverage;
  }): Promise<AdapterResult>;
};

// Scanners that run inside OpenQodex and need no tool resolved.
export const IN_PROCESS: ReadonlySet<BuiltinScanner> = new Set<BuiltinScanner>(["sqllint"]);

// The ensemble in merge order. The order is load-bearing: dedup ties go to
// the first, so semgrep precedes gitleaks.
export const ADAPTERS: readonly Adapter[] = [
  semgrep,
  gitleaks,
  // In-process SQL / Postgres analyzer. No-op without changed .sql files.
  sqllint,
  // Dependency vulnerabilities. No-op unless a lockfile changed.
  osvScanner,
  // GitHub Actions workflows under .github/workflows/.
  actionlint,
  // Dockerfiles.
  hadolint,
  // .sh / .bash scripts.
  shellcheck,
  // Python lint.
  ruff,
  // Rails SAST: a changed Rails-relevant file in a repo with a Gemfile and app/.
  brakeman,
  // Ruby lint.
  rubocop,
  // Python SAST.
  bandit,
  // JavaScript and TypeScript lint.
  oxlint,
  // Go lint and gosec.
  golangci,
];

// The settings and ignore files each scanner really reads from the scanned
// tree, as the adapter runs it. A change to one can hide that scanner's
// findings, so the runner notes it. `path` with no folder and `anyFolder`
// false: only the copy at the repository root (the scanner's working folder
// or the adapter's own lookup). `anyFolder`: that name in any folder, which
// the tool finds by walking up from the scanned file. `ruffTable`: only when
// a changed line of the file is inside a `[tool.ruff` table.
// Not listed: oxlint, rubocop, brakeman and golangci run on settings of
// their own; bandit reads `.bandit` only with -r, which the adapter never
// passes (it names the files).
export type SettingsFile = { path: string; anyFolder?: true; ruffTable?: true };

export const SETTINGS_FILES: Partial<Record<BuiltinScanner, readonly SettingsFile[]>> = {
  // gitleaks.ts: the root config and the root ignore list only.
  gitleaks: [{ path: ".gitleaks.toml" }, { path: "gitleaks.toml" }, { path: ".gitleaksignore" }],
  // semgrep, run from the repository root.
  semgrep: [{ path: ".semgrepignore" }],
  // ruff finds its config from each file's folder upwards.
  ruff: [{ path: "ruff.toml", anyFolder: true }, { path: ".ruff.toml", anyFolder: true }, { path: "pyproject.toml", anyFolder: true, ruffTable: true }],
  // hadolint, run from the repository root.
  hadolint: [{ path: ".hadolint.yaml" }, { path: ".hadolint.yml" }],
  // shellcheck looks from each script's folder upwards.
  shellcheck: [{ path: ".shellcheckrc", anyFolder: true }, { path: "shellcheckrc", anyFolder: true }],
  // osv-scanner reads the one beside each lockfile.
  "osv-scanner": [{ path: "osv-scanner.toml", anyFolder: true }],
  // actionlint finds .github from the repository root.
  actionlint: [{ path: ".github/actionlint.yaml" }, { path: ".github/actionlint.yml" }],
};
