// The scan pipeline every command shares: find the repo, load the config,
// work out the change, run the scanners on it. Progress goes to stderr.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  findRepoRoot,
  getChange,
  loadConfig,
  renderJson,
  renderMarkdown,
  renderSarif,
  renderTerminal,
} from "@openqodex/core";
import type { Change, ChangeScope, Config, Report, ScanResult, ScannerSource } from "@openqodex/core";
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
  return { repoRoot, config, change, scan, secrets };
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
    writeFileSync(resolve(flags.output), text);
  } else {
    process.stdout.write(text);
  }
}

export function exitFor(report: Report): number {
  return report.verdict === "blocked" ? EXIT_FINDINGS : EXIT_OK;
}
