// `openqodex review`: the whole review in one run, owned by the tool.
//
//   prepare   the change, and a frozen snapshot of it under
//             <openqodex home>/checkouts/<run>/: committed, uncommitted and
//             untracked work (or a target's head), links as plain files
//   scan      the scanners and the code graph, on the snapshot
//   redact    secrets the scanners found, in the snapshot copy only
//   review    a reviewer process the tool starts (reviewers/), given the
//             brief, reading the snapshot alone
//   check     the answer, by script, with at most two correction rounds in
//             the same session; coverage from the reviewer's trace
//   report    one standard report, the report files and the completion record
//   clean     the snapshot is deleted, whatever happened
//
// The developer's files are never written. A tool failure, an incomplete
// review and a missing reviewer all exit 2.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  MANIFEST_VERSION,
  OpenQodexError,
  STATE_DIR,
  buildInventory,
  buildReviewerBrief,
  checkSubmission,
  completionRecord,
  configHash,
  getChange,
  getTreeChange,
  getWholeRepo,
  openReportDir,
  readCoverage,
  redactSecrets,
  safeGit,
  selectLenses,
  writeLatest,
  writeManifest,
  writeReportFiles,
  writeScan,
} from "@openqodex/core";
import type { Change, ChangeScope, Config, ImpactSummary, Latest, Report, ReviewerRecord, RunManifest, RunTarget, ScanResult, SelectedLens, TraceEntry, WholeRepo } from "@openqodex/core";
import { renderImpactBlock } from "@openqodex/graph";
import { announceRepoFiles } from "./agents/repo-folder.js";
import { addTargetCheckout, checkoutOwner, lfsPaths, placeSettings, removeTargetCheckout } from "./checkout.js";
import type { Checkout } from "./checkout.js";
import { EXIT_OK, EXIT_TOOL_FAILED } from "./exit-codes.js";
import { scannerList } from "./flags.js";
import type { GlobalFlags } from "./flags.js";
import { buildHotSpots, buildImpact, emitReport, exitFor, loadRepo, nothingToReview, ownersInstructions, progress, reportFiles, scanChange, warn, wholeRepoLenses } from "./pipeline.js";
import type { PipelineResult } from "./pipeline.js";
import { claudeDriver } from "./reviewers/claude.js";
import { DEPTH_ENV, REVIEWER_NAMES, hostAgent } from "./reviewers/driver.js";
import type { ReviewerDriver, ReviewerSession, Turn } from "./reviewers/driver.js";
import { dropTempRef, resolveTarget } from "./target.js";

export const DEFAULT_TIMEOUT_SECONDS = 600;
const MAX_CORRECTIONS = 2;
const HEARTBEAT_MS = 15_000;
// An answer bigger than this is not read.
const MAX_ANSWER_BYTES = 2 * 1024 * 1024;
// Snapshot files bigger than this are neither redacted nor hashed by content.
const MAX_FILE_BYTES = 5 * 1024 * 1024;

const DRIVERS: ReviewerDriver[] = [claudeDriver];

export type ReviewOptions = {
  flags: GlobalFlags;
  scope: ChangeScope;
  target?: string;
  base?: string;
  all?: boolean;
  only?: string;
  skip?: string;
  noGraph: boolean;
  reviewer: string;
  timeoutMs: number;
  // The drivers to choose from; tests pass a model provider stand-in.
  drivers?: ReviewerDriver[];
};

type Chosen = { driver: ReviewerDriver; version: string; bin: string } | { unavailable: string[] };

// --reviewer, else the agent running this command when it has a driver,
// else the first driver whose agent is installed and logged in.
async function chooseReviewer(choice: string, drivers: ReviewerDriver[], repoRoot: string): Promise<Chosen> {
  if (choice !== "auto" && !(REVIEWER_NAMES as readonly string[]).includes(choice)) {
    throw new OpenQodexError(`--reviewer must be auto or one of ${REVIEWER_NAMES.join(", ")}, not ${choice}`);
  }
  const host = hostAgent();
  const order =
    choice !== "auto"
      ? drivers.filter((d) => d.name === choice)
      : [...drivers.filter((d) => d.name === host), ...drivers.filter((d) => d.name !== host)];
  const unavailable: string[] = [];
  for (const driver of order) {
    const d = await driver.detect(repoRoot);
    if (d.ok) return { driver, version: d.version, bin: d.bin };
    unavailable.push(`${driver.name}: ${d.missing}; ${d.fix}`);
  }
  return { unavailable: unavailable.length > 0 ? unavailable : [`${choice}: no driver of that name`] };
}

// Every regular file under `dir` but the work tree's .git link file, by
// path relative to `dir`. Links (there are none: they were written as
// plain files) and anything else are skipped.
function snapshotFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = rel === "" ? e.name : `${rel}/${e.name}`;
      if (path === ".git") continue;
      if (e.isDirectory()) walk(path);
      else if (e.isFile()) out.push(path);
    }
  };
  walk("");
  return out.sort();
}

// Replaces every copy of a secret the scanners found, in every file of the
// snapshot, so the reviewer never reads one. The snapshot is the tool's own
// copy; the developer's files are never touched.
export function redactSnapshot(dir: string, secrets: string[]): number {
  if (secrets.length === 0) return 0;
  let changed = 0;
  for (const path of snapshotFiles(dir)) {
    const full = join(dir, path);
    if (lstatSync(full).size > MAX_FILE_BYTES) continue;
    const text = readFileSync(full, "utf8");
    const clean = redactSecrets(text, secrets);
    if (clean !== text) {
      writeFileSync(full, clean);
      changed++;
    }
  }
  return changed;
}

// One hash over every snapshot file's path and content (size and time for a
// file over the limit): taken before the reviewer starts and after it ends.
function hashSnapshot(dir: string): string {
  const h = createHash("sha256");
  for (const path of snapshotFiles(dir)) {
    const st = lstatSync(join(dir, path));
    h.update(`${path}\0`);
    h.update(st.size > MAX_FILE_BYTES ? `${st.size}:${st.mtimeMs}` : readFileSync(join(dir, path)));
    h.update("\0");
  }
  return h.digest("hex");
}

// Line counts of snapshot files, for the cited lines of dropped candidates.
function lineCounter(dir: string): (path: string) => number | null {
  const cache = new Map<string, number | null>();
  return (path) => {
    if (cache.has(path)) return cache.get(path) ?? null;
    let n: number | null = null;
    const full = resolve(dir, path);
    const rel = relative(dir, full);
    if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && rel !== ".git") {
      try {
        const st = lstatSync(full);
        if (st.isFile() && st.size <= MAX_FILE_BYTES) {
          const buf = readFileSync(full);
          n = 0;
          for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) n++;
          if (buf.length > 0 && buf[buf.length - 1] !== 10) n++;
        }
      } catch {
        n = null;
      }
    }
    cache.set(path, n);
    return n;
  };
}

// The answer's JSON object: the whole text, a fenced block, or the outermost braces.
export function parseAnswer(text: string): { value: unknown } | { error: string } {
  if (Buffer.byteLength(text, "utf8") > MAX_ANSWER_BYTES) return { error: "the answer is over 2 MB" };
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text)?.[1];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  for (const candidate of [text.trim(), fenced, start !== -1 && end > start ? text.slice(start, end + 1) : undefined]) {
    if (candidate === undefined) continue;
    try {
      return { value: JSON.parse(candidate) as unknown };
    } catch {
      // try the next form
    }
  }
  return { error: "the answer is not one JSON object; answer with the JSON object only" };
}

const renumber = (errors: string[]) => errors.map((e, i) => `${i + 1}. ${e.replace(/^\d+\.\s+/, "")}`);

type Prepared = {
  p: PipelineResult;
  snapshot: Checkout;
  tree: string | null;
  target?: RunTarget;
  whole?: WholeRepo;
};

type Conversation = {
  rounds: number;
  trace: TraceEntry[];
  usage: Turn["usage"];
  report: Report | null;
  errors: string[];
  disposed: number;
  failure: string | null;
  submission: unknown;
  startedAt: number;
  endedAt: number;
};

// The brief, then at most two correction rounds in the same session. A read
// outside the snapshot ends the conversation at once.
async function converse(args: {
  session: ReviewerSession;
  brief: string;
  deadline: number;
  check: (submission: unknown, trace: TraceEntry[]) => { report: Report | null; errors: string[]; unread: string[]; disposed: number };
  say: (line: string) => void;
}): Promise<Conversation> {
  const startedAt = Date.now();
  const c: Conversation = { rounds: 0, trace: [], usage: { turns: 0, input_tokens: null, output_tokens: null, cost_usd: null }, report: null, errors: [], disposed: 0, failure: null, submission: null, startedAt, endedAt: startedAt };
  const heartbeat = setInterval(() => args.say(`Reviewer still working: ${Math.round((Date.now() - startedAt) / 1000)} s`), HEARTBEAT_MS);
  heartbeat.unref();
  try {
    let text = args.brief;
    for (;;) {
      c.rounds++;
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<Turn>((done) => {
        timer = setTimeout(() => done({ finalText: "", trace: [], usage: c.usage, sessionId: null, failure: "the reviewer timed out and was stopped" }), Math.max(0, args.deadline - Date.now()));
      });
      let turn: Turn;
      try {
        turn = await Promise.race([args.session.send(text), late]);
      } catch (error) {
        turn = { finalText: "", trace: [], usage: c.usage, sessionId: null, failure: `the reviewer failed: ${(error as Error).message}` };
      } finally {
        clearTimeout(timer);
      }
      c.trace.push(...turn.trace);
      c.usage = turn.usage;
      if (turn.failure !== null) {
        c.failure = turn.failure;
        break;
      }
      if (c.trace.some((t) => t.ok && !t.inside)) break;
      const parsed = parseAnswer(turn.finalText);
      const result = "error" in parsed ? { report: null, errors: [`1. ${parsed.error}`], unread: [], disposed: 0 } : args.check(parsed.value, c.trace);
      if ("value" in parsed) c.submission = parsed.value;
      c.report = result.report;
      c.errors = result.errors;
      c.disposed = result.disposed;
      const problems = renumber([...result.errors, ...result.unread]);
      if (problems.length === 0 || c.rounds > MAX_CORRECTIONS) break;
      args.say(`Correction round ${c.rounds} of ${MAX_CORRECTIONS}: ${problems.length} ${problems.length === 1 ? "problem" : "problems"} sent back to the reviewer`);
      text = ["Your answer failed these checks. Fix every one, then answer again with the whole JSON object and nothing else.", "", ...problems].join("\n");
    }
  } finally {
    clearInterval(heartbeat);
    c.endedAt = Date.now();
  }
  return c;
}

// A report that carries no finding: an incomplete review.
function incompleteReport(change: Change, scan: ScanResult, config: Config): Report {
  return {
    version: 1,
    kind: "review",
    change_id: change.id,
    base: { ref: change.baseRef, sha: change.baseSha },
    generated_at: new Date().toISOString(),
    verdict: "incomplete",
    block_on_severity: config.blockOnSeverity,
    summary: null,
    findings: [],
    below_threshold: 0,
    outside_change: [],
    low_confidence: [],
    not_reviewed: [],
    dropped: [],
    scanners: scan.scanners,
    impact: null,
    not_reviewed_paths: change.notReviewed,
    stats: change.stats,
  };
}

async function headOf(repoRoot: string): Promise<string> {
  const r = await safeGit(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const sha = r.stdout.toString("utf8").trim();
  if (r.code !== 0 || sha === "") throw new OpenQodexError("the repository has no commit yet; commit once, then review");
  return sha;
}

// The change and its snapshot. `keep` receives the snapshot as soon as it
// exists, so the caller removes it whatever fails later.
async function prepare(o: ReviewOptions, repoRoot: string, config: Config, keep: (c: Checkout) => void): Promise<Prepared | null> {
  const flags = o.flags;
  const only = scannerList("--only", o.only);
  const skip = scannerList("--skip", o.skip);
  if (o.target !== undefined) {
    const t = await resolveTarget({ repoRoot, spec: o.target, offline: flags.offline, base: o.base, defaultBase: config.defaultBase });
    try {
      for (const note of t.notes) warn(note);
      progress(flags)(`Reviewing ${o.target} at ${t.headSha.slice(0, 12)}: base ${t.baseRef} (from ${t.baseSource}), merge base ${t.mergeBase.slice(0, 12)}`);
      const change = await getTreeChange({ repoRoot, baseRef: t.baseRef, baseSha: t.mergeBase, headSha: t.headSha, exclude: config.exclude });
      if (change.files.length === 0) {
        nothingToReview(change);
        return null;
      }
      const snapshot = await addTargetCheckout(repoRoot, t.headSha, `${change.shortId}-`);
      keep(snapshot);
      placeSettings(repoRoot, snapshot.tree, false);
      const lfs = await lfsPaths(snapshot.tree, change.changedPaths);
      if (lfs > 0) warn(`${lfs} changed ${lfs === 1 ? "file is" : "files are"} stored in Git LFS and not fetched: the review sees the pointer files`);
      const target: RunTarget = { spec: o.target, base_ref: t.baseRef, base_source: t.baseSource, base_sha: t.baseSha, merge_base: t.mergeBase, head_sha: t.headSha, repo_root: repoRoot, checkout: snapshot.tree };
      const p = await scanChange({ repoRoot, workDir: snapshot.tree, config, change, flags, only, skip });
      return { p, snapshot, tree: null, target };
    } finally {
      if (t.tmpRef !== null) await dropTempRef(repoRoot, t.tmpRef);
    }
  }

  const head = await headOf(repoRoot);
  let snapshot: Checkout | null = null;
  let treeSha: string | null = null;
  const change = await getChange({
    repoRoot,
    scope: o.all ? { uncommitted: true } : o.scope,
    exclude: config.exclude,
    defaultBase: config.defaultBase,
    onTree: async (tree) => {
      treeSha = tree.sha;
      snapshot = await addTargetCheckout(repoRoot, head, "work-", tree);
      keep(snapshot);
    },
  });
  if (snapshot === null) throw new OpenQodexError("the snapshot of the change was not made");
  const snap: Checkout = snapshot;
  if (o.all) {
    // The whole repository as the snapshot holds it, so nothing written in
    // the developer's folder from here on is part of the review.
    const whole = await getWholeRepo({ repoRoot: snap.tree, exclude: config.exclude });
    const p = await scanChange<WholeRepo>({ repoRoot, workDir: snap.tree, config, change: whole, wholeRepo: true, flags, only, skip });
    return p.scan === null ? null : { p, snapshot: snap, tree: treeSha, whole: p.change };
  }
  if (change.files.length === 0) {
    nothingToReview(change);
    return null;
  }
  progress(flags)(`Reviewing the change against ${change.baseRef}: ${change.stats.files} ${change.stats.files === 1 ? "file" : "files"}, +${change.stats.additions} -${change.stats.deletions}`);
  const p = await scanChange({ repoRoot, workDir: snap.tree, config, change, flags, only, skip });
  return { p, snapshot: snap, tree: treeSha };
}

export async function runReview(o: ReviewOptions): Promise<number> {
  if (process.env[DEPTH_ENV]) throw new OpenQodexError("openqodex review cannot run inside an openqodex reviewer");
  const say = progress(o.flags);
  const { repoRoot, config } = await loadRepo(o.flags);
  const owner = checkoutOwner(repoRoot);
  if (owner !== null) throw new OpenQodexError(`this folder is the temporary checkout of a review; run review from ${owner}`);
  announceRepoFiles(repoRoot);
  const chosen = await chooseReviewer(o.reviewer, o.drivers ?? DRIVERS, repoRoot);
  const deadline = Date.now() + o.timeoutMs;

  let snapshot: Checkout | null = null;
  let session: ReviewerSession | null = null;
  // Ctrl-C or a kill: the reviewer's process group and the snapshot go too.
  const onSignal = (signal: NodeJS.Signals): void => {
    void session?.close();
    if (snapshot !== null) rmSync(snapshot.folder, { recursive: true, force: true });
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const prep = await prepare(o, repoRoot, config, (c) => (snapshot = c));
    if (prep === null) {
      if (o.all) warn("Nothing to review: the repository has no files");
      return EXIT_OK;
    }
    const { p } = prep;
    const scan = p.scan as ScanResult;
    const change = p.change;
    const dir = openReportDir(repoRoot, change.shortId);

    if ("unavailable" in chosen) {
      const path = join(dir, "unchecked-candidates.json");
      writeReportFiles(repoRoot, dir, {
        "unchecked-candidates.json": `${JSON.stringify({ label: "unchecked scanner candidates, not a review: no reviewer checked them", change_id: change.id, candidates: scan.candidates }, null, 2)}\n`,
      });
      warn("Full review unavailable: openqodex could not start a reviewer.");
      for (const line of chosen.unavailable) warn(`- ${line}`);
      warn(`Unchecked scanner candidates, not a review: ${path}`);
      return EXIT_TOOL_FAILED;
    }

    const removed = redactSnapshot(prep.snapshot.tree, p.secrets);
    if (removed > 0) say(`Redacted secrets in ${removed} ${removed === 1 ? "file" : "files"} of the snapshot`);
    const instructions = ownersInstructions(repoRoot, p.secrets);
    let lenses: SelectedLens[];
    let impact: ImpactSummary;
    let brief: { text: string; diffFiles: Set<string> };
    if (prep.whole) {
      const hot = await buildHotSpots(p, o.flags, o.noGraph);
      impact = hot.impact;
      lenses = wholeRepoLenses(prep.whole);
      brief = buildReviewerBrief({ change, scan, lenses, config, secrets: p.secrets, instructions: instructions.text, whole: { hot: hot.hot, graphNote: hot.note, inventory: buildInventory(prep.whole, scan) } });
    } else {
      impact = await buildImpact(p, o.flags, o.noGraph);
      lenses = selectLenses(change);
      brief = buildReviewerBrief({ change, scan, lenses, config, secrets: p.secrets, impactBlock: renderImpactBlock(impact), instructions: instructions.text, target: prep.target });
    }
    const manifest: RunManifest = {
      version: MANIFEST_VERSION,
      change_id: change.id,
      config_hash: configHash(config),
      created_at: new Date().toISOString(),
      lenses: lenses.map((l) => ({ name: l.name, confidenceFloor: l.confidenceFloor })),
      instructions_hash: instructions.hash,
      runtime_version: __OPENQODEX_VERSION__,
      ...(prep.target ? { target: prep.target } : {}),
    };
    writeManifest(repoRoot, dir, manifest);
    writeScan(repoRoot, dir, scan);
    writeReportFiles(repoRoot, dir, { "brief.md": brief.text, "impact.json": `${JSON.stringify(impact, null, 2)}\n` });

    const before = hashSnapshot(prep.snapshot.tree);
    const lineCount = lineCounter(prep.snapshot.tree);
    const live = scan.candidates.length;
    session = chosen.driver.start({ snapshotDir: prep.snapshot.tree, deadline, bin: chosen.bin });
    const pid = session.pid;
    say(`Reviewer: ${chosen.driver.name} ${chosen.version} started${pid !== null ? ` (process ${pid})` : ""}; this takes one to three minutes`);
    const startedIso = new Date().toISOString();
    const talk = await converse({
      session,
      brief: brief.text,
      deadline,
      say,
      check: (submission, trace) => {
        const r = checkSubmission({ change, scan, manifest, config, submission, lineCount, wholeRepo: prep.whole ? { lines: prep.whole.lines } : undefined });
        // A changed range the reviewer was not given is sent back once it can
        // be read; a deletion the brief could not carry cannot, and stays missing.
        const unread = prep.whole
          ? []
          : readCoverage({ change, briefFiles: brief.diffFiles, trace })
              .unread.filter((h) => !h.deletion)
              .map((h) => `you have not read ${h.path} lines ${h.start} to ${h.end}, a changed range; read them with your read tool and check your answer`);
        return r.ok ? { report: r.report, errors: [], unread, disposed: r.disposed } : { report: null, errors: r.errors, unread, disposed: r.disposed };
      },
    }).finally(async () => {
      await session?.close();
    });
    if (talk.failure !== null) warn(`openqodex: ${talk.failure}`);
    const after = hashSnapshot(prep.snapshot.tree);

    const reviewer: ReviewerRecord = {
      driver: chosen.driver.name,
      version: chosen.version,
      pid,
      started_at: startedIso,
      ended_at: new Date(talk.endedAt).toISOString(),
      duration_ms: talk.endedAt - talk.startedAt,
      rounds: talk.rounds,
      usage: talk.usage,
    };
    const coverage = readCoverage({ change, briefFiles: brief.diffFiles, trace: talk.trace });
    const completion = completionRecord({
      change,
      reviewer,
      snapshot: { tree: prep.tree, before, after },
      candidates: { total: live, disposed: talk.report ? live : talk.disposed },
      coverage,
      trace: talk.trace,
      submissionErrors: talk.report ? [] : talk.errors,
      wholeRepo: prep.whole !== undefined,
      failure: talk.failure,
    });
    const report: Report = {
      ...(completion.status === "complete" && talk.report ? talk.report : incompleteReport(change, scan, config)),
      impact: prep.whole ? null : impact,
      completion,
    };
    if (completion.status !== "complete") report.verdict = "incomplete";

    writeReportFiles(repoRoot, dir, {
      ...reportFiles(report),
      "submission.json": `${JSON.stringify(talk.submission, null, 2)}\n`,
      "trace.json": `${JSON.stringify(talk.trace, null, 2)}\n`,
    });
    const receipt: Latest = {
      dir: relative(repoRoot, dir),
      change_id: change.id,
      kind: "review",
      finalized: completion.status === "complete",
      verdict: completion.status === "complete" ? report.verdict : null,
      completion: completion.status,
    };
    // The push gate's receipt is the developer's own change only.
    if (prep.whole) writeReportFiles(repoRoot, join(repoRoot, STATE_DIR), { "latest-all.json": `${JSON.stringify(receipt, null, 2)}\n` });
    else if (!prep.target) writeLatest(repoRoot, receipt);
    emitReport(report, o.flags, repoRoot);
    say(`Report: ${relative(repoRoot, join(dir, "report.md"))}`);
    return exitFor(report);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (snapshot !== null) await removeTargetCheckout(repoRoot, (snapshot as Checkout).tree);
  }
}
