// The scan pipeline every command shares: find the repo, load the config,
// work out the change, run the scanners on it. Progress goes to stderr.
import { randomBytes } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  STATE_DIR,
  findRepoRoot,
  getChange,
  loadConfig,
  redactSecrets,
  renderJson,
  renderMarkdown,
  renderSarif,
  renderTerminal,
} from "@openqodex/core";
import type { Change, ChangeScope, Config, ImpactSummary, Report, ScanResult, ScannerSource } from "@openqodex/core";
import { buildGraph, detectImpact, emptyImpact, langOf } from "@openqodex/graph";
import { createToolResolver, customAdapters, runScanners } from "@openqodex/scanners";
import { EXIT_FINDINGS, EXIT_OK } from "./exit-codes.js";
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
  repoRoot: string;
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
  const { flags } = args;
  const { repoRoot, config } = await loadRepo(flags);
  const change = await getChange({ repoRoot, scope: args.scope, exclude: config.exclude });
  if (change.files.length === 0) return { repoRoot, config, change, scan: null, secrets: [] };

  const onProgress = progress(flags);
  const { scan, secrets } = await runScanners({
    repoDir: repoRoot,
    changedPaths: change.changedPaths,
    coverage: change.coverage,
    config,
    resolveTool: createToolResolver({
      allowInstall: !flags.noInstall,
      installBudgetMs: INSTALL_BUDGET_MS,
      onProgress,
    }),
    custom: config.custom.length > 0 ? customAdapters(repoRoot, config) : [],
    only: args.only,
    skip: args.skip,
    onProgress,
  });
  return { repoRoot, config, change, scan: redactStored(scan, secrets), secrets };
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

// The code graph's view of the change. Never throws: a graph that cannot be
// built is reported as "failed" with one line and the review goes on.
export async function buildImpact(p: PipelineResult, flags: GlobalFlags, noGraph: boolean): Promise<ImpactSummary> {
  if (noGraph) return emptyImpact("off", "--no-graph was given");
  if (!p.config.graph.enabled) return emptyImpact("off", "graph.enabled is false in the config");
  if (!p.change.files.some((f) => langOf(f.path) !== null || (f.oldPath !== null && langOf(f.oldPath) !== null))) {
    return emptyImpact("skipped", "no changed file is TypeScript, JavaScript, Python, Go or Ruby");
  }
  try {
    const graph = await buildGraph({
      repoRoot: p.repoRoot,
      files: p.change.changedPaths,
      budgetMs: p.config.graph.budgetMs,
      maxFiles: p.config.graph.maxFiles,
      maxFileBytes: p.config.graph.maxFileBytes,
      cacheDir: join(p.repoRoot, STATE_DIR, "graph"),
      onProgress: progress(flags),
      base: { sha: p.change.baseSha, files: p.change.files },
    });
    return redactStored(detectImpact(graph, p.change), p.secrets);
  } catch (error) {
    const reason = ((error as Error).message ?? String(error)).split("\n")[0] ?? "unknown error";
    warn(`openqodex: the code graph could not be built: ${reason}`);
    return emptyImpact("failed", reason);
  }
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
export function emitReport(report: Report, flags: GlobalFlags): void {
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
