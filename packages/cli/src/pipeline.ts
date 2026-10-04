// The scan pipeline every command shares: find the repo, load the config,
// work out the change, run the scanners on it. Progress goes to stderr.
import { randomBytes } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  STATE_DIR,
  findRepoRoot,
  getChange,
  isRepoState,
  loadConfig,
  redactSecrets,
  renderJson,
  renderMarkdown,
  renderSarif,
  renderTerminal,
  writeRepoFile,
} from "@openqodex/core";
import type { Change, ChangeScope, Config, HotSpot, ImpactSummary, Report, ScanResult, ScannerSource } from "@openqodex/core";
import { buildGraph, detectImpact, emptyImpact, hotSymbols, langOf } from "@openqodex/graph";
import type { Graph } from "@openqodex/graph";
import { createToolResolver, customAdapters, runScanners } from "@openqodex/scanners";
import { EXIT_FINDINGS, EXIT_OK } from "./exit-codes.js";
import { noteScan } from "./feedback.js";
import type { GlobalFlags } from "./flags.js";

export const INSTALL_BUDGET_MS = 45_000;

export function progress(flags: GlobalFlags): (line: string) => void {
  return (line) => {
    if (!flags.quiet) process.stderr.write(`${line}\n`);
  };
}

export function warn(line: string): void {
  process.stderr.write(`${line}\n`);
}

export type PipelineResult = {
  // The developer's repository: its config, its run folders, its approvals.
  repoRoot: string;
  // Where the changed files are read and the scanners run: repoRoot, or the
  // temporary checkout of a branch or a pull request under review.
  workDir: string;
  config: Config;
  change: Change;
  // null when the change is empty and nothing was scanned.
  scan: ScanResult | null;
  // Raw matched secrets, in memory only. Never written or printed.
  secrets: string[];
};

export async function loadRepo(flags: GlobalFlags): Promise<{ repoRoot: string; config: Config }> {
  const repoRoot = await findRepoRoot(flags.cwd);
  const loaded = loadConfig(repoRoot, flags.config);
  for (const w of loaded.warnings) warn(`openqodex: ${w}`);
  return { repoRoot, config: loaded.config };
}

export async function runPipeline(args: {
  scope: ChangeScope;
  flags: GlobalFlags;
  only?: ScannerSource[];
  skip?: ScannerSource[];
}): Promise<PipelineResult> {
  const { repoRoot, config } = await loadRepo(args.flags);
  const change = await getChange({ repoRoot, scope: args.scope, exclude: config.exclude, defaultBase: config.defaultBase });
  return scanChange({ ...args, repoRoot, config, change });
}

// The scanners on a change already worked out. For the whole repository no
// coverage is passed: every finding in a file of the inventory is kept.
export async function scanChange<C extends Change>(args: {
  repoRoot: string;
  workDir?: string;
  config: Config;
  change: C;
  wholeRepo?: boolean;
  flags: GlobalFlags;
  only?: ScannerSource[];
  skip?: ScannerSource[];
}): Promise<PipelineResult & { change: C }> {
  const { repoRoot, config, change, flags } = args;
  const workDir = args.workDir ?? repoRoot;
  if (change.files.length === 0) return { repoRoot, workDir, config, change, scan: null, secrets: [] };

  const onProgress = progress(flags);
  const { scan, secrets } = await runScanners({
    repoDir: workDir,
    changedPaths: change.changedPaths,
    coverage: args.wholeRepo ? undefined : change.coverage,
    config,
    resolveTool: createToolResolver({
      allowInstall: !flags.noInstall,
      installBudgetMs: INSTALL_BUDGET_MS,
      onProgress,
    }),
    // Approvals belong to the developer's repository; an approved scanner
    // runs in workDir, where the files are.
    custom: config.custom.length > 0 ? customAdapters(repoRoot, config) : [],
    only: args.only,
    skip: args.skip,
    onProgress,
  });
  noteScan(repoRoot, scan);
  return { repoRoot, workDir, config, change, scan: redactStored(scan, secrets), secrets };
}

// Every string in the scan passes through the secret redaction before it is
// kept or written: the runner redacts messages, but a matched secret can sit
// in any other string too (a file name). Candidate ids and tokens are the
// citations finalize matches on and are kept as they are.
export function redactStored<T>(value: T, secrets: string[]): T {
  const walk = (v: unknown, key: string | null): unknown => {
    if (typeof v === "string") return key === "id" || key === "token" ? v : redactSecrets(v, secrets);
    if (Array.isArray(v)) return v.map((x) => walk(x, null));
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    }
    return v;
  };
  return secrets.length === 0 ? value : (walk(value, null) as T);
}

// The graph for this run, or the summary saying why there is none. For the
// whole repo (no base) it reads only the inventory. Never
// throws: a graph that cannot be built is reported as "failed" with one line
// and the review goes on.
async function graphFor(p: PipelineResult, flags: GlobalFlags, noGraph: boolean, withBase: boolean): Promise<Graph | ImpactSummary> {
  if (noGraph) return emptyImpact("off", "--no-graph was given");
  if (!p.config.graph.enabled) return emptyImpact("off", "graph.enabled is false in the config");
  if (!p.change.files.some((f) => langOf(f.path) !== null || (f.oldPath !== null && langOf(f.oldPath) !== null))) {
    return emptyImpact("skipped", `no ${withBase ? "changed " : ""}file is TypeScript, JavaScript, Python, Go or Ruby`);
  }
  try {
    return await buildGraph({
      repoRoot: p.workDir,
      files: withBase ? p.change.changedPaths : undefined,
      only: withBase ? undefined : p.change.changedPaths,
      budgetMs: p.config.graph.budgetMs,
      maxFiles: p.config.graph.maxFiles,
      maxFileBytes: p.config.graph.maxFileBytes,
      cacheDir: join(p.workDir, STATE_DIR, "graph"),
      onProgress: progress(flags),
      base: withBase ? { sha: p.change.baseSha, files: p.change.files } : undefined,
    });
  } catch (error) {
    const reason = ((error as Error).message ?? String(error)).split("\n")[0] ?? "unknown error";
    warn(`openqodex: the code graph could not be built: ${reason}`);
    return emptyImpact("failed", reason);
  }
}

const isGraph = (g: Graph | ImpactSummary): g is Graph => "nodes" in g;

// The code graph's view of the change.
export async function buildImpact(p: PipelineResult, flags: GlobalFlags, noGraph: boolean): Promise<ImpactSummary> {
  const graph = await graphFor(p, flags, noGraph, true);
  return isGraph(graph) ? redactStored(detectImpact(graph, p.change), p.secrets) : graph;
}

const HOT_SYMBOLS = 20;
const SITES_PER_HOT_SYMBOL = 3;

// For the whole repository: every file is touched, so the impact of the
// change would list everything. The graph is built once (which also warms
// its cache for later change reviews), the impact is taken over an empty
// change for its build counts, and the most-called symbols say where to start.
export async function buildHotSpots(
  p: PipelineResult,
  flags: GlobalFlags,
  noGraph: boolean,
): Promise<{ impact: ImpactSummary; hot: HotSpot[]; note: string | null }> {
  const graph = await graphFor(p, flags, noGraph, false);
  if (!isGraph(graph)) {
    const lead = graph.status === "off" ? "The code graph is off" : graph.status === "skipped" ? "The code graph was skipped" : "The code graph could not be built";
    return { impact: graph, hot: [], note: `${lead}: ${graph.reasons.join("; ")}. Find the most-used code with your own tools.` };
  }
  const impact = redactStored(detectImpact(graph, { files: [], coverage: new Map() }), p.secrets);
  const hot = hotSymbols(graph, HOT_SYMBOLS).map((h) => ({
    name: h.symbol.name,
    kind: h.symbol.kind,
    file: h.symbol.file,
    line: h.symbol.startLine,
    callers: h.callers,
    sites: (graph.in.get(h.symbol.id) ?? [])
      .flatMap((e) => e.sites)
      .slice(0, SITES_PER_HOT_SYMBOL)
      .map((s) => `${s.file}:${s.line}`),
  }));
  const note =
    impact.status === "partial"
      ? `The graph is partial: ${impact.reasons.join("; ")}. Callers in the files left out are missing from the counts.`
      : null;
  return { impact, hot: redactStored(hot, p.secrets), note };
}

export function nothingToReview(change: Change): number {
  warn(`Nothing to review: no changes against ${change.baseRef}`);
  return EXIT_OK;
}

// The four report files every finished run writes.
export function reportFiles(report: Report): Record<string, string> {
  return {
    "report.md": renderMarkdown(report),
    "report.json": renderJson(report),
    "report.sarif": renderSarif(report),
  };
}

// The chosen format to stdout, or to --output.
export function emitReport(report: Report, flags: GlobalFlags, repoRoot: string): void {
  const text =
    flags.format === "markdown"
      ? renderMarkdown(report)
      : flags.format === "json"
        ? renderJson(report)
        : flags.format === "sarif"
          ? renderSarif(report)
          : renderTerminal(report, { color: flags.color && flags.output === undefined });
  if (flags.output !== undefined) {
    // A temp file beside it, then a rename: an existing entry, a symbolic
    // link included, is replaced and never written through.
    const out = resolve(flags.output);
    // Into the repo state: through the repo state writer, never through a link.
    const state = isRepoState(repoRoot, out);
    if (state !== null) {
      writeRepoFile(repoRoot, state, text);
      return;
    }
    const tmp = join(dirname(out), `.${basename(out)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    try {
      writeFileSync(tmp, text, { flag: "wx" });
      renameSync(tmp, out);
    } finally {
      rmSync(tmp, { force: true });
    }
  } else {
    process.stdout.write(text);
  }
}

export function exitFor(report: Report): number {
  return report.verdict === "blocked" ? EXIT_FINDINGS : EXIT_OK;
}
