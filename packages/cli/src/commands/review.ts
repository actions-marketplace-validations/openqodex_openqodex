// `openqodex review`:
//   --agent            scan, then write the brief for the host agent and print it
//   --finalize [path]  check the agent's findings without a model and write the report
//   neither            the same as `scan`, plus how to get the AI review
//   --all              the whole repository instead of the change: the scanners
//                      on every file, then the brief, with or without --agent.
//                      There is never a scan-only report of the whole repo.
//   <target>           a branch or a pull request instead of the current work,
//                      read in a temporary checkout (see runTarget).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  MANIFEST_VERSION,
  OpenQodexError,
  DIFF_CAP_BYTES,
  INVENTORY_FILE,
  buildBrief,
  buildInventory,
  buildWholeRepoBrief,
  configHash,
  finalizeReview,
  findRepoRoot,
  getChange,
  getTreeChange,
  getWholeRepo,
  loadLensCatalog,
  openReportDir,
  readLatest,
  readManifest,
  readRepoFile,
  readScan,
  redactSecrets,
  repoStat,
  STATE_DIR,
  selectLenses,
  selectLensesForDiff,
  writeLatest,
  writeManifest,
  writeReportFiles,
  writeScan,
} from "@openqodex/core";
import type { ChangeScope, Config, ImpactSummary, Latest, RunManifest, RunTarget, SelectedLens, WholeRepo } from "@openqodex/core";
import { renderImpactBlock } from "@openqodex/graph";
import { announceRepoFiles, instructionsTemplate } from "../agents/repo-folder.js";
import { addTargetCheckout, checkoutOwner, checkoutsDir, inCheckouts, lfsPaths, placeSettings, removeTargetCheckout, sweepCheckouts } from "../checkout.js";
import { EXIT_OK, EXIT_TOOL_FAILED } from "../exit-codes.js";
import { launcherPath, launcherRunner, launcherStarted, openqodexHomeDir, runtimeBin } from "../launcher.js";
import { HANDED_OFF } from "../update/trigger.js";
import { readInstructions } from "../instructions.js";
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
  progress,
  runPipeline,
  scanChange,
  warn,
} from "../pipeline.js";
import type { PipelineResult } from "../pipeline.js";
import { resolveTarget } from "../target.js";
import { SCOPE_BOOLS, SCOPE_VALUES, reportScan, runScan, scopeFrom } from "./scan.js";

const FINDINGS_FILE = "agent-findings.json";
const IMPACT_FILE = "impact.json";
const RUN_FILE = "run.json";
const RUN_AGAIN = "run openqodex review --agent first";

// run.json beside the manifest: the scope the brief was made with, so
// finalize recomputes the same change ("all" for the whole repository,
// "target" for a branch or a pull request, whose commits are in the manifest).
type RunFile = { version: 1; scope: ChangeScope | "all" | "target" };

export async function run(args: string[]): Promise<number> {
  const { global, bools, values, positionals } = parseFlags(args, {
    bools: [...SCOPE_BOOLS, "--agent", "--finalize", ALL, NO_GRAPH, HANDED_OFF],
    values: [...SCOPE_VALUES, "--only", "--skip", "--run"],
    positionals: 1,
  });
  const agent = bools.has("--agent");
  const finalize = bools.has("--finalize");
  const noGraph = bools.has(NO_GRAPH);
  if (agent && finalize) throw new OpenQodexError("--agent and --finalize cannot be used together");
  if (values.has("--run") && !finalize) throw new OpenQodexError("--run names the run to finalize and needs --finalize");
  const target = finalize ? undefined : positionals[0];
  if (target !== undefined && bools.has(ALL)) {
    throw new OpenQodexError("--all reviews the whole repository and takes no branch or pull request");
  }
  if (target !== undefined && bools.has("--uncommitted")) {
    throw new OpenQodexError("--uncommitted is about your own work and cannot be used with a branch or pull request");
  }
  if (bools.has(ALL) && (values.has("--base") || bools.has("--uncommitted"))) {
    throw new OpenQodexError("--all reviews the whole repository and cannot be used with --base or --uncommitted");
  }

  // Finalize reads the scope from the run; --all only picks the newest
  // whole-repo run when no findings path is given.
  if (finalize) return runFinalize(global, positionals[0], bools.has(ALL), args, bools.has(HANDED_OFF), values.get("--run"));
  // Checkouts that a review of a branch or a pull request left behind.
  const root = await findRepoRoot(global.cwd).catch(() => null);
  if (root !== null) await sweepCheckouts(root);
  if (target !== undefined) {
    return runTarget(global, target, { agent, base: values.get("--base"), only: values.get("--only"), skip: values.get("--skip"), noGraph });
  }
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

// The command that finalizes this run. Started through the launcher, it is
// the plain line the Claude Code permission rules cover, run from the
// repository root: `<launcher> review --finalize`, with --all and --offline
// as the brief was made, and finalize finds the run through latest.json or
// latest-all.json. When an update moved the launcher on in between, finalize
// hands the run to the version that wrote the brief by its findings file.
// An explicit --config, or a run not started through the launcher, gets the
// full line that works from any folder: the repo, the config and the
// findings file named, with the pinned npx version.
// A review of a branch or a pull request writes no receipt, so its line names
// the run (`--run <id>`) in place of the findings file.
function finalizeCommand(repoRoot: string, flags: GlobalFlags, findingsPath: string, all: boolean, runId?: string): string {
  const run = runId === undefined ? [] : ["--run", runId];
  if (launcherStarted() && flags.config === undefined) {
    return [launcherRunner(launcherPath(openqodexHomeDir())), "review", "--finalize", ...(all ? ["--all"] : []), ...run, ...(flags.offline ? ["--offline"] : [])].join(" ");
  }
  const runner = launcherStarted() ? launcherRunner(launcherPath(openqodexHomeDir())) : `npx -y openqodex@${__OPENQODEX_VERSION__}`;
  const args = ["review", "--finalize", "--cwd", repoRoot];
  if (flags.config !== undefined) args.push("--config", isAbsolute(flags.config) ? flags.config : resolve(repoRoot, flags.config));
  args.push(...(runId === undefined ? [findingsPath] : run));
  return [runner, ...args.map(shellQuote)].join(" ");
}

// sha256 of the instructions file, null when there is none. Finalize compares
// it with the brief's, so a review always follows the instructions as they are.
function instructionsHash(text: string): string | null {
  return text === "" ? null : createHash("sha256").update(text).digest("hex");
}

// The owners' instructions as the brief takes them, and their hash. The
// untouched template says nothing about this repo: no block for it.
function ownersInstructions(repoRoot: string, secrets: string[]): { text: string; hash: string | null } {
  const raw = readInstructions(repoRoot);
  return { text: raw === "" || raw === instructionsTemplate() ? "" : redactSecrets(raw, secrets), hash: instructionsHash(raw) };
}

async function runAgent(flags: GlobalFlags, scope: ChangeScope, only: string | undefined, skip: string | undefined, noGraph: boolean): Promise<number> {
  const p = await runPipeline({
    scope,
    flags,
    only: scannerList("--only", only),
    skip: scannerList("--skip", skip),
  });
  announceRepoFiles(p.repoRoot);
  if (p.scan === null) return nothingToReview(p.change);
  await writeBrief(p, flags, noGraph, scope);
  return EXIT_OK;
}

// The run folder, the manifest and the brief of a change review, printed.
// A target review records the target and writes no receipt: latest.json is
// the push gate's view of the developer's own change.
async function writeBrief(p: PipelineResult, flags: GlobalFlags, noGraph: boolean, scope: ChangeScope | null, target?: RunTarget): Promise<void> {
  if (p.scan === null) return;
  // Read after the template may have been created, so finalize hashes the
  // same file. Over the size limit it is refused, never cut.
  const instructions = ownersInstructions(p.repoRoot, p.secrets);

  const lenses = selectLenses(p.change);
  const dir = openReportDir(p.repoRoot, p.change.shortId);
  const runId = target ? basename(dir) : undefined;
  writeManifest(p.repoRoot, dir, {
    version: MANIFEST_VERSION,
    change_id: p.change.id,
    config_hash: configHash(p.config),
    created_at: new Date().toISOString(),
    lenses: lenses.map((l) => ({ name: l.name, confidenceFloor: l.confidenceFloor })),
    instructions_hash: instructions.hash,
    runtime_version: __OPENQODEX_VERSION__,
    ...(target ? { target, run_id: runId } : {}),
  });
  writeScan(p.repoRoot, dir, p.scan);
  const impact = await buildImpact(p, flags, noGraph);
  const brief = buildBrief({
    change: p.change,
    scan: p.scan,
    lenses,
    config: p.config,
    secrets: p.secrets,
    findingsPath: join(dir, FINDINGS_FILE),
    finalizeCommand: finalizeCommand(p.repoRoot, flags, join(dir, FINDINGS_FILE), false, runId),
    impactBlock: renderImpactBlock(impact),
    instructions: instructions.text,
    target,
  });
  const runFile: RunFile = { version: 1, scope: scope ?? "target" };
  writeReportFiles(p.repoRoot, dir, {
    [RUN_FILE]: `${JSON.stringify(runFile, null, 2)}\n`,
    "candidates.json": `${JSON.stringify(p.scan.candidates, null, 2)}\n`,
    [IMPACT_FILE]: `${JSON.stringify(impact, null, 2)}\n`,
    "brief.md": brief,
  });
  if (!target) {
    writeLatest(p.repoRoot, {
      dir: relative(p.repoRoot, dir),
      change_id: p.change.id,
      kind: "review",
      finalized: false,
      verdict: null,
    });
  }
  process.stdout.write(brief);
}

// The worktree is clean apart from our own state folder.
function cleanWorkTree(repoRoot: string): boolean {
  const r = spawnSync("git", ["status", "--porcelain", "--", ".", ":(exclude).openqodex"], { cwd: repoRoot, encoding: "utf8" });
  return r.status === 0 && r.stdout === "";
}

// `review [--agent] <target>`: a branch or a pull request. The change is the
// target's head against its merge base with the base, from the two commits'
// trees. Its files are read in place when the head is HEAD and the work tree
// is clean, else in a temporary checkout made without running anything from
// the repo's config, with the developer's own settings, never the target's.
// The checkout outlives an agent review until finalize; a scan removes it.
async function runTarget(
  flags: GlobalFlags,
  spec: string,
  opts: { agent: boolean; base: string | undefined; only: string | undefined; skip: string | undefined; noGraph: boolean },
): Promise<number> {
  const { repoRoot, config } = await loadRepo(flags);
  announceRepoFiles(repoRoot);
  const t = await resolveTarget({ repoRoot, spec, offline: flags.offline, base: opts.base, defaultBase: config.defaultBase });
  for (const note of t.notes) warn(note);
  progress(flags)(
    `Reviewing ${spec} at ${t.headSha.slice(0, 12)}: base ${t.baseRef} (from ${t.baseSource}), merge base ${t.mergeBase.slice(0, 12)}`,
  );
  const change = await getTreeChange({ repoRoot, baseRef: t.baseRef, baseSha: t.mergeBase, headSha: t.headSha, exclude: config.exclude });
  if (change.files.length === 0) return nothingToReview(change);

  const head = spawnSync("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim();
  let tree: string | null = null;
  if (t.headSha !== head || !cleanWorkTree(repoRoot)) {
    if (t.headSha === head) warn(`Uncommitted work is not part of a target review: reviewing the committed ${spec} at ${t.headSha.slice(0, 12)}`);
    const checkout = await addTargetCheckout(repoRoot, t.headSha, `${change.shortId}-`);
    if (checkout === null) throw new OpenQodexError(`could not check out ${t.headSha.slice(0, 12)} to review ${spec}`);
    tree = checkout.tree;
  }
  const target: RunTarget = {
    spec,
    base_ref: t.baseRef,
    base_source: t.baseSource,
    base_sha: t.baseSha,
    merge_base: t.mergeBase,
    head_sha: t.headSha,
    repo_root: repoRoot,
    checkout: tree,
  };
  let keep = false;
  try {
    if (tree !== null) {
      placeSettings(repoRoot, tree, false);
      const lfs = lfsPaths(tree, change.changedPaths);
      if (lfs > 0) warn(`${lfs} changed ${lfs === 1 ? "file is" : "files are"} stored in Git LFS and not fetched: the review sees the pointer files`);
    }
    const p = await scanChange({
      repoRoot,
      workDir: tree ?? repoRoot,
      config,
      change,
      flags,
      only: scannerList("--only", opts.only),
      skip: scannerList("--skip", opts.skip),
    });
    if (!opts.agent) {
      const outcome = reportScan(p, flags);
      if (outcome.report !== null) warn(`For the AI review, ask your coding agent: review ${spec} with openqodex`);
      return outcome.exitCode;
    }
    await writeBrief(p, flags, opts.noGraph, null, target);
    keep = true;
    return EXIT_OK;
  } finally {
    if (tree !== null && !keep) await removeTargetCheckout(repoRoot, tree);
  }
}

// The lens triggers over the whole repo: every line counts as changed. Each
// text file contributes its first bytes, an equal share of the 5 MB the
// brief's diff may carry, so a late file is sampled as fully as an early
// one; the matches are then ranked and capped as for a change.
const LENS_SAMPLE_MIN_BYTES = 1024;

function wholeRepoLenses(change: WholeRepo): SelectedLens[] {
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
  return selectLensesForDiff({ diff, files: change.changedPaths, catalog: loadLensCatalog() });
}

// The receipt of the newest whole-repo run, beside latest.json, which only
// change reviews and scans write: the push gate reads latest.json, and a
// whole-repo run must never replace the receipt of the change being pushed.
const LATEST_ALL_FILE = "latest-all.json";

function writeLatestAll(repoRoot: string, latest: Latest): void {
  writeReportFiles(repoRoot, join(repoRoot, STATE_DIR), { [LATEST_ALL_FILE]: `${JSON.stringify(latest, null, 2)}\n` });
}

async function runAll(flags: GlobalFlags, agent: boolean, only: string | undefined, skip: string | undefined, noGraph: boolean): Promise<number> {
  const { repoRoot, config } = await loadRepo(flags);
  announceRepoFiles(repoRoot);
  const whole = await getWholeRepo({ repoRoot, exclude: config.exclude });
  const p = await scanChange<WholeRepo>({
    repoRoot,
    config,
    change: whole,
    wholeRepo: true,
    flags,
    only: scannerList("--only", only),
    skip: scannerList("--skip", skip),
  });
  if (p.scan === null) {
    warn("Nothing to review: the repository has no files");
    return EXIT_OK;
  }

  const instructions = ownersInstructions(repoRoot, p.secrets);
  const lenses = wholeRepoLenses(p.change);
  const dir = openReportDir(repoRoot, p.change.shortId);
  writeManifest(repoRoot, dir, {
    version: MANIFEST_VERSION,
    change_id: p.change.id,
    config_hash: configHash(config),
    created_at: new Date().toISOString(),
    lenses: lenses.map((l) => ({ name: l.name, confidenceFloor: l.confidenceFloor })),
    instructions_hash: instructions.hash,
    runtime_version: __OPENQODEX_VERSION__,
  });
  writeScan(repoRoot, dir, p.scan);
  const { impact, hot, note } = await buildHotSpots(p, flags, noGraph);
  const inventory = buildInventory(p.change, p.scan);
  const brief = buildWholeRepoBrief({
    change: p.change,
    scan: p.scan,
    lenses,
    config,
    secrets: p.secrets,
    findingsPath: join(dir, FINDINGS_FILE),
    finalizeCommand: finalizeCommand(repoRoot, flags, join(dir, FINDINGS_FILE), true),
    inventory,
    inventoryPath: join(dir, INVENTORY_FILE),
    hot,
    graphNote: note,
    instructions: instructions.text,
  });
  const runFile: RunFile = { version: 1, scope: "all" };
  writeReportFiles(repoRoot, dir, {
    [RUN_FILE]: `${JSON.stringify(runFile, null, 2)}\n`,
    "candidates.json": `${JSON.stringify(p.scan.candidates, null, 2)}\n`,
    [INVENTORY_FILE]: `${JSON.stringify(redactStored(inventory, p.secrets), null, 2)}\n`,
    [IMPACT_FILE]: `${JSON.stringify(impact, null, 2)}\n`,
    "brief.md": brief,
  });
  writeLatestAll(repoRoot, {
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
function readImpact(repoRoot: string, dir: string): ImpactSummary | null {
  const value = readJsonFile(repoRoot, join(dir, IMPACT_FILE), "graph impact") as ImpactSummary | null;
  return value !== null && typeof value === "object" && value.version === 1 ? value : null;
}

// A JSON file in the run folder, or null when it is missing. Read through
// the repo state reader: a link or anything but a regular file stops finalize.
function readJsonFile(repoRoot: string, path: string, what: string): unknown {
  const text = readRepoFile(repoRoot, path);
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new OpenQodexError(`${what} at ${path} is not valid JSON: ${(error as Error).message}`);
  }
}

// <yyyymmdd-hhmmss>-<shortid>, with "-2", "-3", ... for a second run in the same second.
const RUN_DIR_NAME = /^\d{8}-\d{6}-[0-9a-f]{12}(?:-\d+)?$/;

// The run folder must be a real folder directly under this repo's
// .openqodex/reviews/, reached through no symbolic link, and the findings
// file must not be a link either: finalize reads and writes only there. The
// shape is checked from the path text first, so nothing is looked up through
// a folder the path names before it is known to be the run folder. Returns
// the folder and the findings file spelled from the repo root.
function checkRunDir(repoRoot: string, dir: string, findingsPath: string): { dir: string; findingsPath: string } {
  const reviews = join(repoRoot, STATE_DIR, "reviews");
  const outside = new OpenQodexError(
    `${findingsPath} is not in a report folder under ${reviews}; write the findings where the brief says`,
  );
  const parent = dirname(dir);
  const state = dirname(parent);
  const root = dirname(state);
  // The repo root may be spelled another way (/var and /private/var on macOS); only it is resolved.
  const sameRoot = (): boolean => {
    try {
      return realpathSync(root) === realpathSync(repoRoot);
    } catch {
      return false;
    }
  };
  if (!RUN_DIR_NAME.test(basename(dir)) || basename(parent) !== "reviews" || basename(state) !== STATE_DIR || (root !== repoRoot && !sameRoot())) {
    throw outside;
  }
  const canonical = join(reviews, basename(dir));
  const findings = join(canonical, basename(findingsPath));
  // A link at .openqodex, reviews, the run folder or the findings file throws here.
  if (!repoStat(repoRoot, canonical)?.isDirectory()) throw outside;
  repoStat(repoRoot, findings);
  return { dir: canonical, findingsPath: findings };
}

// The report folder this submission belongs to: the newest run when no path
// is given (the newest whole-repo run with --all), else the folder that
// holds the findings file.
function findRun(repoRoot: string, path: string | undefined, all: boolean): { dir: string; findingsPath: string; submission: unknown } {
  let dir: string;
  let findingsPath: string;
  if (path === undefined) {
    const latest = readLatest(repoRoot, all);
    if (latest === null || typeof latest.dir !== "string") {
      throw new OpenQodexError(`no review brief found in this repository; ${RUN_AGAIN}`);
    }
    ({ dir, findingsPath } = checkRunDir(repoRoot, resolve(repoRoot, latest.dir), join(resolve(repoRoot, latest.dir), FINDINGS_FILE)));
    if (readManifest(repoRoot, dir) === null) throw new OpenQodexError(`the newest run has no review brief; ${RUN_AGAIN}`);
    if (repoStat(repoRoot, findingsPath) === null) {
      throw new OpenQodexError(`no agent findings at ${findingsPath}; write them there as the brief says, then run this again`);
    }
  } else {
    ({ dir, findingsPath } = checkRunDir(repoRoot, dirname(resolve(path)), resolve(path)));
  }
  const submission = readJsonFile(repoRoot, findingsPath, "agent findings");
  if (submission === null) throw new OpenQodexError(`agent findings not found at ${findingsPath}`);
  return { dir, findingsPath, submission };
}

const PLAIN_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// A brief written by another version is finalized by that version: the brief's
// rules and the finalize checks belong together. It runs only
// <home>/runtime/<x.y.z>/dist/bin.js, built from the developer's home folder
// and a plain version, never a path read from the manifest; a repository
// cannot write into the home folder.
// The child gets the findings file this process selected, by path, so it
// finalizes the same run even when latest.json moves on in between, and the
// hidden --handed-off argument, so it never hands off again. An environment
// variable would be inherited from whatever started this process.
function finalizeOnVersion(version: unknown, args: string[], path: string | undefined, findingsPath: string, handedOff: boolean): number {
  if (handedOff) {
    throw new OpenQodexError(`this finalize was handed here by another openqodex version, and the brief names ${String(version)}; run openqodex review --agent again`);
  }
  if (typeof version !== "string" || !PLAIN_VERSION.test(version)) {
    throw new OpenQodexError("the brief names no valid openqodex version; run openqodex review --agent again");
  }
  const bin = runtimeBin(openqodexHomeDir(), version);
  if (!existsSync(bin)) {
    throw new OpenQodexError(`this brief was written by openqodex ${version}, which is not installed here; run openqodex review --agent again`);
  }
  // The flags as given, without the path, then -- and the selected path, so a
  // path after -- or one that starts with a dash reaches the child as a path.
  const dash = args.indexOf("--");
  const flags = dash !== -1 ? args.slice(0, dash) : path === undefined ? args : args.filter((a, i) => i !== args.indexOf(path));
  const child = spawnSync(process.execPath, [bin, "review", HANDED_OFF, ...flags, "--", findingsPath], { stdio: "inherit" });
  return child.status ?? EXIT_TOOL_FAILED;
}

// The run a `--run <id>` names, in this repository's report folders.
function findRunById(repoRoot: string, id: string): { dir: string; findingsPath: string; submission: unknown } {
  if (!RUN_DIR_NAME.test(id)) throw new OpenQodexError(`--run ${id} is not a run name; copy it from the brief's finalize line`);
  const { dir, findingsPath } = checkRunDir(repoRoot, join(repoRoot, STATE_DIR, "reviews", id), join(repoRoot, STATE_DIR, "reviews", id, FINDINGS_FILE));
  if (readManifest(repoRoot, dir) === null) throw new OpenQodexError(`the run ${id} has no review brief; ${RUN_AGAIN}`);
  const submission = readJsonFile(repoRoot, findingsPath, "agent findings");
  if (submission === null) throw new OpenQodexError(`no agent findings at ${findingsPath}; write them there as the brief says, then run this again`);
  return { dir, findingsPath, submission };
}

// The checkout a target review was briefed on, still at the head it recorded.
function checkTargetCheckout(target: RunTarget): void {
  if (target.checkout === null) return;
  // Only a checkout this tool made is read, or later removed.
  if (!inCheckouts(target.checkout)) {
    throw new OpenQodexError(`the run names a checkout outside ${checkoutsDir()}, which openqodex never makes; run the review again`);
  }
  if (!existsSync(target.checkout)) throw new OpenQodexError(`the temporary checkout of ${target.spec} is gone; run the review again`);
  const head = spawnSync("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: target.checkout, encoding: "utf8" }).stdout.trim();
  if (head !== target.head_sha) {
    throw new OpenQodexError(
      `the temporary checkout of ${target.spec} moved from ${target.head_sha.slice(0, 12)} to ${head.slice(0, 12) || "nothing"} since the brief; run the review again`,
    );
  }
}

async function runFinalize(flags: GlobalFlags, path: string | undefined, all: boolean, args: string[], handedOff: boolean, runId: string | undefined): Promise<number> {
  const { repoRoot, config } = await loadRepo(flags);
  const owner = checkoutOwner(repoRoot);
  if (owner !== null) throw new OpenQodexError(`this folder is the temporary checkout of a review; run finalize from ${owner}`);
  if (runId !== undefined && (path !== undefined || all)) throw new OpenQodexError("--run names the run; give no findings path and no --all with it");
  const { dir, findingsPath, submission } = runId !== undefined ? findRunById(repoRoot, runId) : findRun(repoRoot, path, all);
  const manifest = readManifest(repoRoot, dir);
  const target = manifest?.target;
  // A review of a branch or a pull request is bound to its run by name.
  if (target !== undefined && runId === undefined) {
    throw new OpenQodexError(`this run reviewed ${target.spec}; finalize it with review --finalize --run ${basename(dir)}`);
  }
  if (manifest !== null && manifest.runtime_version !== undefined && manifest.runtime_version !== __OPENQODEX_VERSION__) {
    if (target !== undefined) {
      throw new OpenQodexError(`this brief was written by openqodex ${manifest.runtime_version}; run the review of ${target.spec} again`);
    }
    return finalizeOnVersion(manifest.runtime_version, args, path, findingsPath, handedOff);
  }
  const scan = readScan(repoRoot, dir);
  const runFile = readJsonFile(repoRoot, join(dir, RUN_FILE), "run file") as RunFile | null;
  if (manifest === null || scan === null || runFile === null) {
    throw new OpenQodexError(`the run in ${relative(repoRoot, dir)} has no review brief; ${RUN_AGAIN}`);
  }
  // A failure here cannot be fixed in the findings file: a target review's
  // checkout goes with it. A wrong field found later keeps it for the retry.
  const discard = async (): Promise<void> => {
    if (target?.checkout) await removeTargetCheckout(repoRoot, target.checkout);
  };
  try {
    checkBinding(repoRoot, config, manifest);
    if (target !== undefined) checkTargetCheckout(target);
  } catch (error) {
    await discard();
    throw error;
  }
  const whole = runFile.scope === "all" ? await getWholeRepo({ repoRoot, exclude: config.exclude }) : null;
  const change = target
    ? await getTreeChange({ repoRoot, baseRef: target.base_ref, baseSha: target.merge_base, headSha: target.head_sha, exclude: config.exclude })
    : (whole ?? (await getChange({ repoRoot, scope: runFile.scope as ChangeScope, exclude: config.exclude, defaultBase: config.defaultBase })));
  // A whole-repo run has no change to trace, so its report carries no blast radius.
  const report = {
    ...finalizeReview({ change, scan, manifest, config, submission, wholeRepo: whole ?? undefined }),
    impact: whole ? null : readImpact(repoRoot, dir),
  };

  writeReportFiles(repoRoot, dir, reportFiles(report));
  const receipt: Latest = {
    dir: relative(repoRoot, dir),
    change_id: change.id,
    kind: "review",
    finalized: true,
    verdict: report.verdict,
  };
  // A target review is not the developer's change: no receipt.
  if (whole) writeLatestAll(repoRoot, receipt);
  else if (!target) writeLatest(repoRoot, receipt);
  await discard();
  emitReport(report, flags, repoRoot);
  return exitFor(report);
}

// The config and the instructions are the ones the brief was made with.
function checkBinding(repoRoot: string, config: Config, manifest: RunManifest): void {
  if (manifest.config_hash !== configHash(config)) {
    throw new OpenQodexError("the config changed since the brief (.openqodex.yaml or --config); run openqodex review --agent again");
  }
  // A run from before the field existed has no hash to compare.
  if (manifest.instructions_hash !== undefined) {
    let current: string | null;
    try {
      current = instructionsHash(readInstructions(repoRoot));
    } catch {
      current = "unreadable";
    }
    if (current !== manifest.instructions_hash) {
      throw new OpenQodexError("the instructions changed since the brief (.openqodex/custom-instructions.md); run review again (openqodex review --agent)");
    }
  }
}
