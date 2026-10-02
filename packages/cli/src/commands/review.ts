// `openqodex review`:
//   --agent            scan, then write the brief for the host agent and print it
//   --finalize [path]  check the agent's findings without a model and write the report
//   neither            the same as `scan`, plus how to get the AI review
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  OpenQodexError,
  buildBrief,
  configHash,
  finalizeReview,
  findReportDir,
  getChange,
  openReportDir,
  readLatest,
  readManifest,
  readScan,
  selectLenses,
  writeLatest,
  writeManifest,
  writeReportFiles,
  writeScan,
} from "@openqodex/core";
import type { ChangeScope } from "@openqodex/core";
import { EXIT_OK } from "../exit-codes.js";
import { parseFlags, scannerList } from "../flags.js";
import type { GlobalFlags } from "../flags.js";
import { emitReport, exitFor, loadRepo, nothingToReview, reportFiles, runPipeline, warn } from "../pipeline.js";
import { SCOPE_BOOLS, SCOPE_VALUES, runScan, scopeFrom } from "./scan.js";

const FINDINGS_FILE = "agent-findings.json";
const RUN_FILE = "run.json";
const RUN_AGAIN = "run openqodex review --agent first";

// run.json beside the manifest: the scope the brief was made with, so
// finalize recomputes the same change.
type RunFile = { version: 1; scope: ChangeScope };

export async function run(args: string[]): Promise<number> {
  const { global, bools, values, positionals } = parseFlags(args, {
    bools: [...SCOPE_BOOLS, "--agent", "--finalize"],
    values: [...SCOPE_VALUES, "--only", "--skip"],
    positionals: 1,
  });
  const agent = bools.has("--agent");
  const finalize = bools.has("--finalize");
  if (agent && finalize) throw new OpenQodexError("--agent and --finalize cannot be used together");
  if (positionals.length > 0 && !finalize) throw new OpenQodexError(`unexpected argument: ${positionals[0]}`);

  if (finalize) return runFinalize(global, positionals[0]);
  const scope = scopeFrom(bools, values);
  if (agent) return runAgent(global, scope, values.get("--only"), values.get("--skip"));

  const outcome = await runScan({ flags: global, scope, only: values.get("--only"), skip: values.get("--skip") });
  if (outcome.report !== null) warn("For the AI review, ask your coding agent: review my change with openqodex");
  return outcome.exitCode;
}

async function runAgent(flags: GlobalFlags, scope: ChangeScope, only?: string, skip?: string): Promise<number> {
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
  const brief = buildBrief({
    change: p.change,
    scan: p.scan,
    lenses,
    config: p.config,
    secrets: p.secrets,
    findingsPath: join(dir, FINDINGS_FILE),
    finalizeCommand: `npx -y openqodex@${__OPENQODEX_VERSION__} review --finalize`,
  });
  const runFile: RunFile = { version: 1, scope };
  writeReportFiles(dir, {
    [RUN_FILE]: `${JSON.stringify(runFile, null, 2)}\n`,
    "candidates.json": `${JSON.stringify(p.scan.candidates, null, 2)}\n`,
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

// The report folder this submission belongs to: the newest run when no path
// is given, else the newest run for the change id the submission names.
function findRun(repoRoot: string, path: string | undefined): { dir: string; findingsPath: string; submission: unknown } {
  if (path === undefined) {
    const latest = readLatest(repoRoot);
    if (latest === null) throw new OpenQodexError(`no review brief found in this repository; ${RUN_AGAIN}`);
    const dir = join(repoRoot, latest.dir);
    const findingsPath = join(dir, FINDINGS_FILE);
    if (readManifest(dir) === null) throw new OpenQodexError(`the newest run has no review brief; ${RUN_AGAIN}`);
    if (!existsSync(findingsPath)) {
      throw new OpenQodexError(`no agent findings at ${findingsPath}; write them there as the brief says, then run this again`);
    }
    return { dir, findingsPath, submission: readJsonFile(findingsPath, "agent findings") };
  }
  const findingsPath = resolve(path);
  const submission = readJsonFile(findingsPath, "agent findings");
  const changeId = (submission as { change_id?: unknown } | null)?.change_id;
  if (typeof changeId !== "string" || changeId === "") {
    throw new OpenQodexError("agent findings are invalid at change_id: expected the change id from the brief");
  }
  const dir = findReportDir(repoRoot, changeId);
  if (dir === null) throw new OpenQodexError(`no review brief for change ${changeId.slice(0, 12)}; ${RUN_AGAIN}`);
  return { dir, findingsPath, submission };
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
  const change = await getChange({ repoRoot, scope: runFile.scope, exclude: config.exclude });
  const report = finalizeReview({ change, scan, manifest, config, submission });

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
