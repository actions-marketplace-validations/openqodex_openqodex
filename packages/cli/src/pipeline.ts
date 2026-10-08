// The scan pipeline every command shares: find the repo, load the config,
// work out the change, run the scanners on it. Progress goes to stderr.
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, lstatSync, openSync, readSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import {
  DIFF_CAP_BYTES,
  OpenQodexError,
  STATE_DIR,
  DEFAULT_CONFIG,
  findRepoRoot,
  getChange,
  isRepoState,
  loadConfig,
  loadLensCatalog,
  redactSecrets,
  renderHtml,
  renderJson,
  renderMarkdown,
  renderReceipt,
  renderReview,
  renderSarif,
  renderTerminal,
  safeGit,
  selectLensesForDiff,
  writeRepoFile,
} from "@openqodex/core";
import type { Change, ChangeScope, Config, Display, HotSpot, ImpactSummary, Report, RuleCoverage, ScanResult, ScannerSource, SelectedLens, WholeRepo } from "@openqodex/core";
import { buildGraph, detectImpact, emptyImpact, hotSymbols, langOf } from "@openqodex/graph";
import type { Graph } from "@openqodex/graph";
import { createToolResolver, customAdapters, runScanners } from "@openqodex/scanners";
import { Guard } from "./agents/guarded-fs.js";
import { instructionsTemplate } from "./agents/repo-folder.js";
import { EXIT_FINDINGS, EXIT_OK, EXIT_TOOL_FAILED } from "./exit-codes.js";
import { readInstructions, readInstructionsAt } from "./instructions.js";
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
  // The rules scanners that ran checked, token to files, for the lenses.
  checked: Map<string, Set<string>>;
};

// Whether a scanner rule ran on a file in this run: a lens that rule covers
// stands down for that file.
export function ruleCoverage(p: PipelineResult): RuleCoverage {
  return (token, file) => p.checked.get(token)?.has(file) ?? false;
}

// `checkoutSettings` false (`--report-dir`): without `--config` the built-in
// defaults, never the repository's own file, so nothing under .openqodex/
// in the checkout is read.
export async function loadRepo(flags: GlobalFlags, checkoutSettings = true): Promise<{ repoRoot: string; config: Config }> {
  const repoRoot = await findRepoRoot(flags.cwd);
  if (!checkoutSettings && flags.config === undefined) return { repoRoot, config: structuredClone(DEFAULT_CONFIG) };
  const loaded = loadConfig(repoRoot, flags.config, { runtimeVersion: __OPENQODEX_VERSION__ });
  for (const w of loaded.warnings) warn(`openqodex: ${w}`);
  return { repoRoot, config: loaded.config };
}

export async function runPipeline(args: {
  scope: ChangeScope;
  flags: GlobalFlags;
  only?: ScannerSource[];
  skip?: ScannerSource[];
  checkoutSettings?: boolean;
}): Promise<PipelineResult> {
  const { repoRoot, config } = await loadRepo(args.flags, args.checkoutSettings);
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
  // How long a scanner still downloading is waited for; INSTALL_BUDGET_MS
  // unless the caller says otherwise (the review init ends with).
  installBudgetMs?: number;
}): Promise<PipelineResult & { change: C }> {
  const { repoRoot, config, change, flags } = args;
  const workDir = args.workDir ?? repoRoot;
  if (change.files.length === 0) return { repoRoot, workDir, config, change, scan: null, secrets: [], checked: new Map() };

  const onProgress = progress(flags);
  const { scan, secrets, checked } = await runScanners({
    repoDir: workDir,
    changedPaths: change.changedPaths,
    coverage: args.wholeRepo ? undefined : change.coverage,
    deletionPoints: change.deletionPoints,
    baseText: async (path) => {
      const r = await safeGit(repoRoot, ["show", "--no-textconv", `${change.baseSha}:${path}`]);
      return r.code === 0 ? r.stdout.toString("utf8") : null;
    },
    config,
    resolveTool: createToolResolver({
      allowInstall: !flags.noInstall,
      installBudgetMs: args.installBudgetMs ?? INSTALL_BUDGET_MS,
      onProgress,
    }),
    // Approvals and the scanner list belong to the developer's repository and
    // its config; an approved scanner runs in workDir, where the files are.
    custom: config.custom.length > 0 ? customAdapters(repoRoot, config) : [],
    only: args.only,
    skip: args.skip,
    onProgress,
  });
  noteScan(repoRoot, scan);
  return { repoRoot, workDir, config, change, scan: redactStored(scan, secrets), secrets, checked };
}

// Every string in the scan passes through the secret redaction before it is
// kept or written: the runner redacts messages, but a matched secret can sit
// in any other string too (a file name). Candidate ids and tokens are the
// citations finalize matches on and are kept as they are.
export function redactStored<T>(value: T, secrets: string[]): T {
  return secrets.length === 0 ? value : redactWith(value, (text) => redactSecrets(text, secrets));
}

// The scanner citations finalize matches on, kept as the scan wrote them:
// a candidate's `id` and `token`, at exactly these paths of a scan result or
// a report (a number stands for any index). Every other string is redacted,
// a field named `id` or `token` anywhere else included (a symbol id of the
// code graph, a field the reviewer made up).
const CITATIONS: string[][] = [
  ["candidates", "#", "id"],
  ["candidates", "#", "token"],
  ["not_reviewed", "#", "id"],
  ["not_reviewed", "#", "token"],
  ["dropped", "#", "candidate", "id"],
  ["dropped", "#", "candidate", "token"],
];

function isCitation(path: string[]): boolean {
  return CITATIONS.some((c) => c.length === path.length && c.every((part, i) => part === path[i]));
}

// Every string in `value` through `redact`, but the scanner citations: the
// same walk for every caller.
export function redactWith<T>(value: T, redact: (text: string) => string): T {
  const walk = (v: unknown, path: string[]): unknown => {
    if (typeof v === "string") return isCitation(path) ? v : redact(v);
    if (Array.isArray(v)) return v.map((x) => walk(x, [...path, "#"]));
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, [...path, k])]));
    }
    return v;
  };
  return walk(value, []) as T;
}

export type ReviewOutputs = {
  // The report every output is drawn from, after the redaction.
  report: Report;
  // report.html and report.md as the receipt prints them, after the redaction.
  paths: { html: string; md: string };
  // report.md, report.json, report.sarif and report.html, to write as they are.
  files: Record<string, string>;
  // sha256 of report.json's text, for the home record `findings` checks.
  reportSha256: string;
};

// Every output of a finished review, from one redaction pass: every string
// of the report (the summary, each finding with its file name and suggested
// change, the dropped reasons and the scanners' messages) and the run
// folder's paths go through `redact` once, and every file and the receipt
// (renderReceipt over `report` and `paths`) are drawn from what came out.
// `redact`: by the matched secrets in a review run here (redactSecrets), by
// their saved fingerprints in a two-step finalize (redactByFingerprint);
// both remove every line of a multi-line secret too. `display` is redacted
// when it is built.
export function reviewOutputs(args: { report: Report; display: Display | null; dir: string; redact: (text: string) => string; version: string }): ReviewOutputs {
  const report = redactWith(args.report, args.redact);
  const paths = { html: args.redact(join(args.dir, "report.html")), md: args.redact(join(args.dir, "report.md")) };
  const files: Record<string, string> = { ...reportFiles(report), "report.html": renderHtml({ report, display: args.display, version: args.version, reportMd: paths.md }) };
  return { report, paths, files, reportSha256: createHash("sha256").update(files["report.json"] as string, "utf8").digest("hex") };
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

// The four report files every finished run writes. A review `review` ran
// with its own reviewer has the standard report; a scan and a legacy review
// keep theirs.
export function reportFiles(report: Report): Record<string, string> {
  return {
    "report.md": report.completion ? renderReview(report, { format: "markdown" }) : renderMarkdown(report),
    "report.json": renderJson(report),
    "report.sarif": renderSarif(report),
  };
}

// The chosen format to stdout, or to --output.
export function emitReport(report: Report, flags: GlobalFlags, repoRoot: string): void {
  const color = flags.color && flags.output === undefined;
  const text =
    flags.format === "markdown"
      ? report.completion
        ? renderReview(report, { format: "markdown" })
        : renderMarkdown(report)
      : flags.format === "json"
        ? renderJson(report)
        : flags.format === "sarif"
          ? renderSarif(report)
          : report.completion
            ? renderReview(report, { format: "terminal", color })
            : renderTerminal(report, { color });
  if (flags.output !== undefined) writeOutFile(resolve(flags.output), repoRoot, text);
  else process.stdout.write(text);
}

// What a finished review prints. The default terminal format is the
// receipt: the verdict, one line per finding and the absolute paths of
// report.html and report.md, so the developer reads the review there and
// names what to fix. An explicit markdown, json or sarif format is the whole
// report in that format, as before (the Action and scripts read it), and the
// two paths go to stderr, where --quiet keeps them: they are results, not
// progress. --output writes the chosen text to a file instead of stdout.
export function emitReview(report: Report, flags: GlobalFlags, repoRoot: string, paths: { html: string; md: string }): void {
  if (flags.format !== "terminal") {
    emitReport(report, flags, repoRoot);
    warn(`Report: ${paths.html}`);
    warn(`Markdown: ${paths.md}`);
    return;
  }
  const text = renderReceipt(report, { ...paths, color: flags.color && flags.output === undefined });
  if (flags.output !== undefined) writeOutFile(resolve(flags.output), repoRoot, text);
  else process.stdout.write(text);
}

// report.html, written before anything announces the review. False, with
// one line on stderr, when it could not be written: the caller then records
// no review, prints no receipt and exits 2.
export function writeReportHtml(write: (files: Record<string, string>) => void, html: string): boolean {
  try {
    write({ "report.html": html });
    return true;
  } catch (error) {
    warn(`openqodex: could not write report.html (${(error as Error).message.split("\n")[0]}); report.md and report.json beside it hold the review, which is not recorded for the push hooks`);
    return false;
  }
}

// A temp file beside it, then a rename: an existing entry, a symbolic link
// included, is replaced and never written through. Into the repo state:
// through the repo state writer, never through a link. A report quotes the
// code, so the file is created readable by its owner only.
function writeOutFile(out: string, repoRoot: string, text: string, mode = 0o600): void {
  const state = isRepoState(repoRoot, out);
  if (state !== null) {
    writeRepoFile(repoRoot, state, text, { mode });
    return;
  }
  const tmp = join(dirname(out), `.${basename(out)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, text, { flag: "wx", mode });
    renameSync(tmp, out);
  } finally {
    rmSync(tmp, { force: true });
  }
}

// `--report-dir <folder>` of scan and review: the run's files, written to a
// folder the caller names instead of .openqodex/reviews/, readable by their
// owner only. The GitHub Action names a new folder of its own, so it never
// takes a report that a branch committed under .openqodex/ for this run's.
//
// The folder must be reached through no symbolic link but the system's own
// aliases: each part of its path, from the root, is looked at without
// following it, and the only links allowed are /var, /tmp and /etc on macOS
// pointing at their folders under /private, where the walk goes on and
// allows no further link. Any other link, whoever owns it, stops the
// command before anything is made or written: a link a repository or
// anyone else put there would send the run's files where it points. In a
// folder that is there already, a file that is a link stops it too.
//
// The writer that comes back holds a guard (agents/guarded-fs.ts) whose one
// root is that folder, as it is now: every file is written through a
// checked handle into that very folder, so a link swapped in later, at the
// folder or at a file in it, that leads anywhere else is refused.
const SYSTEM_ALIASES: Record<string, string> = { "/var": "/private/var", "/tmp": "/private/tmp", "/etc": "/private/etc" };

// Whether the link at `path` reading `target` is one of the system's own aliases.
export function systemAlias(path: string, target: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" && Object.hasOwn(SYSTEM_ALIASES, path) && resolve(sep, target) === SYSTEM_ALIASES[path];
}

export function checkReportFolder(folder: string): string {
  const dir = resolve(folder);
  const refuse = (at: string) => new OpenQodexError(`--report-dir ${folder}: ${at} is a symbolic link; name a folder reached through no link`);
  const realFolder = (at: string): void => {
    const st = lstatSync(at, { throwIfNoEntry: false });
    if (st?.isSymbolicLink()) throw refuse(at);
    if (st !== undefined && !st.isDirectory()) throw new OpenQodexError(`--report-dir ${folder}: ${at} is not a folder`);
  };
  let at = parse(dir).root;
  for (const part of dir.slice(at.length).split(sep).filter((p) => p !== "")) {
    const next = join(at, part);
    const st = lstatSync(next, { throwIfNoEntry: false });
    if (st === undefined) break;
    if (st.isSymbolicLink()) {
      if (!systemAlias(next, readlinkSync(next))) throw refuse(next);
      // The alias's own target, each part of it a real folder.
      at = parse(next).root;
      for (const p of SYSTEM_ALIASES[next]!.split(sep).filter((x) => x !== "")) {
        at = join(at, p);
        realFolder(at);
      }
      continue;
    }
    realFolder(next);
    at = next;
  }
  if (lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isSymbolicLink()) throw refuse(join(dir, e.name));
  }
  return dir;
}

export function reportFolderWriter(folder: string): (files: Record<string, string>) => void {
  const dir = checkReportFolder(folder);
  const guard = new Guard({ repoRoot: null, gitFolders: [], roots: [dir] });
  return (files) => {
    for (const [name, text] of Object.entries(files)) {
      if (name !== basename(name) || name.startsWith(".")) throw new Error(`not a plain file name: ${name}`);
      if (lstatSync(join(dir, name), { throwIfNoEntry: false })?.isSymbolicLink()) throw new OpenQodexError(`--report-dir ${folder}: ${join(dir, name)} is a symbolic link; openqodex does not write through it`);
      guard.write(join(dir, name), text, { mode: 0o600 });
    }
  };
}

export function writeReportCopies(folder: string, files: Record<string, string>): void {
  reportFolderWriter(folder)(files);
}

export function exitFor(report: Report): number {
  if (report.verdict === "incomplete") return EXIT_TOOL_FAILED;
  return report.verdict === "blocked" ? EXIT_FINDINGS : EXIT_OK;
}

// sha256 of the instructions file, null when there is none. Finalize compares
// it with the brief's, so a review always follows the instructions as they are.
export function instructionsHash(text: string): string | null {
  return text === "" ? null : createHash("sha256").update(text).digest("hex");
}

// The owners' instructions as the brief takes them, and their hash: from the
// repository's file, or from the file `review --instructions` names. The
// untouched template says nothing about this repo: no block for it.
export function ownersInstructions(repoRoot: string, secrets: string[], path?: string): { text: string; hash: string | null } {
  const raw = path === undefined ? readInstructions(repoRoot) : readInstructionsAt(repoRoot, path);
  return { text: raw === "" || raw === instructionsTemplate() ? "" : redactSecrets(raw, secrets), hash: instructionsHash(raw) };
}

// The lens triggers over the whole repo: every line counts as changed. Each
// text file contributes its first bytes, an equal share of the 5 MB the
// brief's diff may carry, so a late file is sampled as fully as an early
// one; the matches are then ranked and capped as for a change.
const LENS_SAMPLE_MIN_BYTES = 1024;

export function wholeRepoLenses(change: WholeRepo, covered?: RuleCoverage): SelectedLens[] {
  const text = [...change.lines.keys()];
  const share = Math.max(LENS_SAMPLE_MIN_BYTES, Math.floor(DIFF_CAP_BYTES / Math.max(1, text.length)));
  const buf = Buffer.alloc(share);
  let diff = "";
  for (const path of text) {
    let fd: number;
    try {
      fd = openSync(join(change.repoRoot, path), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      continue;
    }
    let read = 0;
    try {
      read = readSync(fd, buf, 0, share, 0);
    } catch {
      // unreadable now: it contributes nothing
    } finally {
      closeSync(fd);
    }
    for (const line of buf.subarray(0, read).toString("utf8").split("\n")) diff += `+${line}\n`;
  }
  return selectLensesForDiff({ diff, files: change.changedPaths, catalog: loadLensCatalog(), covered });
}
