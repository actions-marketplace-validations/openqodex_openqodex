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
