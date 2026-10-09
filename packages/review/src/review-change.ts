// The one-run review, without the command around it:
//
//   prepare   the change, and a frozen snapshot of it made by the host's
//             snapshot maker: committed, uncommitted and untracked work
//             (or a target's head), links as plain files
//   scan      the scanners and the code graph, on the snapshot
//   redact    secrets the scanners found, in the snapshot copy only
//   review    a reviewer process a driver starts (agents/), given the brief,
//             reading the snapshot alone
//   check     the answer, by script, with at most two correction rounds;
//             coverage from the brief, the correction rounds and, for a
//             reviewer whose trace is complete, its reads
//   report    one standard report and the completion record
//   clean     the snapshot is removed, whatever happened
//
// runReviewCore takes plain values and the host's parts, and hands back the
// result. By itself it writes nothing under .openqodex/ or in the openqodex
// home, registers no signal handler, writes no process.env and prints
// nothing: every line goes to `onEvent`, and the host writes the run folder,
// the receipts and the records from the events and the result (the CLI's
// review-run.ts). What it makes on disk it makes through the host's parts:
// the snapshot through the snapshot maker, scanner installs through the tool
// resolver, the graph's kept build through the graph store.
import {
  MANIFEST_VERSION,
  OpenQodexError,
  buildDisplay,
  buildExcerptDisplay,
  buildInventory,
  buildReviewerBrief,
  checkSubmission,
  REVIEWER_TOOLS,
  REVIEWER_WEB_TOOLS,
  completionRecord,
  configHash,
  getChange,
  getTreeChange,
  getWholeRepo,
  readCoverage,
  redactSecrets,
  safeGit,
  selectLenses,
} from "@openqodex/core";
import type {
  BaseSource,
  Change,
  ChangeScope,
  CompletionRecord,
  Config,
  Display,
  ImpactSummary,
  Report,
  ResolveTool,
  ReviewerRecord,
  RunManifest,
  RunTarget,
  ScanResult,
  ScannerSource,
  SelectedLens,
  TraceEntry,
  WholeRepo,
} from "@openqodex/core";
import { PacketCollision, PacketLeak, renderImpactBlock, writePacket } from "@openqodex/graph";
import type { GraphStore, Lease } from "@openqodex/graph";
import { meterSession } from "./agent-usage.js";
import { REVIEWER_NAMES, hostAgent } from "./agents/driver.js";
import type { ReviewerDriver, ReviewerSession } from "./agents/driver.js";
import { converse, deliverRanges, redactSnapshot } from "./conversation.js";
import type { Conversation } from "./conversation.js";
import { buildGraphRun, buildHotSpots, nothingToReviewLine, ruleCoverage, scanChange, wholeRepoLenses } from "./pipeline.js";
import type { GraphHost, PipelineResult, ScanHost } from "./pipeline.js";
import { redactStored } from "./redact.js";
import { hashSnapshot, lineCounter, snapshotText } from "./snapshot.js";
import { usageTotals } from "./usage.js";
import type { CallRecord, UsageTotals } from "./usage.js";

// A frozen copy of the state under review: `tree` is the folder the
// scanners and the reviewer read; `folder` holds it and whatever the maker
// keeps beside it.
export type Snapshot = { folder: string; tree: string };

// How the host makes and removes snapshots (on the laptop: git work trees
// under <openqodex home>/checkouts, the CLI's checkout.ts).
export type SnapshotMaker = {
  // A snapshot of commit `sha`; with `tree`, filled from that git tree, its
  // new objects read from `tree.objects` (the working state the change
  // source staged). `prefix` starts the folder's name.
  make(repoRoot: string, sha: string, prefix: string, tree?: { sha: string; objects: string; alternates: string }): Promise<Snapshot>;
  // For a target's snapshot: the developer's settings files in place of the
  // commit's own .openqodex folder.
  placeSettings(repoRoot: string, tree: string): void;
  // How many of `paths` the snapshot holds as Git LFS pointer files.
  lfsPaths(tree: string, paths: string[]): Promise<number>;
  remove(repoRoot: string, snapshot: Snapshot): Promise<void>;
  // The same at once and synchronously, for a signal handler that exits
  // right after it.
  removeNow(repoRoot: string, snapshot: Snapshot): void;
};

// A branch or a pull request the host resolved for `ReviewInputs.target`:
// its head, its base and their merge base, the lines it has to say, and
// `release`, which removes anything the host made to resolve it (the CLI's
// temporary ref of a fetched pull request head) once the scan is done.
export type ResolvedTarget = { headSha: string; baseRef: string; baseSource: BaseSource; baseSha: string; mergeBase: string; notes: string[]; release(): Promise<void> };

export type ReviewInputs = {
  // The developer's repository: its git, its approvals.
  repoRoot: string;
  // The config in force, every override of the host already applied.
  config: Config;
  // Own work against a base, as the change source reads `scope`; with `all`
  // the whole repository; with `target` a branch or a pull request, which
  // `ReviewDeps.resolveTarget` resolves.
  scope: ChangeScope;
  all?: boolean;
  target?: string;
  // Files to review as they were before `init` wrote them (getChange overlay).
  overlay?: { path: string; content: string | null }[];
  only?: ScannerSource[];
  skip?: ScannerSource[];
  noGraph: boolean;
  // `auto` or one of REVIEWER_NAMES.
  reviewer: string;
  // The reviewer gets its agent's web tools.
  web: boolean;
  // The deadline for the scan, the graph and every reviewer turn, fixed
  // this long after the reviewer is chosen and before anything is scanned.
  timeoutMs: number;
  // The version the run's manifest names.
  runtimeVersion: string;
};

// Every line and stage of a run, in the order they happen. The host acts on
// each at once (`onEvent` is called synchronously); one that throws stops
// the run there, the snapshot still removed.
export type ReviewEvent =
  // A stage line (the CLI prints it unless --quiet).
  | { type: "progress"; line: string }
  // A line shown whatever the verbosity (the CLI prints it always).
  | { type: "warning"; line: string }
  // The scan as the scanners left it, before its redaction (the CLI queues
  // its feedback offer for a scanner that failed).
  | { type: "scan"; scan: ScanResult }
  // The change and its redacted scan, as soon as both are known (the CLI
  // opens its run folder here). `secrets`: the raw matched secrets, in memory
  // only, for every redaction the host does itself.
  | { type: "prepared"; change: Change; scan: ScanResult; secrets: string[] }
  // The brief and what goes with it, before the reviewer starts.
  | { type: "brief"; manifest: RunManifest; scan: ScanResult; brief: string; impact: ImpactSummary }
  // The reviewer started.
  | { type: "started"; driver: string; version: string; pid: number | null };

export type ReviewDeps = {
  // The drivers `auto` tries, in order, after the agent running the host.
  drivers: readonly ReviewerDriver[];
  snapshots: SnapshotMaker;
  // Where each scanner's binary comes from, and whether a missing one may
  // install and how long it is waited for.
  resolveTool: ResolveTool;
  // Resolves `ReviewInputs.target`, when there is one.
  resolveTarget: (spec: string) => Promise<ResolvedTarget>;
  // The code graph's kept store; left out, the graph is built in memory.
  graphStore?: () => Promise<{ store: GraphStore | null; refused?: string }>;
  // The owners' instructions for the brief, redacted with the scan's
  // secrets, and the hash of the file they came from (null for none).
  instructions: (secrets: string[]) => { text: string; hash: string | null };
  onEvent: (event: ReviewEvent) => void;
  // Receives the run's result before the run cleans up (the graph's lease,
  // the snapshot), so the host writes and prints everything from it first:
  // a cleanup that fails afterwards (a folder in the snapshot that cannot be
  // written) then throws out of runReviewCore without losing the review.
  // What it throws stops the run there, the cleanup still done.
  onResult?: (result: ReviewCoreResult) => void | Promise<void>;
  // Called once, as soon as the deadline is fixed, with a synchronous stop:
  // it ends a running boundary check and the reviewer's process group and
  // removes the snapshot. A host's signal handler calls it before it exits.
  // After the run it does nothing.
  onStop?: (stop: () => void) => void;
  // The clock, epoch milliseconds; the deadline is on it. The drivers in
  // agents/ time their own stop on the system clock, so a host that uses
  // them passes Date.now.
  now: () => number;
};

export type ReviewCoreResult =
  // Nothing to review: the change is empty, or the repository has no files.
  | { ended: "nothing" }
  // No reviewer could start, or its boundary could not be shown for this
  // run: the scan's candidates stay unchecked.
  | { ended: "unavailable"; reasons: string[]; change: Change; scan: ScanResult; secrets: string[] }
  // The reviewer ran. `report` carries the completion record and says
  // incomplete when the record does; `display` is the code report.html shows.
  // `usage`: one record per round, from the driver's running totals.
  | {
      ended: "reviewed";
      report: Report;
      completion: CompletionRecord;
      display: Display;
      submission: unknown;
      trace: TraceEntry[];
      change: Change;
      secrets: string[];
      whole: boolean;
      target: RunTarget | null;
      usage: { calls: CallRecord[]; totals: UsageTotals };
    };

type Chosen = { driver: ReviewerDriver; version: string; bin: string } | { unavailable: string[] };

// `choice` (auto or a driver's name), else the agent running this command
// when its driver is enabled, else the first enabled driver. A driver is
// enabled when detect() says its agent is installed, logged in and
// isolated; one that is not (Cursor, or Codex inside its own sandbox) says
// why and is passed by. An unknown name throws.
export function reviewerOrder(choice: string, drivers: readonly ReviewerDriver[]): ReviewerDriver[] {
  if (choice !== "auto" && !(REVIEWER_NAMES as readonly string[]).includes(choice)) {
    throw new OpenQodexError(`--reviewer must be auto or one of ${REVIEWER_NAMES.join(", ")}, not ${choice}`);
  }
  const host = hostAgent();
  return choice !== "auto"
    ? drivers.filter((d) => d.name === choice)
    : [...drivers.filter((d) => d.name === host), ...drivers.filter((d) => d.name !== host)];
}

async function chooseReviewer(choice: string, drivers: readonly ReviewerDriver[], repoRoot: string): Promise<Chosen> {
  const order = reviewerOrder(choice, drivers);
  const unavailable: string[] = [];
  for (const driver of order) {
    const d = await driver.detect(repoRoot);
    if (d.ok) return { driver, version: d.version, bin: d.bin };
    unavailable.push(`${driver.name}: ${d.missing}; ${d.fix}`);
  }
  return { unavailable: unavailable.length > 0 ? unavailable : [`${choice}: no driver of that name`] };
}

type Prepared = {
  p: PipelineResult;
  snapshot: Snapshot;
  tree: string | null;
  target?: RunTarget;
  whole?: WholeRepo;
};

// A report that carries no finding: an incomplete review.
function incompleteReport(change: Change, scan: ScanResult, config: Config, now: number): Report {
  return {
    version: 1,
    kind: "review",
    change_id: change.id,
    base: { ref: change.baseRef, sha: change.baseSha },
    generated_at: new Date(now).toISOString(),
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
async function prepare(inputs: ReviewInputs, deps: ReviewDeps, scanHost: ScanHost, keep: (s: Snapshot) => void): Promise<Prepared | null> {
  const { repoRoot, config, only, skip } = inputs;
  const say = (line: string) => deps.onEvent({ type: "progress", line });
  const warn = (line: string) => deps.onEvent({ type: "warning", line });
  if (inputs.target !== undefined) {
    const t = await deps.resolveTarget(inputs.target);
    try {
      for (const note of t.notes) warn(note);
      say(`Reviewing ${inputs.target} at ${t.headSha.slice(0, 12)}: base ${t.baseRef} (from ${t.baseSource}), merge base ${t.mergeBase.slice(0, 12)}`);
      const change = await getTreeChange({ repoRoot, baseRef: t.baseRef, baseSha: t.mergeBase, headSha: t.headSha, exclude: config.exclude });
      if (change.files.length === 0) {
        warn(nothingToReviewLine(change));
        return null;
      }
      const snapshot = await deps.snapshots.make(repoRoot, t.headSha, `${change.shortId}-`);
      keep(snapshot);
      deps.snapshots.placeSettings(repoRoot, snapshot.tree);
      const lfs = await deps.snapshots.lfsPaths(snapshot.tree, change.changedPaths);
      if (lfs > 0) warn(`${lfs} changed ${lfs === 1 ? "file is" : "files are"} stored in Git LFS and not fetched: the review sees the pointer files`);
      const target: RunTarget = { spec: inputs.target, base_ref: t.baseRef, base_source: t.baseSource, base_sha: t.baseSha, merge_base: t.mergeBase, head_sha: t.headSha, repo_root: repoRoot, checkout: snapshot.tree };
      const p = await scanChange({ repoRoot, workDir: snapshot.tree, config, change, only, skip, host: scanHost });
      return { p, snapshot, tree: null, target };
    } finally {
      await t.release();
    }
  }

  const head = await headOf(repoRoot);
  let snapshot: Snapshot | null = null;
  let treeSha: string | null = null;
  const change = await getChange({
    repoRoot,
    scope: inputs.all ? { uncommitted: true } : inputs.scope,
    exclude: config.exclude,
    defaultBase: config.defaultBase,
    overlay: inputs.overlay,
    onTree: async (tree) => {
      treeSha = tree.sha;
      snapshot = await deps.snapshots.make(repoRoot, head, "work-", tree);
      keep(snapshot);
    },
  });
  if (snapshot === null) throw new OpenQodexError("the snapshot of the change was not made");
  const snap: Snapshot = snapshot;
  if (inputs.all) {
    // The whole repository as the snapshot holds it, so nothing written in
    // the developer's folder from here on is part of the review.
    const whole = await getWholeRepo({ repoRoot: snap.tree, exclude: config.exclude });
    const p = await scanChange<WholeRepo>({ repoRoot, workDir: snap.tree, config, change: whole, wholeRepo: true, only, skip, host: scanHost });
    return p.scan === null ? null : { p, snapshot: snap, tree: treeSha, whole: p.change };
  }
  if (change.files.length === 0) {
    warn(nothingToReviewLine(change));
    return null;
  }
  say(`Reviewing the change against ${change.baseRef}: ${change.stats.files} ${change.stats.files === 1 ? "file" : "files"}, +${change.stats.additions} -${change.stats.deletions}`);
  const p = await scanChange({ repoRoot, workDir: snap.tree, config, change, only, skip, host: scanHost });
  return { p, snapshot: snap, tree: treeSha };
}

export async function runReviewCore(inputs: ReviewInputs, deps: ReviewDeps): Promise<ReviewCoreResult> {
  const { repoRoot, config } = inputs;
  const say = (line: string) => deps.onEvent({ type: "progress", line });
  const warn = (line: string) => deps.onEvent({ type: "warning", line });
  const chosen = await chooseReviewer(inputs.reviewer, deps.drivers, repoRoot);
  const deadline = deps.now() + inputs.timeoutMs;

  let snapshot: Snapshot | null = null;
  let session: ReviewerSession | null = null;
  // The graph build this review read, held until the review ends.
  let graphLease: Lease | null = null;
  // A driver's boundary check that is running (Codex's sandbox probe): its
  // process group and files, ended synchronously.
  let checking: (() => void) | null = null;
  let over = false;
  // Ctrl-C or a kill in the host: the reviewer's process group and the
  // snapshot go too, synchronously, since the host exits right after. The
  // reviewer runs in a group of its own, so nothing else would stop it.
  deps.onStop?.(() => {
    if (over) return;
    checking?.();
    session?.kill?.();
    if (snapshot !== null) deps.snapshots.removeNow(repoRoot, snapshot as Snapshot);
  });
  const scanHost: ScanHost = { resolveTool: deps.resolveTool, onProgress: say, onScan: (scan) => deps.onEvent({ type: "scan", scan }) };
  // The result goes to the host before the cleanup below.
  const finish = async (result: ReviewCoreResult): Promise<ReviewCoreResult> => {
    await deps.onResult?.(result);
    return result;
  };
  const graphHost: GraphHost = { store: deps.graphStore, onProgress: say, warn };
  try {
    const prep = await prepare(inputs, deps, scanHost, (s) => (snapshot = s));
    if (prep === null) {
      if (inputs.all) warn("Nothing to review: the repository has no files");
      return await finish({ ended: "nothing" });
    }
    const { p } = prep;
    const scan = p.scan as ScanResult;
    const change = p.change;
    deps.onEvent({ type: "prepared", change, scan, secrets: p.secrets });
    // No reviewer can start: the scanner candidates stay unchecked, never a review.
    if ("unavailable" in chosen) return await finish({ ended: "unavailable", reasons: chosen.unavailable, change, scan, secrets: p.secrets });

    // The one redaction every output of this run goes through (redact.ts:
    // each matched secret and each line of a multi-line one).
    const redact = (text: string): string => redactSecrets(text, p.secrets);
    const redaction = redactSnapshot(prep.snapshot.tree, p.secrets);
    if (redaction.redacted > 0) say(`Redacted secrets in ${redaction.redacted} ${redaction.redacted === 1 ? "file" : "files"} of the snapshot`);
    if (redaction.removed.length > 0) warn(redact(`Left out of the review, too large to check for secrets: ${redaction.removed.join(", ")}`));
    const instructions = deps.instructions(p.secrets);
    let lenses: SelectedLens[];
    let impact: ImpactSummary;
    let brief: { text: string; diffFiles: Set<string> };
    if (prep.whole) {
      const hot = await buildHotSpots(p, graphHost, inputs.noGraph);
      impact = hot.impact;
      lenses = wholeRepoLenses(prep.whole, ruleCoverage(p));
      brief = buildReviewerBrief({ change, scan, lenses, config, secrets: p.secrets, instructions: instructions.text, whole: { hot: hot.hot, graphNote: hot.note, inventory: buildInventory(prep.whole, scan) } });
    } else {
      const run = await buildGraphRun(p, graphHost, inputs.noGraph);
      graphLease = run.lease;
      impact = run.impact;
      // The graph files the brief names, written into the snapshot before it
      // is hashed, so the reviewer reads them inside the folder it may read.
      if (run.graph) {
        try {
          const packet = await writePacket({ root: prep.snapshot.tree, repoRoot, graph: run.graph, impact, baseSha: change.baseSha, secrets: p.secrets });
          impact = { ...impact, packet: packet.dir };
        } catch (error) {
          if (error instanceof PacketCollision || error instanceof PacketLeak) throw new OpenQodexError(error.message);
          throw error;
        }
      }
      lenses = selectLenses(change, undefined, ruleCoverage(p));
      brief = buildReviewerBrief({ change, scan, lenses, config, secrets: p.secrets, impactBlock: renderImpactBlock(impact), instructions: instructions.text, target: prep.target });
    }
    const manifest: RunManifest = {
      version: MANIFEST_VERSION,
      change_id: change.id,
      config_hash: configHash(config),
      created_at: new Date(deps.now()).toISOString(),
      lenses: lenses.map((l) => ({ name: l.name, confidenceFloor: l.confidenceFloor })),
      instructions_hash: instructions.hash,
      runtime_version: inputs.runtimeVersion,
      ...(prep.target ? { target: prep.target } : {}),
    };
    deps.onEvent({ type: "brief", manifest, scan, brief: brief.text, impact });

    // A reviewer whose trace is not complete (Codex) has no read counted:
    // coverage is the brief and the correction rounds only.
    const traced = chosen.driver.traced;
    // The driver's per-run proof of its boundary (Codex's sandbox probe),
    // on the redacted snapshot, before its hash is taken.
    const unsafe = (await chosen.driver.check?.({ snapshotDir: prep.snapshot.tree, bin: chosen.bin, register: (cleanup) => (checking = cleanup) })) ?? null;
    if (unsafe !== null) return await finish({ ended: "unavailable", reasons: [`${chosen.driver.name}: ${unsafe}`], change, scan, secrets: p.secrets });
    const before = hashSnapshot(prep.snapshot.tree);
    const lineCount = lineCounter(prep.snapshot.tree);
    // A secret in a path would reach the reviewer through any listing: the
    // reviewer is not started and the review is incomplete.
    const refused = redaction.named > 0 ? "a file name in the change holds a secret the scanners found, so the reviewer was not started; rename the file" : null;
    // Each round's usage is recorded as the turns come back; the turns reach the conversation unchanged.
    const metered = refused === null ? meterSession(chosen.driver.start({ snapshotDir: prep.snapshot.tree, deadline, bin: chosen.bin, web: inputs.web }), { driver: chosen.driver.name, now: deps.now }) : null;
    if (metered !== null) session = metered.session;
    if (session !== null) deps.onEvent({ type: "started", driver: chosen.driver.name, version: chosen.version, pid: session.pid });
    const pid = session?.pid ?? null;
    if (session !== null) say(`Reviewer: ${chosen.driver.name} ${chosen.version} started${pid !== null ? ` (process ${pid})` : ""}; this takes one to three minutes`);
    const startedIso = new Date(deps.now()).toISOString();
    const now = deps.now();
    const talk: Conversation = session === null ? { rounds: 0, trace: [], usage: { turns: 0, input_tokens: null, output_tokens: null, cost_usd: null }, report: null, errors: [], required: 0, disposed: 0, failure: refused, submission: null, delivered: [], startedAt: now, endedAt: now } : await converse({
      session,
      snapshotDir: prep.snapshot.tree,
      brief: brief.text,
      deadline,
      traced,
      say,
      now: deps.now,
      check: (submission, trace, delivered) => {
        const r = checkSubmission({ change, scan, manifest, config, submission, lineCount, wholeRepo: prep.whole ? { lines: prep.whole.lines } : undefined });
        const unread = prep.whole ? [] : readCoverage({ change, briefFiles: brief.diffFiles, trace: traced ? trace : [], lineCount, delivered }).unread;
        return { report: r.ok ? r.report : null, errors: r.ok ? [] : r.errors, unread, required: r.required, disposed: r.disposed };
      },
      deliver: (unread, earlier) => deliverRanges({ snapshotDir: prep.snapshot.tree, unread, earlier, secrets: p.secrets }),
    }).finally(async () => {
      await session?.close();
    });
    if (talk.failure !== null) warn(`openqodex: ${talk.failure}`);
    const after = hashSnapshot(prep.snapshot.tree);

    const reviewer: ReviewerRecord | null = session === null ? null : {
      driver: chosen.driver.name,
      version: chosen.version,
      pid,
      started_at: startedIso,
      ended_at: new Date(talk.endedAt).toISOString(),
      duration_ms: talk.endedAt - talk.startedAt,
      rounds: talk.rounds,
      usage: talk.usage,
    };
    const coverage = readCoverage({ change, briefFiles: brief.diffFiles, trace: traced ? talk.trace : [], lineCount, delivered: talk.delivered });
    // Redacted like the report: a path or a tool input may hold a secret.
    const completion = redactStored(completionRecord({
      change,
      reviewer,
      snapshot: { tree: prep.tree, before, after },
      candidates: { total: talk.required, disposed: talk.disposed },
      coverage,
      trace: talk.trace,
      submissionErrors: talk.report ? [] : talk.errors,
      wholeRepo: prep.whole !== undefined,
      failure: talk.failure,
      tools: inputs.web ? [...REVIEWER_TOOLS, ...REVIEWER_WEB_TOOLS] : REVIEWER_TOOLS,
      traced,
    }), p.secrets);
    // An incomplete review keeps the findings of an answer that passed every
    // check: the report prints them as the findings so far.
    const report: Report = {
      ...(talk.report ?? incompleteReport(change, scan, config, deps.now())),
      impact: prep.whole ? null : impact,
      completion,
    };
    if (completion.status !== "complete") report.verdict = "incomplete";

    // report.html's code, while the diff and the matched secrets are still
    // in memory: the change as a diff, or for the whole repository a few
    // lines of the redacted snapshot around each cited line.
    const display = prep.whole
      ? buildExcerptDisplay({
          changeId: change.id,
          cited: [
            ...report.findings,
            ...report.dropped.map((d) => (d.cited ? { ...d.cited, line_end: d.cited.line_number } : { file_path: d.candidate.filePath, line_number: d.candidate.lineStart, line_end: d.candidate.lineEnd })),
          ],
          read: snapshotText(prep.snapshot.tree),
          secrets: p.secrets,
        })
      : buildDisplay({ change, secrets: p.secrets });
    const calls = metered?.calls() ?? [];
    return await finish({ ended: "reviewed", report, completion, display, submission: talk.submission, trace: talk.trace, change, secrets: p.secrets, whole: prep.whole !== undefined, target: prep.target ?? null, usage: { calls, totals: usageTotals(calls) } });
  } finally {
    over = true;
    graphLease?.release();
    if (snapshot !== null) await deps.snapshots.remove(repoRoot, snapshot as Snapshot);
  }
}
