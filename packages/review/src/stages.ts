import { FINDER_CONFIDENCE_FLOOR, VERIFY_BATCH_SIZE, checkSubmission, findingKey, outsideSnapshot, requiredCandidates, scannerCategory, severityRank } from "@openqodex/core";
import type { Change, Config, FindAnswer, FindPass, FindingV2, Hunk, Report, ReportFinding, ReviewerSessionRecord, ReviewerUsage, ReviewUnit, RunManifest, ScanResult, SubmissionV2, TraceEntry, VerifyAnswer, VerifyBatch, VerifyCandidate, VerifyVerdict } from "@openqodex/core";
import { MAX_CORRECTIONS, converse, deliverRanges } from "./conversation.js";
import type { Conversation, CorrectionRound, Speaker } from "./conversation.js";
import { checkFindAnswer, checkVerifyAnswer } from "./evidence-check.js";
import { snapshotText, lineCounter } from "./snapshot.js";
import { MAX_UNIT_DIFF_BYTES, hunkRefs, unitsOf } from "./units.js";
import { usageTotals } from "./usage.js";
import type { CallRecord, ReviewerRole } from "./usage.js";

export const FINDERS_CONCURRENCY = 4;
export const VERIFIERS_CONCURRENCY = 3;
export type StagedSession = Speaker & { close(): void | Promise<void>; pid?: number | null; calls?: () => CallRecord[]; attempts?: readonly CallRecord[]; sentRounds?: number };
export type StagedArgs = {
  openSession: (role: ReviewerRole) => StagedSession;
  findBrief: (unit: ReviewUnit, pass: FindPass) => { text: string; diffFiles: Set<string> };
  verifyBrief: (batch: VerifyBatch) => { text: string };
  snapshotDir: string;
  change: Change;
  // Incremental runs examine the delta, but anchor on the full change.
  citationChange?: Change;
  scan: ScanResult;
  config: Config;
  manifest: RunManifest;
  secrets: string[];
  deadline: number;
  now: () => number;
  traced: boolean;
  confidenceFloor?: number;
  say: (line: string) => void;
  onRound?: (round: CorrectionRound) => void;
  onStarted?: (role: ReviewerRole, pid: number | null) => void;
  stopped?: () => boolean;
};
export type StagedResult = {
  report: Report;
  submission: SubmissionV2;
  sessions: ReviewerSessionRecord[];
  trace: TraceEntry[];
  usage: { calls: CallRecord[]; totals: ReturnType<typeof usageTotals> };
  rounds: CorrectionRound[];
  missing: string[];
  required: number;
  disposed: number;
  briefFiles: Set<string>;
  delivered: Hunk[];
};
type Run = { role: ReviewerRole; unit?: string; session: StagedSession; talk: Conversation; examined?: string[] };
type Verified = { batch: VerifyBatch; run: Run; answer: VerifyAnswer };
const emptyUsage = (): ReviewerUsage => ({ turns: 0, input_tokens: null, output_tokens: null, cost_usd: null });
const noDelivery = () => ({ text: "", delivered: [], left: [], later: 0, leak: false });
const normalTitle = (title: string) => title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const candidateFile = (c: VerifyCandidate) => c.kind === "finder" ? c.candidate.file_path : c.candidate.filePath;
const foundBy = (c: VerifyCandidate): string[] => c.kind === "finder" ? c.foundBy : [c.candidate.token];

async function pool<T>(jobs: T[], limit: number, work: (job: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = await Promise.allSettled(Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) break;
      await work(jobs[i]!);
    }
  }));
  const failed = workers.find((w) => w.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

export async function runStagedReview(args: StagedArgs): Promise<StagedResult> {
  const { change, scan, config } = args;
  const citationChange = args.citationChange ?? change;
  const read = snapshotText(args.snapshotDir);
  const lineCount = lineCounter(args.snapshotDir);
  const hunks = hunkRefs(change);
  const units = unitsOf(change, hunks);
  const startedAt = args.now();
  const findDeadline = startedAt + (args.deadline - startedAt) / 2;
  const runs: Run[] = [];
  const missing: string[] = units.filter((u) => u.diffBytes > MAX_UNIT_DIFF_BYTES).map((u) => `unit ${u.id} contains an indivisible hunk over the ${MAX_UNIT_DIFF_BYTES / 1024} KB diff bound`);
  const rounds: CorrectionRound[] = [];
  const briefFiles = new Set<string>();
  const closedRuns = new Map<Run, Promise<void>>();
  let live = 0;
  let done = 0;
  let verifierNumber = 0;
  let budgetRefused = false;
  let hostFailure: unknown = null;
  const stopped = () => args.stopped?.() === true || budgetRefused || hostFailure !== null;
  const emit = (send: () => void) => {
    try { send(); }
    catch (error) {
      hostFailure = error;
      for (const run of runs) void close(run).catch(() => {});
      throw error;
    }
  };
  const say = (line: string) => emit(() => args.say(line));
  const heartbeat = setInterval(() => {
    try { say(`Reviewers still working: ${live} sessions live, ${done} done`); }
    catch { /* The pool propagates the host failure after closing sessions. */ }
  }, 15_000);
  heartbeat.unref();
  const roundFor = (role: ReviewerRole) => (r: Omit<CorrectionRound, "by">) => {
    const round = { ...r, by: role };
    rounds.push(round);
    emit(() => args.onRound?.(round));
  };
  const failed = (talk: Conversation) => talk.failure ?? (args.traced && talk.trace.some(outsideSnapshot) ? "the reviewer tried to read outside the snapshot" : talk.errors.length > 0 ? talk.errors.join("; ") : null);
  const start = (role: ReviewerRole, unit?: string): Run => {
    const session = args.openSession(role);
    const talk: Conversation = { rounds: 0, trace: [], usage: emptyUsage(), report: null, checked: null, errors: [], required: 0, disposed: 0, failure: null, submission: null, delivered: [], carried: [], startedAt: args.now(), endedAt: args.now() };
    const run = { role, ...(unit ? { unit } : {}), session, talk };
    runs.push(run);
    live++;
    emit(() => args.onStarted?.(role, session.pid ?? null));
    return run;
  };
  const close = (run: Run): Promise<void> => {
    const earlier = closedRuns.get(run);
    if (earlier) return earlier;
    const pending = (async () => {
      try { await run.session.close(); }
      finally { live--; done++; }
    })();
    closedRuns.set(run, pending);
    return pending;
  };
  const noteRefusal = (run: Run) => {
    if (run.session.attempts?.some((c) => c.outcome === "refused")) {
      budgetRefused = true;
      missing.push(run.talk.failure ?? "the budget refused a reviewer call");
    }
  };
  const findings: { run: Run; answer: FindAnswer; passRole: string }[] = [];
  const verified: Verified[] = [];
  const unverified = new Set<string>();
  let allCandidates: VerifyCandidate[] = [];
  try {
    const jobs = units.flatMap((unit) => (["local", "contracts"] as const).map((pass) => ({ unit, pass })));
    await pool(jobs, FINDERS_CONCURRENCY, async ({ unit, pass }) => {
      let answer: FindAnswer | null = null;
      let last: string | null = null;
      let began = false;
      const passRole = `finder:${unit.id}:${pass}` as const;
      for (let attempt = 0; attempt < 2 && !stopped() && args.now() < findDeadline; attempt++) {
        let run: Run | null = null;
        try {
          const brief = args.findBrief(unit, pass);
          run = start(attempt === 0 ? passRole : `${passRole}:retry1`, unit.id);
          began = true;
          let checked: FindAnswer | null = null;
          run.talk = await converse({ session: run.session, snapshotDir: args.snapshotDir, brief: brief.text, deadline: findDeadline, traced: args.traced, heartbeat: false, say, now: args.now, onRound: roundFor(run.role),
            check: (value) => {
              const result = checkFindAnswer(value, unit, citationChange, read);
              checked = result.errors.length === 0 ? result.answer : null;
              run!.examined = result.answer.examined;
              return { report: null, errors: result.errors, unread: pass === "local" ? unit.hunks.filter((h) => !result.answer.examined.includes(h.id)) : [], required: 0, disposed: 0 };
            },
            deliver: (unread) => deliverRanges({ snapshotDir: args.snapshotDir, unread, secrets: args.secrets, change }),
          });
          // Model briefs count only after the transport received them.
          if (run.session.sentRounds === undefined || run.session.sentRounds > 0) for (const file of brief.diffFiles) briefFiles.add(file);
          noteRefusal(run);
          last = failed(run.talk);
          if (last === null && checked !== null) { answer = checked; findings.push({ run, answer, passRole }); break; }
        } catch (error) {
          if (hostFailure !== null) throw hostFailure;
          last = (error instanceof Error ? error.message : String(error)).split("\n")[0]!;
          if (run) run.talk.failure = last;
        } finally {
          if (run) await close(run);
        }
      }
      if (answer === null) {
        missing.push(!began ? `unit ${unit.id} was not started: ${last ?? (stopped() ? "the review stopped" : "the finders' time ran out")}` : `unit ${unit.id} was not examined by ${pass}: ${last ?? "the finders' time ran out"}`);
        for (const h of unit.hunks) missing.push(`hunk ${h.id} of ${h.path} was not examined by the ${pass} pass`);
      }
    });

    if (hostFailure !== null) throw hostFailure;
    const candidates: VerifyCandidate[] = [];
    const exact = new Map<string, Extract<VerifyCandidate, { kind: "finder" }>>();
    // Session start order, independent of concurrent completion order.
    findings.sort((a, b) => runs.indexOf(a.run) - runs.indexOf(b.run));
    for (const f of findings) for (const c of f.answer.candidates) {
      const key = [c.file_path, c.line_number, c.line_end ?? c.line_number, c.category, normalTitle(c.title)].join("\0");
      const prior = exact.get(key);
      if (prior) { if (!prior.foundBy.includes(f.passRole)) prior.foundBy.push(f.passRole); continue; }
      const entry = { id: `k${exact.size + 1}`, kind: "finder" as const, candidate: c, foundBy: [f.passRole] };
      exact.set(key, entry);
      candidates.push(entry);
    }
    candidates.push(...requiredCandidates(scan, config).map((c) => ({ id: c.id, kind: "scanner" as const, candidate: c })));
    allCandidates = candidates;
    const files = new Map<string, VerifyCandidate[]>();
    for (const c of candidates) files.set(candidateFile(c), [...(files.get(candidateFile(c)) ?? []), c]);
    const batches: VerifyBatch[] = [];
    for (const [file, list] of files) for (let i = 0; i < list.length; i += VERIFY_BATCH_SIZE) batches.push({ file, hunks: hunks.filter((h) => h.path === file), candidates: list.slice(i, i + VERIFY_BATCH_SIZE) });
    const verifyCheck = (batch: VerifyBatch, accept: (answer: VerifyAnswer | null) => void): Parameters<typeof converse>[0]["check"] => (value) => {
      const result = checkVerifyAnswer(value, batch, citationChange, read, lineCount);
      accept(result.errors.length === 0 ? result.answer : null);
      return { report: null, errors: result.errors, unread: [], required: batch.candidates.length, disposed: result.errors.length === 0 ? batch.candidates.length : 0 };
    };
    const abandon = (batch: VerifyBatch, reason: string) => {
      batch.candidates.forEach((c) => unverified.add(c.id));
      missing.push(`candidates ${batch.candidates.map((c) => c.id).join(", ")} were not verified: ${reason}`);
    };
    await pool(batches, VERIFIERS_CONCURRENCY, async (batch) => {
      let accepted = false;
      for (let attempt = 0; attempt < 2 && !stopped() && args.now() < args.deadline; attempt++) {
        let run: Run | null = null;
        try {
          const brief = args.verifyBrief(batch);
          run = start(`verifier:${++verifierNumber}`);
          let answer: VerifyAnswer | null = null;
          run.talk = await converse({ session: run.session, snapshotDir: args.snapshotDir, brief: brief.text, deadline: args.deadline, traced: args.traced, heartbeat: false, say, now: args.now, onRound: roundFor(run.role), check: verifyCheck(batch, (a) => { answer = a; }), deliver: noDelivery });
          noteRefusal(run);
          if (failed(run.talk) === null && answer !== null) { verified.push({ batch, run, answer }); accepted = true; break; }
        } catch (error) {
          if (hostFailure !== null) throw hostFailure;
          if (run) run.talk.failure = (error instanceof Error ? error.message : String(error)).split("\n")[0]!;
        } finally {
          if (run && !accepted) await close(run);
        }
      }
      if (!accepted) abandon(batch, stopped() ? "the review stopped" : args.now() >= args.deadline ? "the verifier did not finish in time" : "the verifier session failed twice");
    });

    if (hostFailure !== null) throw hostFailure;
    const sourceOf = (c: VerifyCandidate) => c.kind === "scanner" ? c.candidate.token : c.candidate.lens ? `lens:${c.candidate.lens}` : null;
    const findingOf = (v: VerifyVerdict, c: VerifyCandidate): FindingV2 => ({ severity: v.severity, category: c.kind === "finder" ? c.candidate.category : scannerCategory(c.candidate.source), confidence: v.confidence, file_path: v.file_path, line_number: v.line_number, ...(v.line_end !== undefined ? { line_end: v.line_end } : {}), title: v.title, problem: v.problem, consequence: v.consequence, fix: v.fix, suggested_change: v.suggested_change ?? null, source: sourceOf(c), candidate: c.kind === "scanner" ? c.id : null });
    const analysis = findings.flatMap((f) => f.answer.analysis).map((a) => a.changed.trim().replace(/\s+/g, " ")).find(Boolean)?.split(/(?<=[.!?])\s+/)[0];
    const summary = `Reviewed ${findings.length === 0 ? "no completed finder units" : `units ${[...new Set(findings.map((f) => f.answer.unit))].join(", ")}`}.${analysis ? ` ${analysis}` : ""}`;
    const assemble = () => {
      const submission: SubmissionV2 = { version: 2, change_id: citationChange.id, summary, findings: [], dropped: [] };
      const findingOwners: Verified[] = [];
      const droppedOwners: Verified[] = [];
      const items: { v: VerifyVerdict; c: VerifyCandidate; owner: Verified; finding: FindingV2 }[] = [];
      for (const owner of verified) for (const v of owner.answer.verdicts) {
        const c = owner.batch.candidates.find((c) => c.id === v.id)!;
        if (v.verdict === "confirmed") {
          // Observations pass the same judge before being taken out of the
          // verdict. This also accounts for confirmed scanner observations.
          const finding = findingOf(v, c);
          submission.findings.push(finding);
          findingOwners.push(owner);
          items.push({ v, c, owner, finding });
        } else if (v.verdict === "refuted" && c.kind === "scanner") {
          submission.dropped.push({ candidate: c.id, reason: v.reason, file_path: v.file_path, line_number: v.line_number });
          droppedOwners.push(owner);
        }
      }
      const filteredScan = { ...scan, candidates: scan.candidates.filter((c) => !unverified.has(c.id)) };
      const checked = checkSubmission({ change: citationChange, scan: filteredScan, manifest: args.manifest, config, submission, lineCount, confidenceFloor: args.confidenceFloor });
      const visible = checked.ok ? checkSubmission({ change: citationChange, scan: filteredScan, manifest: args.manifest, config: { ...config, severityThreshold: "info" }, submission, lineCount, confidenceFloor: args.confidenceFloor }) : null;
      return { submission, findingOwners, droppedOwners, items, checked, visible };
    };
    let built = assemble();
    while (!built.checked.ok) {
      const errors = new Map<Verified, string[]>();
      for (const error of built.checked.errors) {
        const finding = /findings\[(\d+)\]/.exec(error);
        const dropped = /dropped\[(\d+)\]/.exec(error);
        const id = /candidate ([ck]\d+)/.exec(error)?.[1];
        const owner = finding ? built.findingOwners[Number(finding[1])] : dropped ? built.droppedOwners[Number(dropped[1])] : verified.find((o) => o.batch.candidates.some((c) => c.id === id));
        for (const target of owner ? [owner] : verified) errors.set(target, [...(errors.get(target) ?? []), error]);
      }
      if (errors.size === 0) break;
      await pool([...errors], VERIFIERS_CONCURRENCY, async ([owner, problems]) => {
        if (owner.run.talk.rounds > MAX_CORRECTIONS || args.now() >= args.deadline || stopped()) {
          owner.run.talk.failure = "the verifier exhausted its correction rounds";
          abandon(owner.batch, owner.run.talk.failure);
          verified.splice(verified.indexOf(owner), 1);
          return;
        }
        let answer: VerifyAnswer | null = null;
        owner.run.talk = await converse({ session: owner.run.session, snapshotDir: args.snapshotDir, brief: "", continuation: { conversation: owner.run.talk, errors: problems }, deadline: args.deadline, traced: args.traced, heartbeat: false, now: args.now, say, check: verifyCheck(owner.batch, (a) => { answer = a; }), deliver: noDelivery, onRound: roundFor(owner.run.role) });
        noteRefusal(owner.run);
        if (answer !== null && failed(owner.run.talk) === null) owner.answer = answer;
        else { owner.run.talk.failure ??= "the verifier did not correct its answer"; abandon(owner.batch, owner.run.talk.failure); verified.splice(verified.indexOf(owner), 1); }
      });
      built = assemble();
    }
    if (!built.checked.ok) throw new Error(`staged assembly could not be checked: ${built.checked.errors.join("; ")}`);
    const report = built.checked.report;
    const shownKeys = new Set(report.findings.map(findingKey));
    const byKey = new Map<string, string[]>();
    const observationKeys = new Set<string>();
    const duplicateKeys = new Set<string>();
    const byId = new Map(built.items.map((item) => [item.c.id, item]));
    for (const item of built.items) {
      const key = findingKey({ ...item.finding, line_end: item.finding.line_end ?? item.finding.line_number, candidate: item.finding.candidate ?? null });
      byKey.set(key, [...new Set([...(byKey.get(key) ?? []), ...foundBy(item.c)])]);
      if (item.v.tier === "observation") observationKeys.add(key);
      let target = item;
      const seen = new Set<string>();
      while (target.v.duplicate_of && !seen.has(target.c.id)) {
        seen.add(target.c.id);
        const next = byId.get(target.v.duplicate_of);
        if (!next) break;
        target = next;
      }
      if (target !== item) {
        const targetKey = findingKey({ ...target.finding, line_end: target.finding.line_end ?? target.finding.line_number, candidate: target.finding.candidate ?? null });
        byKey.set(targetKey, [...new Set([...(byKey.get(targetKey) ?? []), ...foundBy(item.c), ...foundBy(target.c)])]);
        if (targetKey !== key) duplicateKeys.add(key);
      }
    }
    const verdictById = new Map(verified.flatMap((o) => o.answer.verdicts).map((v) => [v.id, v]));
    for (const owner of verified) for (const v of owner.answer.verdicts) {
      if (!v.duplicate_of || byId.has(v.id)) continue;
      let targetId = v.duplicate_of;
      const seen = new Set<string>();
      while (verdictById.get(targetId)?.duplicate_of && !seen.has(targetId)) {
        seen.add(targetId);
        targetId = verdictById.get(targetId)!.duplicate_of!;
      }
      const target = byId.get(targetId);
      const candidate = owner.batch.candidates.find((c) => c.id === v.id)!;
      if (target) {
        const key = findingKey({ ...target.finding, line_end: target.finding.line_end ?? target.finding.line_number, candidate: target.finding.candidate ?? null });
        byKey.set(key, [...new Set([...(byKey.get(key) ?? []), ...foundBy(candidate)])]);
      }
    }
    const observations: ReportFinding[] = [];
    report.findings = report.findings.flatMap((f) => {
      const key = findingKey(f);
      if (duplicateKeys.has(key)) return [];
      const entry = { ...f, found_by: byKey.get(key) ?? [] };
      if (observationKeys.has(key)) { observations.push(entry); return []; }
      return [entry];
    });
    if (built.visible?.ok) for (const f of built.visible.report.findings) {
      const key = findingKey(f);
      if (observationKeys.has(key) && !duplicateKeys.has(key) && !observations.some((o) => findingKey(o) === key)) observations.push({ ...f, found_by: byKey.get(key) ?? [] });
    }
    observations.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || (b.confidence ?? 0) - (a.confidence ?? 0) || (b.found_by?.length ?? 0) - (a.found_by?.length ?? 0));
    report.below_threshold = Math.max(0, report.below_threshold - observations.filter((o) => !shownKeys.has(findingKey(o))).length);
    report.observations = observations.slice(0, 12);
    report.observations_omitted = Math.max(0, observations.length - 12);
    report.not_reviewed = requiredCandidates(scan, config).filter((c) => unverified.has(c.id));
    for (const c of allCandidates) {
      const verdict = verified.flatMap((o) => o.answer.verdicts).find((v) => v.id === c.id);
      if (c.kind !== "finder" || !unverified.has(c.id) && verdict?.verdict !== "unresolved") continue;
      const entry = { title: c.candidate.title, file_path: c.candidate.file_path, confidence: c.candidate.confidence, floor: Math.max(args.confidenceFloor ?? 0.7, FINDER_CONFIDENCE_FLOOR, args.manifest.lenses.find((l) => l.name === c.candidate.lens)?.confidenceFloor ?? 0), reason: unverified.has(c.id) ? "not verified" : "unresolved by the verifier" };
      report.low_confidence.push(entry);
    }
    const blocking = config.blockOnSeverity;
    report.verdict = missing.length > 0 ? "incomplete" : blocking && report.findings.some((f) => severityRank(f.severity) >= severityRank(blocking)) ? "blocked" : "passed";
    const calls = runs.flatMap((r) => [...(r.session.calls?.() ?? r.session.attempts ?? [])]);
    const trace = runs.flatMap((r) => r.talk.trace.map((t) => ({ ...t, session: r.role })));
    const sessions = runs.map((r): ReviewerSessionRecord => ({ role: r.role, ...(r.unit ? { unit: r.unit } : {}), rounds: r.talk.rounds, usage: r.talk.usage, failure: failed(r.talk), ...(r.examined ? { examined: r.examined } : {}) }));
    const submission = { ...built.submission, findings: built.submission.findings.filter((_, i) => {
      const item = built.items[i]!;
      if (item.c.kind === "scanner") return true;
      const key = findingKey({ ...item.finding, line_end: item.finding.line_end ?? item.finding.line_number, candidate: null });
      return item.v.tier === "finding" && !duplicateKeys.has(key);
    }) };
    return { report, submission, sessions, trace, usage: { calls, totals: usageTotals(calls) }, rounds, missing: [...new Set(missing)], required: requiredCandidates(scan, config).length, disposed: requiredCandidates(scan, config).filter((c) => !unverified.has(c.id)).length, briefFiles, delivered: runs.flatMap((r) => r.session.sentRounds === undefined ? r.talk.delivered : r.talk.carried.slice(0, Math.max(0, r.session.sentRounds - 1)).flat()) };
  } finally {
    clearInterval(heartbeat);
    await Promise.all(runs.map(close));
  }
}
