// OSV-Scanner adapter (dependency vulnerabilities). Runs
// `osv-scanner --format json --lockfile <path> ...` against each changed
// lockfile in the working tree and normalizes the vendor JSON into
// StaticFinding[]. This is the only scanner in the ensemble that sees
// known vulnerabilities in third-party dependencies; the others scan
// first-party source, not the dependency graph.
//
// osv-scanner asks osv.dev about the dependency names and versions it reads
// from the lockfile (never the code). With OPENQODEX_OFFLINE=1 (set by the
// CLI for --offline) it is skipped with a plain reason instead.
//
// OSV's JSON reports a vulnerability against a (package, version) pair,
// NOT a source line. To anchor each advisory to a real diff line we
// re-read the lockfile and find the first line that mentions the
// package name. That line-mapping is deterministic and mechanical (a
// string scan, no model), and lets filterToChangedLines keep only
// advisories whose lockfile entry the change actually touched (i.e. the
// dependency this change added or bumped).
//
// osv-scanner writes nothing to disk in this mode. All errors are captured
// into the result; the runner never throws on a scanner failure: static
// analysis is additive context, not a gate.

import fs from "node:fs";
import path from "node:path";
import type {
  AdapterResult,
  DiffCoverage,
  ResolvedTool,
  ScannerSeverity as StaticFindingSeverity,
  StaticFinding,
} from "@openqodex/core";
import { describeFailure, execTool, isOffline, runInChunks } from "../exec.js";
import { safeFileArgs } from "../safe-args.js";
import type { Adapter } from "./index.js";
import { readRepoFile } from "./read.js";

const OSV_TIMEOUT_MS = 90_000;
const OSV_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
// A lockfile bigger than this is not read for line mapping; its advisories
// anchor to line 1.
const LOCKFILE_MAX_BYTES = 50 * 1024 * 1024;

export const OSV_OFFLINE_REASON = "offline, dependency lookups are off";

// Known before any tool is resolved, so an offline run never installs or
// starts osv-scanner.
function offlineReason(): string | null {
  return isOffline() ? OSV_OFFLINE_REASON : null;
}

// Lockfile / manifest basenames OSV-Scanner understands. We only invoke
// it when the change touched one of these, so a non-dependency change is a
// no-op (zero cost, no error). Kept as a basename allowlist rather than
// a glob so we don't pass random files to --lockfile and get a parse
// error per file.
//
// NOT package.json. osv-scanner has no --lockfile extractor for a plain
// manifest, and ONE path it cannot extract kills the whole run: the scan
// exits with an empty stdout and "could not determine extractor suitable
// to this file" on stderr, throwing away every package it had just read
// from the lockfile beside it. A change to package.json alone scans
// nothing; its real dependency change lands in the lockfile next to it.
const LOCKFILE_BASENAMES = new Set<string>([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.lock",
  "go.mod",
  "go.sum",
  "requirements.txt",
  "Pipfile.lock",
  "poetry.lock",
  "Gemfile.lock",
  "composer.lock",
  "pom.xml",
  "gradle.lockfile",
  "pubspec.lock",
  "mix.lock",
  "conan.lock",
]);

export type OsvScannerRunArgs = {
  repoDir: string;
  changedPaths: string[];
  tool: ResolvedTool | null;
  coverage?: DiffCoverage;
};

function isLockfilePath(p: string): boolean {
  return LOCKFILE_BASENAMES.has(path.basename(p));
}

export async function runOsvScanner(args: OsvScannerRunArgs): Promise<AdapterResult> {
  // safeFileArgs is defense in depth: each path is the value of a
  // --lockfile flag, but a flag-shaped path is never handed on.
  const lockfiles = safeFileArgs(args.changedPaths.filter(isLockfilePath));
  if (lockfiles.length === 0) return { findings: [], error: null };
  const skipped = offlineReason();
  if (skipped) return { findings: [], error: null, skipped };
  if (!args.tool) return { findings: [], error: "not installed" };

  // Pre-read each lockfile so the parser can map advisories to lines
  // without doing IO per advisory. A read failure for one lockfile just
  // means its advisories anchor to line 1 (still inside the diff if the
  // file was added wholesale); never fatal.
  const lockfileLines = new Map<string, string[]>();
  for (const rel of lockfiles) {
    try {
      const content = await readRepoFile(args.repoDir, rel, LOCKFILE_MAX_BYTES);
      lockfileLines.set(path.normalize(rel), content.split("\n"));
    } catch {
      // Best effort; missing content falls back to line 1 in the parser.
    }
  }

  // One process per chunk of lockfiles, so a whole-repo list stays under
  // the argument limit; the findings of every chunk are merged.
  const tool = args.tool;
  try {
    const findings = await runInChunks("osv-scanner", lockfiles, OSV_TIMEOUT_MS, async (chunk, left) => {
      const cliArgs = ["--format", "json", ...chunk.flatMap((rel) => ["--lockfile", rel])];
      const run = await execTool(tool.path, cliArgs, {
        cwd: args.repoDir,
        timeoutMs: left,
        maxBytes: OSV_OUTPUT_MAX_BYTES,
        env: tool.env,
      });
      // The only failures are the ones that leave no report to read: the
      // binary did not start, the process was killed, or it overflowed.
      const failed = describeFailure("osv-scanner", run, OSV_TIMEOUT_MS);
      if (failed) throw new Error(failed);

      let found: StaticFinding[];
      try {
        found = parseOsvScannerJson(run.stdout, lockfileLines, {
          repoDir: args.repoDir,
          coverage: args.coverage,
        });
      } catch (err) {
        // THE JSON IS THE RESULT, AND ONLY AN UNREADABLE ONE IS A FAILURE.
        // osv-scanner uses its exit code to describe what it found (1 is
        // vulnerabilities found), so the report decides, not the code. When the
        // report will not parse, the exit code is the best clue about why, so
        // it goes in the message when there was a non-zero one.
        const message = err instanceof Error ? err.message : String(err);
        const where = run.exitCode ? `exit ${run.exitCode}, ` : "";
        throw new Error(`parse: ${where}${message.slice(0, 200)}`);
      }

      // A completed scan that printed no report at all, under an exit code
      // that is not one of the two "I ran" codes, did not run.
      if (!run.stdout.trim() && run.exitCode !== null && run.exitCode > 1) {
        throw new Error(`osv-scanner exit ${run.exitCode}: ${run.stderr.trim().slice(-300)}`);
      }
      return found;
    });
    return { findings, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { findings: [], error: message.slice(0, 300) };
  }
}

export const osvScanner: Adapter = {
  source: "osv-scanner",
  wants: (changedPaths) => safeFileArgs(changedPaths.filter(isLockfilePath)).length > 0,
  skip: offlineReason,
  run: (args) => runOsvScanner(args),
};

type OsvSeverityEntry = { type?: unknown; score?: unknown };
type OsvVulnerability = {
  id?: unknown;
  summary?: unknown;
  details?: unknown;
  aliases?: unknown;
  severity?: unknown;
  database_specific?: { severity?: unknown };
};
type OsvGroup = { ids?: unknown; max_severity?: unknown };
type OsvPackageEntry = {
  package?: { name?: unknown; version?: unknown; ecosystem?: unknown };
  vulnerabilities?: unknown;
  groups?: unknown;
};
type OsvResultEntry = {
  source?: { path?: unknown };
  packages?: unknown;
};

export function parseOsvScannerJson(
  json: string,
  lockfileLines: Map<string, string[]>,
  opts: { repoDir?: string; coverage?: DiffCoverage } = {},
): StaticFinding[] {
  if (!json.trim()) return [];
  const parsed = JSON.parse(json) as { results?: unknown };
  if (!parsed || !Array.isArray(parsed.results)) return [];
  const out: StaticFinding[] = [];
  for (const result of parsed.results as OsvResultEntry[]) {
    if (!result || typeof result !== "object") continue;
    const sourcePath = typeof result.source?.path === "string" ? result.source.path : "";
    const relPath = relativeLockfilePath(sourcePath, lockfileLines, opts.repoDir);
    const lines = lockfileLines.get(relPath) ?? null;
    if (!Array.isArray(result.packages)) continue;
    for (const pkg of result.packages as OsvPackageEntry[]) {
      if (!pkg || typeof pkg !== "object") continue;
      const pkgName = typeof pkg.package?.name === "string" ? pkg.package.name : "";
      const pkgVersion =
        typeof pkg.package?.version === "string" ? pkg.package.version : "";
      const range = entryRangeForPackage(lines, pkgName, pkgVersion, opts.coverage?.get(relPath));
      const maxSeverityByVulnId = groupSeverityById(pkg.groups);
      if (!Array.isArray(pkg.vulnerabilities)) continue;
      for (const vuln of pkg.vulnerabilities as OsvVulnerability[]) {
        if (!vuln || typeof vuln !== "object") continue;
        const id = typeof vuln.id === "string" ? vuln.id : "";
        if (!id) continue;
        const severity = severityForVuln(vuln, maxSeverityByVulnId.get(id));
        out.push({
          source: "osv-scanner",
          ruleId: id,
          filePath: relPath || sourcePath,
          lineStart: range.start,
          lineEnd: range.end,
          severity,
          message: vulnMessage(pkgName, pkgVersion, vuln),
          reference: id.startsWith("CVE-")
            ? `https://nvd.nist.gov/vuln/detail/${id}`
            : `https://osv.dev/vulnerability/${id}`,
        });
      }
    }
  }
  return out;
}

// OSV prints the lockfile path it was given, often made absolute. Rebase it
// onto the repo root (under either spelling of a symlinked root) and look it
// up exactly, so `service/package-lock.json` never takes the root lockfile's
// path. Without a repo root, the longest key that ends the path at a folder
// boundary wins. Falls back to the raw path if nothing matches.
function relativeLockfilePath(
  sourcePath: string,
  lockfileLines: Map<string, string[]>,
  repoDir?: string,
): string {
  if (lockfileLines.has(sourcePath)) return sourcePath;
  if (repoDir && path.isAbsolute(sourcePath)) {
    const roots = [repoDir];
    try {
      roots.push(fs.realpathSync(repoDir));
    } catch {
      // The plain spelling is enough.
    }
    for (const root of roots) {
      const rel = path.relative(root, sourcePath);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel) && lockfileLines.has(rel)) return rel;
    }
  }
  if (!path.isAbsolute(sourcePath) && lockfileLines.has(path.normalize(sourcePath))) {
    return path.normalize(sourcePath);
  }
  let best: string | null = null;
  for (const key of lockfileLines.keys()) {
    const boundary = sourcePath.length === key.length || sourcePath[sourcePath.length - key.length - 1] === "/";
    if (sourcePath.endsWith(key) && boundary && (!best || key.length > best.length)) best = key;
  }
  return best ?? sourcePath;
}

// Lockfile range for a package's entry: from the line that names the
// package through the line carrying its flagged version. Anchoring to a
// RANGE (not just the name line) is what lets the changed-line filter
// keep advisories for BUMPED dependencies: on a version bump the
// name/key line is unchanged while the version/integrity lines change.
//
// A package can match in several places: a top-level declaration
// (`"lodash": "^4.17.20"`, unchanged by a lockfile refresh) and the resolved
// entry that carries the version. Every place where the name has the version
// nearby is a candidate; the first one that touches a changed line wins, so
// the advisory stays on the entry the change actually moved. Without changed
// lines the first candidate wins. Falls back to a small window from the
// first name line when the version is not found verbatim (hashed lockfiles),
// and to line 1 when content is unavailable (a wholesale-added file still
// overlaps).
function entryRangeForPackage(
  lines: string[] | null,
  pkgName: string,
  pkgVersion: string,
  changed?: Set<number>,
): { start: number; end: number } {
  if (!lines || !pkgName) return { start: 1, end: 1 };
  const name = pkgName.toLowerCase();
  const ver = pkgVersion ? pkgVersion.toLowerCase() : "";
  let firstNameLine = -1;
  const candidates: { start: number; end: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].toLowerCase().includes(name)) continue;
    if (firstNameLine === -1) firstNameLine = i;
    if (ver) {
      const windowEnd = Math.min(lines.length, i + 9);
      for (let j = i; j < windowEnd; j++) {
        if (lines[j].toLowerCase().includes(ver)) {
          candidates.push({ start: i + 1, end: j + 1 });
          break;
        }
      }
    }
  }
  if (candidates.length > 0) {
    const touched = changed
      ? candidates.find((c) => {
          for (let n = c.start; n <= c.end; n++) if (changed.has(n)) return true;
          return false;
        })
      : undefined;
    return touched ?? candidates[0];
  }
  if (firstNameLine === -1) return { start: 1, end: 1 };
  return {
    start: firstNameLine + 1,
    end: Math.min(lines.length, firstNameLine + 1 + 6),
  };
}

// Build vulnId -> max CVSS severity label from the package's groups
// array. OSV groups aliased advisories and exposes max_severity (a CVSS
// base score string) per group. Used as a fallback when an individual
// vulnerability has no severity array of its own.
function groupSeverityById(groups: unknown): Map<string, StaticFindingSeverity> {
  const map = new Map<string, StaticFindingSeverity>();
  if (!Array.isArray(groups)) return map;
  for (const g of groups as OsvGroup[]) {
    if (!g || typeof g !== "object") continue;
    const score = typeof g.max_severity === "string" ? parseFloat(g.max_severity) : NaN;
    const sev = cvssScoreToSeverity(score);
    if (!Array.isArray(g.ids)) continue;
    for (const id of g.ids) {
      if (typeof id === "string") map.set(id, sev);
    }
  }
  return map;
}

function severityForVuln(
  vuln: OsvVulnerability,
  groupSeverity: StaticFindingSeverity | undefined,
): StaticFindingSeverity {
  // Prefer a CVSS vector score on the vuln itself.
  if (Array.isArray(vuln.severity)) {
    for (const s of vuln.severity as OsvSeverityEntry[]) {
      if (!s || typeof s !== "object") continue;
      const score = cvssVectorScore(s.score);
      if (score !== null) return cvssScoreToSeverity(score);
    }
  }
  // Then a database_specific qualitative label (GHSA uses these).
  const dbSev = vuln.database_specific?.severity;
  if (typeof dbSev === "string") {
    const mapped = qualitativeToSeverity(dbSev);
    if (mapped) return mapped;
  }
  // Then the group's max CVSS score.
  if (groupSeverity) return groupSeverity;
  // No severity data at all: a known CVE in a dependency is worth a look.
  return "high";
}

// OSV CVSS scores arrive as vector strings (e.g.
// "CVSS:3.1/AV:N/AC:L/...") whose base score isn't a bare number, OR as
// a plain numeric string. We only trust a bare numeric score here; a
// full vector requires a CVSS calculator we don't bundle, so those fall
// through to database_specific / group severity.
function cvssVectorScore(score: unknown): number | null {
  if (typeof score !== "string") return null;
  const n = parseFloat(score);
  if (Number.isFinite(n) && !score.includes("/")) return n;
  return null;
}

function cvssScoreToSeverity(score: number): StaticFindingSeverity {
  if (!Number.isFinite(score)) return "high";
  if (score >= 9.0) return "critical";
  if (score >= 7.0) return "high";
  if (score >= 4.0) return "medium";
  if (score > 0) return "low";
  return "info";
}

function qualitativeToSeverity(raw: string): StaticFindingSeverity | null {
  const v = raw.trim().toUpperCase();
  if (v === "CRITICAL") return "critical";
  if (v === "HIGH") return "high";
  if (v === "MODERATE" || v === "MEDIUM") return "medium";
  if (v === "LOW") return "low";
  return null;
}

function vulnMessage(pkgName: string, pkgVersion: string, vuln: OsvVulnerability): string {
  const id = typeof vuln.id === "string" ? vuln.id : "advisory";
  const aliases = Array.isArray(vuln.aliases)
    ? (vuln.aliases as unknown[]).filter((a): a is string => typeof a === "string")
    : [];
  const aliasStr = aliases.length > 0 ? ` (${aliases.slice(0, 3).join(", ")})` : "";
  const summary =
    typeof vuln.summary === "string" && vuln.summary.trim()
      ? vuln.summary
      : typeof vuln.details === "string"
        ? vuln.details
        : "Known vulnerability";
  const where = pkgVersion ? `${pkgName}@${pkgVersion}` : pkgName || "dependency";
  return trimMessage(`${where}: ${id}${aliasStr}. ${summary}`);
}

function trimMessage(m: string): string {
  const collapsed = m.replace(/\s+/g, " ").trim();
  return collapsed.length > 500 ? collapsed.slice(0, 497) + "..." : collapsed;
}
