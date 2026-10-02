// Runs the scanner ensemble against the developer's working tree and turns
// what survives into review candidates.
//
// Order of work: each builtin scanner is gated on the change (`wants`), the
// tool is resolved only for the ones that want it, everything runs in
// parallel, then one pipeline: paths rebased to repo-relative, the
// changed-line filter, the fixture filter, `disabled_rules`, cross-scanner
// dedup, a severity sort, candidate ids. Custom scanners join after the
// builtins through the same pipeline.
//
// Nothing a scanner does can reject this function: a missing tool, a
// failed install, a timeout, bad JSON or a thrown error all become a status
// and a one-line reason in that scanner's summary. Static analysis is
// additive context, never a gate on its own.

import fs from "node:fs";
import path from "node:path";
import {
  fingerprintSecrets,
  mapScannerSeverity,
  matchesGlob,
  redactSecrets,
} from "@openqodex/core";
import type {
  AdapterResult,
  Candidate,
  Config,
  DiffCoverage,
  ResolveTool,
  ScanResult,
  ScannerRunSummary,
  ScannerSeverity,
  ScannerSource,
  StaticFinding,
} from "@openqodex/core";
import { ADAPTERS, IN_PROCESS } from "./adapters/index.js";
import type { Adapter } from "./adapters/index.js";
import { dropFixtureFindings, filterToChangedLines } from "./filter.js";

// A custom scanner prepared by the custom module. `skipped` is set when the
// entry must not run (untrusted, changed since approval); the runner then
// records that summary and never calls `run`.
export type CustomAdapter = {
  source: ScannerSource;
  skipped: ScannerRunSummary | null;
  wants(changedPaths: string[]): boolean;
  run(args: { repoDir: string; changedPaths: string[] }): Promise<AdapterResult & { version: string | null }>;
};

export type RunScannersResult = {
  scan: ScanResult;
  // Raw matched secrets, in memory only, for redacting the brief. Never persist.
  secrets: string[];
};

// One scanner's run before the shared pipeline.
type Outcome = {
  summary: ScannerRunSummary;
  findings: StaticFinding[];
  secrets: string[];
};

export async function runScanners(args: {
  repoDir: string;
  changedPaths: string[];
  coverage: DiffCoverage;
  config: Config;
  resolveTool: ResolveTool;
  custom?: CustomAdapter[];
  only?: ScannerSource[];
  skip?: ScannerSource[];
  onProgress?: (line: string) => void;
}): Promise<RunScannersResult> {
  const selected = (source: ScannerSource): boolean =>
    (!args.only || args.only.includes(source)) && !(args.skip ?? []).includes(source);

  const report = (outcome: Outcome): Outcome => {
    args.onProgress?.(progressLine(outcome.summary));
    return outcome;
  };

  const builtins = ADAPTERS.filter((a) => selected(a.source)).map((adapter) =>
    guard(adapter.source, () => runBuiltin(adapter, args)).then(report),
  );
  const customs = (args.custom ?? [])
    .filter((c) => selected(c.source))
    .map((custom) => guard(custom.source, () => runCustom(custom, args)).then(report));
  const outcomes = await Promise.all([...builtins, ...customs]);

  const secrets = outcomes.flatMap((o) => o.secrets);

  // Adapters do not agree on what a finding's path is relative to, and the
  // changed-line filter matches coverage keys by exact string, so every
  // path is rebased onto the repo root first.
  const merged = outcomes.flatMap((o) =>
    filterToChangedLines(toRunDirRelative(o.findings, args.repoDir), args.coverage),
  );

  // Fixture, mock and snapshot files hold throwaway data shaped like the
  // real thing; hits there are noise unless the developer asks for them.
  let postFixture = merged;
  let fixturesDropped = 0;
  if (!args.config.includeFixtures) {
    const dropped = dropFixtureFindings(merged);
    postFixture = dropped.kept;
    fixturesDropped = dropped.droppedCount;
  }

  const postRules =
    args.config.disabledRules.length === 0
      ? postFixture
      : postFixture.filter(
          (f) => !args.config.disabledRules.some((glob) => matchesGlob(`${f.source}:${f.ruleId}`, glob)),
        );

  // Cross-scanner dedup, then a severity sort that is stable within a
  // severity, so ties keep the ensemble order (semgrep before gitleaks).
  const deduped = dedupByRuleClass(postRules);
  deduped.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));

  const candidates: Candidate[] = deduped.map((f, i) => ({
    ...f,
    message: redactSecrets(f.message, secrets),
    id: `c${i + 1}`,
    token: `${f.source}:${f.ruleId}`,
    reviewSeverity: mapScannerSeverity(f.severity),
  }));

  const kept = new Map<ScannerSource, number>();
  for (const c of candidates) kept.set(c.source, (kept.get(c.source) ?? 0) + 1);
  const scanners = outcomes.map((o) => ({ ...o.summary, keptCount: kept.get(o.summary.scanner) ?? 0 }));

  return {
    scan: {
      candidates,
      scanners,
      fixturesDropped,
      secretFingerprints: fingerprintSecrets(secrets),
    },
    secrets,
  };
}

async function runBuiltin(
  adapter: Adapter,
  args: { repoDir: string; changedPaths: string[]; config: Config; resolveTool: ResolveTool },
): Promise<Outcome> {
  const started = Date.now();
  const source = adapter.source;
  if (args.config.disabledScanners.includes(source)) {
    return skippedOutcome(source, "disabled", "disabled in .openqodex.yaml", started);
  }
  if (!adapter.wants(args.changedPaths, args.repoDir)) {
    return skippedOutcome(source, "no_matching_files", null, started);
  }

  let tool = null;
  if (!IN_PROCESS.has(source)) {
    const resolution = await args.resolveTool(source);
    if (!resolution.ok) return skippedOutcome(source, resolution.status, resolution.reason, started);
    tool = resolution.tool;
  }

  const ranFrom = Date.now();
  const result = await adapter.run({ repoDir: args.repoDir, changedPaths: args.changedPaths, tool });
  return ranOutcome(source, result, tool?.version ?? null, ranFrom);
}

async function runCustom(
  custom: CustomAdapter,
  args: { repoDir: string; changedPaths: string[] },
): Promise<Outcome> {
  const started = Date.now();
  if (custom.skipped) return { summary: custom.skipped, findings: [], secrets: [] };
  if (!custom.wants(args.changedPaths)) {
    return skippedOutcome(custom.source, "no_matching_files", null, started);
  }
  const result = await custom.run({ repoDir: args.repoDir, changedPaths: args.changedPaths });
  return ranOutcome(custom.source, result, result.version, started);
}

// A scanner whose run threw is recorded as failed; the throw never escapes.
async function guard(source: ScannerSource, run: () => Promise<Outcome>): Promise<Outcome> {
  const started = Date.now();
  try {
    return await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return skippedOutcome(source, "failed", oneLine(message), started);
  }
}

function skippedOutcome(
  scanner: ScannerSource,
  status: ScannerRunSummary["status"],
  reason: string | null,
  started: number,
): Outcome {
  return {
    summary: { scanner, status, version: null, rawCount: 0, keptCount: 0, durationMs: Date.now() - started, reason },
    findings: [],
    secrets: [],
  };
}

// A scanner that ran. An error with no findings is a failure; an error next
// to findings (one Go module of several failed, one .sql file unreadable)
// keeps the findings and the note.
function ranOutcome(
  scanner: ScannerSource,
  result: AdapterResult,
  version: string | null,
  started: number,
): Outcome {
  const failed = result.error !== null && result.findings.length === 0;
  return {
    summary: {
      scanner,
      status: failed ? "failed" : "ran",
      version,
      rawCount: result.findings.length,
      keptCount: 0,
      durationMs: Date.now() - started,
      reason: result.error === null ? null : oneLine(result.error),
    },
    findings: result.findings,
    secrets: result.secrets ?? [],
  };
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

function progressLine(s: ScannerRunSummary): string {
  const seconds = `${(s.durationMs / 1000).toFixed(1)}s`;
  switch (s.status) {
    case "ran":
      return `${s.scanner}: ran, ${s.rawCount} raw finding(s) in ${seconds}${s.reason ? ` (${s.reason})` : ""}`;
    case "no_matching_files":
      return `${s.scanner}: nothing to check in this change`;
    default:
      return `${s.scanner}: ${s.status.replace(/_/g, " ")}${s.reason ? `: ${s.reason}` : ""}`;
  }
}

/**
 * Rewrite each finding's path to be relative to `runDir`, the directory the
 * scanners were actually started in (the repo root).
 *
 * Everything downstream speaks that one frame: the coverage keys and the
 * changed-path list are built in it, and filterToChangedLines matches a
 * finding's path against those keys by EXACT STRING. A path in any other
 * shape is not "slightly off", it is silently dropped.
 *
 * Absolute paths are why this exists. A scanner that resolves a project root
 * reports absolute filenames whatever arguments it was handed (ruff does),
 * and it reports them resolved through symlinks. That second part matters
 * because on macOS /var/folders/... is a symlink to /private/var/folders/...,
 * so a raw prefix comparison against runDir misses. Hence the realpath
 * fallback, computed once and only if some path is absolute.
 *
 * A path that is absolute and outside runDir under both spellings is left
 * alone: there is no honest way to guess where it belongs, and the coverage
 * filter drops it.
 *
 * Exported for unit tests.
 */
export function toRunDirRelative(
  findings: StaticFinding[],
  runDir: string,
): StaticFinding[] {
  let realRunDir: string | null = null;
  const realRunDirOnce = (): string => {
    if (realRunDir === null) {
      try {
        realRunDir = fs.realpathSync(runDir);
      } catch {
        realRunDir = runDir;
      }
    }
    return realRunDir;
  };
  return findings.map((f) => {
    const filePath = rebaseFindingPath(f.filePath, runDir, realRunDirOnce);
    return filePath === f.filePath ? f : { ...f, filePath };
  });
}

function rebaseFindingPath(
  filePath: string,
  runDir: string,
  realRunDirOnce: () => string,
): string {
  if (!filePath) return filePath;
  if (!path.isAbsolute(filePath)) {
    // "./src/a.py" and "src/a.py" name one file to a linter and are two
    // different keys to a Map.
    const normalized = path.normalize(filePath);
    return normalized.startsWith("..") ? filePath : normalized;
  }
  return (
    relativeUnder(runDir, filePath) ??
    relativeUnder(realRunDirOnce(), filePath) ??
    filePath
  );
}

// path.relative, but null rather than a traversal when the target is not
// inside dir.
function relativeUnder(dir: string, absolutePath: string): string | null {
  const rel = path.relative(dir, absolutePath);
  if (!rel || path.isAbsolute(rel)) return null;
  if (rel === ".." || rel.startsWith(`..${path.sep}`)) return null;
  return rel;
}

const SEVERITY_RANK: Record<ScannerSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

function severityRank(s: ScannerSeverity): number {
  return SEVERITY_RANK[s] ?? 0;
}

// Coarse category used for cross-scanner dedup. Different rule IDs for
// the same vulnerability class should collapse on the same span; rules
// that don't fit a known class get a class string unique to themselves
// (so they only ever dedup with their own duplicates, never with
// adjacent-but-distinct rules).
//
// gitleaks always classes as "secret": it's a secret scanner, every
// hit is structurally the same class. semgrep classification is
// pattern-based on the rule id; coverage focuses on the categories
// where semgrep overlaps gitleaks (secret) or where multiple semgrep
// rules commonly co-fire on one line (injection, auth).
export function ruleClassFor(f: StaticFinding): string {
  if (f.source === "gitleaks") return "secret";
  const id = f.ruleId.toLowerCase();
  if (/secret|credential|api[-_]?key|access[-_]?key|password|token/.test(id)) {
    return "secret";
  }
  if (
    /sql[-_]?injection|command[-_]?injection|xss|path[-_]?traversal|tainted|untrusted[-_]?input/.test(
      id,
    )
  ) {
    return "injection";
  }
  if (/\bauth(?!or)|permission|access[-_]?control|rbac/.test(id)) {
    return "auth";
  }
  // Fall-through: only dedups with itself, never merges with other
  // rule ids. The full rule id is the per-finding fingerprint.
  return `${f.source}:${f.ruleId}`;
}

// Group by (file, lineStart, lineEnd, ruleClass); pick the highest-
// severity hit per group. Ties on severity break to the first
// occurrence (semgrep precedes gitleaks in the input order, which
// matches the typical preference of having a semgrep rule's
// descriptive message over gitleaks's terse "Generic API Key").
// Exported for unit tests.
export function dedupByRuleClass(findings: StaticFinding[]): StaticFinding[] {
  const groups = new Map<string, StaticFinding[]>();
  for (const f of findings) {
    const key = `${f.filePath}::${f.lineStart}::${f.lineEnd}::${ruleClassFor(f)}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(f);
    else groups.set(key, [f]);
  }
  const winners: StaticFinding[] = [];
  // Preserve input order for unaffected findings by walking the input
  // once and emitting each finding the first time we hit its group's
  // winner. Avoids reordering the non-deduped tail.
  const emitted = new Set<StaticFinding>();
  for (const bucket of groups.values()) {
    if (bucket.length === 1) {
      emitted.add(bucket[0]);
      continue;
    }
    const winner = [...bucket].sort(
      (a, b) => severityRank(b.severity) - severityRank(a.severity),
    )[0];
    emitted.add(winner);
  }
  for (const f of findings) {
    if (emitted.has(f)) winners.push(f);
  }
  return winners;
}
