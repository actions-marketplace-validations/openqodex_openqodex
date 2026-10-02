// `openqodex review`:
//   --agent            scan, then write the brief for the host agent and print it
//   --finalize [path]  check the agent's findings without a model and write the report
//   neither            the same as `scan`, plus how to get the AI review
//   --all              the whole repository instead of the change: the scanners
//                      on every file, then the brief, with or without --agent.
//                      There is never a scan-only report of the whole repo.
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  OpenQodexError,
  DIFF_CAP_BYTES,
  INVENTORY_FILE,
  buildBrief,
  buildInventory,
  buildWholeRepoBrief,
  configHash,
  finalizeReview,
  getChange,
  getWholeRepo,
  loadLensCatalog,
  openReportDir,
  readLatest,
  readManifest,
  readScan,
  STATE_DIR,
  selectLenses,
  selectLensesForDiff,
  writeLatest,
  writeManifest,
  writeReportFiles,
  writeScan,
} from "@openqodex/core";
import type { Change, ChangeScope, ImpactSummary, SelectedLens, WholeRepo } from "@openqodex/core";
import { renderImpactBlock } from "@openqodex/graph";
import { EXIT_OK } from "../exit-codes.js";
import { ALL, NO_GRAPH, parseFlags, scannerList } from "../flags.js";
import type { GlobalFlags } from "../flags.js";
import {
  buildHotSpots,
  buildImpact,
  emitReport,
  exitFor,
  loadRepo,
  nothingToReview,
  redactStored,
  reportFiles,
  runPipeline,
  scanChange,
  warn,
} from "../pipeline.js";
import { SCOPE_BOOLS, SCOPE_VALUES, runScan, scopeFrom } from "./scan.js";

const FINDINGS_FILE = "agent-findings.json";
const IMPACT_FILE = "impact.json";
const RUN_FILE = "run.json";
const RUN_AGAIN = "run openqodex review --agent first";

// run.json beside the manifest: the scope the brief was made with, so
// finalize recomputes the same change ("all" for the whole repository).
type RunFile = { version: 1; scope: ChangeScope | "all" };

export async function run(args: string[]): Promise<number> {
  const { global, bools, values, positionals } = parseFlags(args, {
    bools: [...SCOPE_BOOLS, "--agent", "--finalize", ALL, NO_GRAPH],
    values: [...SCOPE_VALUES, "--only", "--skip"],
    positionals: 1,
  });
  const agent = bools.has("--agent");
  const finalize = bools.has("--finalize");
  const noGraph = bools.has(NO_GRAPH);
  if (agent && finalize) throw new OpenQodexError("--agent and --finalize cannot be used together");
  if (positionals.length > 0 && !finalize) throw new OpenQodexError(`unexpected argument: ${positionals[0]}`);
  if (bools.has(ALL) && (values.has("--base") || bools.has("--uncommitted"))) {
    throw new OpenQodexError("--all reviews the whole repository and cannot be used with --base or --uncommitted");
  }

  // Finalize reads the scope from the run, so --all changes nothing there.
  if (finalize) return runFinalize(global, positionals[0]);
  if (bools.has(ALL)) return runAll(global, agent, values.get("--only"), values.get("--skip"), noGraph);
  const scope = scopeFrom(bools, values);
  if (agent) return runAgent(global, scope, values.get("--only"), values.get("--skip"), noGraph);

  const outcome = await runScan({ flags: global, scope, only: values.get("--only"), skip: values.get("--skip") });
  if (outcome.report !== null) warn("For the AI review, ask your coding agent: review my change with openqodex");
  return outcome.exitCode;
}

// Quoted for a POSIX shell: the agent pastes this line as it is.
function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

// The exact command that finalizes this run, from any folder: the repo and an
// explicit config are named so the config hash and the change match.
function finalizeCommand(repoRoot: string, config: string | undefined, findingsPath: string): string {
  const args = ["npx", "-y", `openqodex@${__OPENQODEX_VERSION__}`, "review", "--finalize", "--cwd", repoRoot];
  if (config !== undefined) args.push("--config", isAbsolute(config) ? config : resolve(repoRoot, config));
  args.push(findingsPath);
  return args.map(shellQuote).join(" ");
}

async function runAgent(flags: GlobalFlags, scope: ChangeScope, only: string | undefined, skip: string | undefined, noGraph: boolean): Promise<number> {
  const p = await runPipeline({
    scope,
    flags,
    only: scannerList("--only", only),
    skip: scannerList("--skip", skip),
  });
  if (p.scan === null) return nothingToReview(p.change);

  const lenses = selectLenses(p.change);
  const dir = openReportDir(p.repoRoot, p.change.shortId);
  writeManifest(dir, {
    version: 1,
    change_id: p.change.id,
    config_hash: configHash(p.config),
    created_at: new Date().toISOString(),
    lenses: lenses.map((l) => ({ name: l.name, confidenceFloor: l.confidenceFloor })),
  });
  writeScan(dir, p.scan);
  const impact = await buildImpact(p, flags, noGraph);
  const brief = buildBrief({
    change: p.change,
    scan: p.scan,
    lenses,
    config: p.config,
    secrets: p.secrets,
    findingsPath: join(dir, FINDINGS_FILE),
    finalizeCommand: finalizeCommand(p.repoRoot, flags.config, join(dir, FINDINGS_FILE)),
    impactBlock: renderImpactBlock(impact),
  });
  const runFile: RunFile = { version: 1, scope };
  writeReportFiles(dir, {
    [RUN_FILE]: `${JSON.stringify(runFile, null, 2)}\n`,
    "candidates.json": `${JSON.stringify(p.scan.candidates, null, 2)}\n`,
    [IMPACT_FILE]: `${JSON.stringify(impact, null, 2)}\n`,
    "brief.md": brief,
  });
  writeLatest(p.repoRoot, {
    dir: relative(p.repoRoot, dir),
    change_id: p.change.id,
    kind: "review",
    finalized: false,
    verdict: null,
  });
  process.stdout.write(brief);
  return EXIT_OK;
}

// Every line of every text file counts as changed for the lens triggers, the
// same rule finalize applies, up to the size the brief's diff may carry.
function wholeRepoLenses(change: Change): SelectedLens[] {
  const text: string[] = [];
  let bytes = 0;
  for (const path of change.changedPaths) {
    if (!change.coverage.has(path)) continue;
    let body: string;
    try {
      body = readFileSync(join(change.repoRoot, path), "utf8");
    } catch {
      continue;
    }
    bytes += Buffer.byteLength(body, "utf8");
    if (bytes > DIFF_CAP_BYTES) break;
    text.push(...body.split("\n").map((l) => `+${l}`));
  }
  return selectLensesForDiff({ diff: text.join("\n"), files: change.changedPaths, catalog: loadLensCatalog() });
}

async function runAll(flags: GlobalFlags, agent: boolean, only: string | undefined, skip: string | undefined, noGraph: boolean): Promise<number> {
  const { repoRoot, config } = await loadRepo(flags);
  const whole = await getWholeRepo({ repoRoot, exclude: config.exclude });
  const p = await scanChange<WholeRepo>({
    repoRoot,
    config,
    change: whole,
    flags,
    only: scannerList("--only", only),
    skip: scannerList("--skip", skip),
  });
  if (p.scan === null) {
    warn("Nothing to review: the repository has no files");
    return EXIT_OK;
  }

  const lenses = wholeRepoLenses(p.change);
  const dir = openReportDir(repoRoot, p.change.shortId);
  writeManifest(dir, {
    version: 1,
    change_id: p.change.id,
    config_hash: configHash(config),
    created_at: new Date().toISOString(),
    lenses: lenses.map((l) => ({ name: l.name, confidenceFloor: l.confidenceFloor })),
  });
  writeScan(dir, p.scan);
  const { impact, hot, note } = await buildHotSpots(p, flags, noGraph);
  const inventory = buildInventory(p.change, p.scan);
  const brief = buildWholeRepoBrief({
    change: p.change,
    scan: p.scan,
    lenses,
    config,
    secrets: p.secrets,
    findingsPath: join(dir, FINDINGS_FILE),
    finalizeCommand: finalizeCommand(repoRoot, flags.config, join(dir, FINDINGS_FILE)),
    inventory,
    inventoryPath: join(dir, INVENTORY_FILE),
    hot,
    graphNote: note,
  });
  const runFile: RunFile = { version: 1, scope: "all" };
  writeReportFiles(dir, {
    [RUN_FILE]: `${JSON.stringify(runFile, null, 2)}\n`,
    "candidates.json": `${JSON.stringify(p.scan.candidates, null, 2)}\n`,
    [INVENTORY_FILE]: `${JSON.stringify(redactStored(inventory, p.secrets), null, 2)}\n`,
    [IMPACT_FILE]: `${JSON.stringify(impact, null, 2)}\n`,
    "brief.md": brief,
  });
  writeLatest(repoRoot, {
    dir: relative(repoRoot, dir),
    change_id: p.change.id,
    kind: "review",
    finalized: false,
    verdict: null,
  });
  process.stdout.write(brief);
  if (!agent) {
    process.stdout.write(
      "\nThis is the brief, not the review: the review is done when your coding agent writes its findings and runs the finalize command above. Ask it: review my whole repo with openqodex\n",
    );
  }
  return EXIT_OK;
}

// The graph's summary the brief was made with; null for a run from before the graph.
function readImpact(dir: string): ImpactSummary | null {
  const path = join(dir, IMPACT_FILE);
  if (!existsSync(path)) return null;
  const value = readJsonFile(path, "graph impact") as ImpactSummary | null;
  return value !== null && typeof value === "object" && value.version === 1 ? value : null;
}

function readJsonFile(path: string, what: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new OpenQodexError(`${what} not found at ${path}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new OpenQodexError(`${what} at ${path} is not valid JSON: ${(error as Error).message}`);
  }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

// The run folder must be a real folder directly under this repo's
// .openqodex/reviews/, reached through no symbolic link, and the findings
// file must not be a link either: finalize reads and writes only there.
function checkRunDir(repoRoot: string, dir: string, findingsPath: string): void {
  const state = join(repoRoot, STATE_DIR);
  const reviews = join(state, "reviews");
  const outside = new OpenQodexError(
    `${findingsPath} is not in a report folder under ${reviews}; write the findings where the brief says`,
  );
  if (isLink(state) || isLink(reviews) || isLink(dir) || isLink(findingsPath)) {
    throw new OpenQodexError(`a symbolic link in ${findingsPath}; openqodex reads and writes only real files there`);
  }
  let parent: string;
  let root: string;
  try {
    parent = realpathSync(dirname(dir));
    root = realpathSync(reviews);
  } catch {
    throw outside;
  }
  if (parent !== root || !lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw outside;
}

// The report folder this submission belongs to: the newest run when no path
// is given, else the folder that holds the findings file.
function findRun(repoRoot: string, path: string | undefined): { dir: string; submission: unknown } {
  let dir: string;
  let findingsPath: string;
  if (path === undefined) {
    const latest = readLatest(repoRoot);
    if (latest === null || typeof latest.dir !== "string") {
      throw new OpenQodexError(`no review brief found in this repository; ${RUN_AGAIN}`);
    }
    dir = resolve(repoRoot, latest.dir);
    findingsPath = join(dir, FINDINGS_FILE);
    checkRunDir(repoRoot, dir, findingsPath);
    if (readManifest(dir) === null) throw new OpenQodexError(`the newest run has no review brief; ${RUN_AGAIN}`);
    if (!existsSync(findingsPath)) {
      throw new OpenQodexError(`no agent findings at ${findingsPath}; write them there as the brief says, then run this again`);
    }
  } else {
    findingsPath = resolve(path);
    dir = dirname(findingsPath);
    checkRunDir(repoRoot, dir, findingsPath);
  }
  return { dir, submission: readJsonFile(findingsPath, "agent findings") };
}

async function runFinalize(flags: GlobalFlags, path: string | undefined): Promise<number> {
  const { repoRoot, config } = await loadRepo(flags);
  const { dir, submission } = findRun(repoRoot, path);
  const manifest = readManifest(dir);
  const scan = readScan(dir);
  const runFile = existsSync(join(dir, RUN_FILE)) ? (readJsonFile(join(dir, RUN_FILE), "run file") as RunFile) : null;
  if (manifest === null || scan === null || runFile === null) {
    throw new OpenQodexError(`the run in ${relative(repoRoot, dir)} has no review brief; ${RUN_AGAIN}`);
  }
  if (manifest.config_hash !== configHash(config)) {
    throw new OpenQodexError("the config changed since the brief (.openqodex.yaml or --config); run openqodex review --agent again");
  }
  const wholeRepo = runFile.scope === "all";
  const change =
    runFile.scope === "all"
      ? await getWholeRepo({ repoRoot, exclude: config.exclude })
      : await getChange({ repoRoot, scope: runFile.scope, exclude: config.exclude, defaultBase: config.defaultBase });
  // A whole-repo run has no change to trace, so its report carries no blast radius.
  const report = { ...finalizeReview({ change, scan, manifest, config, submission, wholeRepo }), impact: wholeRepo ? null : readImpact(dir) };

  writeReportFiles(dir, reportFiles(report));
  writeLatest(repoRoot, {
    dir: relative(repoRoot, dir),
    change_id: change.id,
    kind: "review",
    finalized: true,
    verdict: report.verdict,
  });
  emitReport(report, flags);
  return exitFor(report);
}
