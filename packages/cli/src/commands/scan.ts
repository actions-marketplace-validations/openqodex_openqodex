// `openqodex scan`: the scanners only, on the current change. Used by the
// git hook, the Action and pre-commit, and by `review` without --agent.
import { relative } from "node:path";
import { openReportDir, scanReport, writeLatestScan, writeReportFiles, writeScan } from "@openqodex/core";
import { announceRepoFiles } from "../agents/repo-folder.js";
import type { ChangeScope, Report } from "@openqodex/core";
import { parseFlags, scannerList } from "../flags.js";
import type { GlobalFlags } from "../flags.js";
import { emitReport, exitFor, nothingToReview, reportFiles, runPipeline } from "../pipeline.js";

export const SCOPE_BOOLS = ["--uncommitted"];
export const SCOPE_VALUES = ["--base"];

export function scopeFrom(bools: Set<string>, values: Map<string, string>): ChangeScope {
  const scope: ChangeScope = {};
  const base = values.get("--base");
  if (base !== undefined) scope.base = base;
  if (bools.has("--uncommitted")) scope.uncommitted = true;
  return scope;
}

export type ScanOutcome = { exitCode: number; report: Report | null; dir: string | null };

export async function runScan(args: {
  flags: GlobalFlags;
  scope: ChangeScope;
  only?: string;
  skip?: string;
}): Promise<ScanOutcome> {
  const { flags } = args;
  const p = await runPipeline({
    scope: args.scope,
    flags,
    only: scannerList("--only", args.only),
    skip: scannerList("--skip", args.skip),
  });
  announceRepoFiles(p.repoRoot);
  if (p.scan === null) return { exitCode: nothingToReview(p.change), report: null, dir: null };

  const report = scanReport({ change: p.change, scan: p.scan, config: p.config });
  const dir = openReportDir(p.repoRoot, p.change.shortId);
  writeScan(p.repoRoot, dir, p.scan);
  writeReportFiles(p.repoRoot, dir, reportFiles(report));
  // The scan receipt: the push gate reads only the review receipt, so a scan
  // never makes it forget a finalized review of the same change.
  writeLatestScan(p.repoRoot, {
    dir: relative(p.repoRoot, dir),
    change_id: p.change.id,
    kind: "scan",
    finalized: false,
    verdict: report.verdict,
  });
  emitReport(report, flags, p.repoRoot);
  return { exitCode: exitFor(report), report, dir };
}

export async function run(args: string[]): Promise<number> {
  const { global, bools, values } = parseFlags(args, {
    bools: SCOPE_BOOLS,
    values: [...SCOPE_VALUES, "--only", "--skip"],
  });
  const outcome = await runScan({
    flags: global,
    scope: scopeFrom(bools, values),
    only: values.get("--only"),
    skip: values.get("--skip"),
  });
  return outcome.exitCode;
}
