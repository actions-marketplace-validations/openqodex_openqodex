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

// The settings and ignore files each scanner reads from the scanned tree, by
// file name in any folder. A change to one can hide that scanner's findings,
// so the runner raises it as a candidate for the reviewer to clear. oxlint,
// rubocop, brakeman and golangci run on settings of their own and read none.
export const SETTINGS_FILES: Partial<Record<BuiltinScanner, readonly string[]>> = {
  gitleaks: [".gitleaks.toml", "gitleaks.toml", ".gitleaksignore"],
  semgrep: [".semgrepignore"],
  ruff: ["ruff.toml", ".ruff.toml", "pyproject.toml"],
  hadolint: [".hadolint.yaml", ".hadolint.yml"],
  shellcheck: [".shellcheckrc", "shellcheckrc"],
  "osv-scanner": ["osv-scanner.toml"],
  bandit: [".bandit"],
  actionlint: ["actionlint.yaml", "actionlint.yml"],
};
