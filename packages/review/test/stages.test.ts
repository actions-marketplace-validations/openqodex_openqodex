// Round 1 failures: one bad quote discards good candidates, an oversized hunk
// blocks completion, unknown lenses fail assembly, neighbours split batches,
// invalid duplicates hide scanners, idle verifiers accumulate, one bad item
// discards a batch, and concurrent completion changes candidate ids.
// Failure cases: invalid evidence reaches verification, refutations become
// findings, scanners stay unresolved, failed sessions erase other findings,
// same-line defects collapse, retry call ids collide, stop leaves sessions
// open, and finders use the verifier's reserved time.
import { afterAll, expect, it } from "vitest";
import { buildFindBrief, buildVerifyBrief, completionRecord, readCoverage } from "@openqodex/core";
import type { FindAnswer, ReviewUnit, VerifyAnswer, VerifyBatch } from "@openqodex/core";
import { runStagedReview } from "../src/stages.js";
import type { StagedArgs } from "../src/stages.js";
import { modelSession } from "../src/model-loop.js";
import type { ModelSession } from "../src/model-loop.js";
import type { ModelRequest, ModelReviewer } from "../src/reviewer.js";
import { hunkRefs, unitsOf } from "../src/units.js";
import { cleanupFixtures, candidate, fixture, reply, scanner, verdict } from "./staged-fixture.js";

afterAll(cleanupFixtures);
type Answerer = (answer: FindAnswer | VerifyAnswer, request: ModelRequest, brief: { unit?: ReviewUnit; batch?: VerifyBatch; pass?: string }) => unknown | Promise<unknown>;
function setup(answerer?: Answerer, files?: string[]) {
  const f = fixture(files);
  const requests: ModelRequest[] = [];
  const realBriefs = new Map<string, { unit?: ReviewUnit; batch?: VerifyBatch; pass?: string }>();
  const shared: import("../src/usage.js").CallRecord[] = [];
  const opened: ModelSession[] = [];
  let stopped = false;
  let allow = true;
  let clock = Date.now();
  const closed = new Set<number>();
  const budgets: import("../src/reviewer.js").AuthorizeRequest[] = [];
  const model: ModelReviewer = { kind: "model", model: "fixture", maxOutputTokens: 4096, async complete(request) {
    requests.push(structuredClone(request));
    const briefText = request.messages.find((m) => m.role === "user")!.text;
    const brief = (realBriefs.get(briefText) ?? JSON.parse(briefText.split("\nPrevious answer:")[0]!)) as { unit?: ReviewUnit; batch?: VerifyBatch; pass?: string };
    const answer: FindAnswer | VerifyAnswer = brief.unit
      ? { version: "find-1", change_id: f.change.id, unit: brief.unit.id, examined: brief.unit.hunks.map((h) => h.id), analysis: brief.unit.hunks.map((h) => ({ hunk: h.id, changed: "The operation changed.", could_break: "Inputs can be unsafe." })), candidates: brief.pass === "local" ? [candidate(brief.unit.files[0]!)] : [] }
      : { version: "verify-1", change_id: f.change.id, verdicts: brief.batch!.candidates.map((c) => verdict(c)) };
    return reply(answerer ? await answerer(answer, request, brief) : answer);
  } };
  const args: StagedArgs = {
    snapshotDir: f.dir, change: f.change, scan: f.scan, config: f.config, manifest: f.manifest, secrets: [], deadline: clock + 60_000, now: () => clock, traced: true, say: () => {}, stopped: () => stopped,
    findBrief: (unit, pass) => ({ text: JSON.stringify({ unit, pass }), diffFiles: new Set(unit.files) }),
    verifyBrief: (batch) => ({ text: JSON.stringify({ batch }) }),
    openSession: (role) => {
      const session = modelSession({ reviewer: model, role, shared, box: { snapshotDir: f.dir, change: f.change, secrets: [], graph: null, graphNote: null }, now: () => clock, budget: { deadlineMs: 60_000, authorize: async (call) => { budgets.push(call); return allow; } } });
      const id = opened.push(session);
      return { send: (text) => session.send(text), attempts: session.attempts, get sentRounds() { return session.sentRounds; }, close: async () => { closed.add(id); await session.close(); } };
    },
  };
  return { ...f, args, requests, realBriefs, opened, budgets, closed, refuse: () => { allow = false; }, advance: (ms: number) => { clock += ms; }, stop: () => { stopped = true; opened.forEach((s) => s.kill()); } };
}
function completion(r: Awaited<ReturnType<typeof runStagedReview>>, f: ReturnType<typeof setup>) {
  return completionRecord({ change: f.change, reviewer: { driver: "model", version: "fixture", pid: null, started_at: "now", ended_at: "now", duration_ms: 0, rounds: r.sessions.reduce((n, s) => n + s.rounds, 0), usage: r.sessions[0]!.usage, sessions: r.sessions }, snapshot: { tree: null, before: "same", after: "same" }, candidates: { total: r.required, disposed: r.disposed }, coverage: readCoverage({ change: f.change, trace: [], briefFiles: r.briefFiles }), trace: [], submissionErrors: [], wholeRepo: false, missing: r.missing });
}
it("sends an invented quote back and never verifies the rejected candidate", async () => {
  const f = setup((answer, request) => {
    if (answer.version === "find-1" && answer.candidates.length) {
      if (request.purpose === "find") answer.candidates[0]!.evidence[0]!.quote = "invented quote";
      else answer.candidates = [];
    }
    return answer;
  });
  const r = await runStagedReview(f.args);
  expect(r.rounds.some((round) => round.errors.some((e) => e.includes("quote")))).toBe(true);
  expect(r.submission.findings).toEqual([]);
  expect(f.requests.some((r) => r.purpose === "verify")).toBe(false);
});
it("keeps refuted finder candidates out of findings", async () => {
  const f = setup((answer) => { if (answer.version === "verify-1") answer.verdicts.forEach((v) => { v.verdict = "refuted"; }); return answer; });
  const r = await runStagedReview(f.args);
  expect(r.report.findings).toEqual([]);
  expect(r.submission.findings).toEqual([]);
  expect(r.missing).toEqual([]);
});
it("corrects an unresolved scanner and accepts its second answer", async () => {
  const f = setup((answer, request) => { if (answer.version === "verify-1" && request.purpose === "verify") answer.verdicts.filter((v) => v.id === "c1").forEach((v) => { v.verdict = "unresolved"; }); return answer; });
  f.scan.candidates.push(scanner("a.txt"));
  const r = await runStagedReview(f.args);
  expect(r.rounds.some((round) => round.errors.some((e) => e.includes("a scanner candidate is confirmed or refuted")))).toBe(true);
  expect(r.report.findings.some((f) => f.candidate === "c1")).toBe(true);
  expect(r.disposed).toBe(1);
});
it("retries a failed finder once and keeps other units' checked findings", async () => {
  const f = setup((answer, request) => { if (request.callId.startsWith("finder:u1:local")) throw new Error("provider failed"); return answer; });
  const r = await runStagedReview(f.args);
  expect(r.sessions.filter((s) => s.role.startsWith("finder:u1:local"))).toHaveLength(2);
  expect(r.missing).toContain("hunk h1 of a.txt was not examined by the local pass");
  expect(completion(r, f).status).toBe("incomplete");
  expect(r.report.findings.some((f) => f.file_path === "b.txt")).toBe(true);
});
it("leaves failed verifier scanners not reviewed and preserves other findings", async () => {
  const f = setup((answer, _request, brief) => { if (brief.batch?.file === "a.txt") throw new Error("provider failed"); return answer; });
  f.scan.candidates.push(scanner("a.txt"));
  const r = await runStagedReview(f.args);
  expect(r.report.not_reviewed.map((c) => c.id)).toEqual(["c1"]);
  expect(r.report.low_confidence).toContainEqual(expect.objectContaining({ file_path: "a.txt", reason: "not verified" }));
  expect(completion(r, f).status).toBe("incomplete");
  expect(r.report.findings.some((f) => f.file_path === "b.txt")).toBe(true);
});
it("delivers two distinct same-line candidates to the same verifier", async () => {
  const f = setup((answer) => { if (answer.version === "find-1" && answer.candidates.length) answer.candidates.push(candidate(answer.candidates[0]!.file_path, "A different defect")); return answer; });
  await runStagedReview(f.args);
  const briefs = f.requests.filter((r) => r.purpose === "verify").map((r) => JSON.parse(r.messages[1]!.text).batch as VerifyBatch);
  expect(briefs[0]!.candidates.map((c) => c.id)).toEqual(["k1", "k2"]);
});
it("gives four finders and their verifier sessions unique call ids and merged usage", async () => {
  const f = setup();
  const r = await runStagedReview(f.args);
  expect(r.sessions.filter((s) => s.role.startsWith("finder:"))).toHaveLength(4);
  const ids = r.usage.calls.map((c) => c.callId);
  expect(new Set(ids).size).toBe(ids.length);
  expect(r.usage.totals.attempts).toBe(f.requests.length);
  expect(r.usage.totals.inputTokens).toBe(f.requests.length * 10);
  expect(f.budgets.at(-1)!.usageSoFar.attempts).toBeGreaterThan(0);
  expect(f.closed.size).toBe(f.opened.length);
});
it("closes every open session when stopped while providers are pending", async () => {
  let pending = 0;
  let reached!: () => void;
  const allStarted = new Promise<void>((resolve) => { reached = resolve; });
  const f = setup(async (answer) => { if (++pending === 4) reached(); await new Promise(() => {}); return answer; });
  const running = runStagedReview(f.args);
  await allStarted;
  f.stop();
  const r = await running;
  expect(f.closed.size).toBe(4);
  expect(r.missing.join(" ")).toContain("the review stopped");
});
it("reserves verifier time when the finder share expires with units unstarted", async () => {
  const f = setup((answer, _request, brief) => { if (brief.unit?.id === "u2" && brief.pass === "contracts") f.advance(31_000); return answer; }, ["a.txt", "b.txt", "c.txt", "d.txt"]);
  const r = await runStagedReview(f.args);
  expect(r.missing.join(" ")).toContain("was not started: the finders' time ran out");
  expect(f.requests.some((r) => r.purpose === "verify")).toBe(true);
  expect(r.report.findings.length).toBeGreaterThan(0);
});
it("corrects verifier prose before assembly and closes accepted sessions", async () => {
  const f = setup((answer, request) => { if (answer.version === "verify-1" && request.purpose === "verify") answer.verdicts.forEach((v) => { v.problem = "word ".repeat(30); }); return answer; });
  const r = await runStagedReview(f.args);
  expect(r.rounds.some((r) => r.errors.some((e) => e.includes("limit is 20")))).toBe(true);
  expect(r.report.findings).toHaveLength(2);
  expect(r.missing).toEqual([]);
});
it("keeps findings from other batches when one verifier cannot fix its prose", async () => {
  const f = setup((answer, _request, brief) => { if (answer.version === "verify-1" && brief.batch?.file === "a.txt") answer.verdicts.forEach((v) => { v.problem = "word ".repeat(30); }); return answer; });
  f.scan.candidates.push(scanner("a.txt"));
  const r = await runStagedReview(f.args);
  expect(r.report.not_reviewed.map((c) => c.id)).toEqual(["c1"]);
  expect(r.report.findings.map((f) => f.file_path)).toEqual(["b.txt"]);
  expect(r.missing.join(" ")).toContain("correction rounds");
});
it("folds confirmed duplicates and ranks observations without reviewer provenance", async () => {
  const f = setup((answer, _request, brief) => {
    if (answer.version === "find-1") answer.candidates = [candidate(brief.unit!.files[0]!, brief.pass === "local" ? "First claim" : "Second claim")];
    if (answer.version === "verify-1") { answer.verdicts[0]!.tier = "observation"; answer.verdicts[1]!.duplicate_of = answer.verdicts[0]!.id; }
    return answer;
  });
  f.config.blockOnSeverity = "major";
  const r = await runStagedReview(f.args);
  expect(r.report.findings).toEqual([]);
  expect(r.report.observations).toHaveLength(2);
  expect(r.report.observations![0]!.found_by).toBeUndefined();
  expect(r.report.verdict).toBe("passed");
});

// B4's real briefs must be exercised after they replace the contract stubs.
const probe = fixture(["a.txt"]);
let briefsBuilt = false;
try { buildFindBrief({ change: probe.change, scan: probe.scan, config: probe.config, lenses: [], secrets: [] }, unitsOf(probe.change, hunkRefs(probe.change))[0]!, "local"); briefsBuilt = true; } catch (error) { if (!(error instanceof Error) || !error.message.includes("not built yet")) throw error; }
it.skipIf(!briefsBuilt)("accepts the real find and verify briefs through a model provider", async () => {
  const f = setup();
  const shared = { change: f.change, scan: f.scan, config: f.config, lenses: [], secrets: [] };
  f.args.findBrief = (unit, pass) => {
    const brief = buildFindBrief(shared, unit, pass);
    f.realBriefs.set(brief.text, { unit, pass });
    return brief;
  };
  f.args.verifyBrief = (batch) => {
    const brief = buildVerifyBrief(shared, batch);
    f.realBriefs.set(brief.text, { batch });
    return brief;
  };
  const r = await runStagedReview(f.args);
  expect(r.missing).toEqual([]);
  expect(r.report.findings).toHaveLength(2);
});

// Additional failure cases: observations disappear below the findings'
// threshold, refuted duplicates lose provenance, a refusal restarts calls.
it("shows observations below the findings' severity threshold", async () => {
  const f = setup((answer) => { if (answer.version === "verify-1") answer.verdicts.forEach((v) => { v.severity = "nitpick"; v.tier = "observation"; }); return answer; });
  f.config.severityThreshold = "major";
  const r = await runStagedReview(f.args);
  expect(r.report.observations).toHaveLength(2);
  expect(r.report.below_threshold).toBe(0);
  expect(r.submission.findings).toEqual([]);
});
it("rejects refuted duplicates before accepting a corrected verdict", async () => {
  const f = setup((answer, _request, brief) => {
    if (answer.version === "find-1") answer.candidates = [candidate(brief.unit!.files[0]!, brief.pass === "local" ? "First claim" : "Second claim")];
    if (answer.version === "verify-1" && _request.purpose === "verify") { answer.verdicts[1]!.verdict = "refuted"; answer.verdicts[1]!.duplicate_of = answer.verdicts[0]!.id; }
    return answer;
  });
  const r = await runStagedReview(f.args);
  expect(r.rounds.some((round) => round.errors.some((e) => e.includes("both candidates must be confirmed")))).toBe(true);
  expect(r.report.findings.every((f) => f.found_by === undefined)).toBe(true);
});
it("makes no new calls after a budget refusal and keeps it in missing work", async () => {
  const f = setup(undefined, ["a.txt", "b.txt", "c.txt", "d.txt"]);
  f.refuse();
  const r = await runStagedReview(f.args);
  expect(r.usage.calls.some((c) => c.outcome === "refused")).toBe(true);
  expect(r.sessions.some((s) => s.role.endsWith("retry1"))).toBe(false);
  expect(r.missing.join(" ")).toContain("budget refused");
  expect(f.requests.some((r) => r.purpose === "verify")).toBe(false);
});

// A host write failure must stop the run, rather than becoming a retry.
it("propagates a failed started-event writer and closes every session", async () => {
  const f = setup();
  f.args.onStarted = (role) => { if (role === "finder:u2:contracts") throw new Error("host writer failed"); };
  await expect(runStagedReview(f.args)).rejects.toThrow("host writer failed");
  expect(f.closed.size).toBe(f.opened.length);
  expect(f.opened).toHaveLength(4);
});

it("drops one unmatched evidence candidate and keeps the other with a complete review", async () => {
  const f = setup((answer) => {
    if (answer.version === "find-1" && answer.candidates.length) answer.candidates.push({ ...candidate(answer.candidates[0]!.file_path, "Unproved defect"), evidence: [{ file_path: answer.candidates[0]!.file_path, line_number: 1, quote: "invented" }] });
    return answer;
  }, ["a.txt"]);
  const r = await runStagedReview(f.args);
  expect(r.report.findings).toHaveLength(1);
  expect(r.missing).toEqual([]);
  expect(completion(r, f).status).toBe("complete");
  expect(r.sessions[0]!.dropped).toContainEqual(expect.objectContaining({ title: "Unproved defect", line_number: 1, reason: "evidence not found" }));
  expect(r.report.low_confidence).toContainEqual(expect.objectContaining({ title: "Unproved defect", reason: "evidence not found" }));
});
it("reviews a 130 KB indivisible hunk completely and records its size as a note", async () => {
  const f = setup(undefined, ["a.txt"]);
  f.change.diffs![0]!.text += "x".repeat(130 * 1024);
  const r = await runStagedReview(f.args);
  expect(completion(r, f).status).toBe("complete");
  expect(r.report.notes!.join(" ")).toContain("bytes of diff in an indivisible hunk");
});
it("keeps a candidate with an unknown lens without failing its verifier batch", async () => {
  const f = setup((answer) => { if (answer.version === "find-1") answer.candidates.forEach((c) => { c.lens = "unknown"; }); return answer; }, ["a.txt"]);
  const r = await runStagedReview(f.args);
  expect(r.report.findings).toHaveLength(1);
  expect(r.submission.findings[0]!.source).toBeNull();
  expect(r.missing).toEqual([]);
});
it("batches a scanner and finder on the same line together among more than six candidates", async () => {
  const f = setup((answer) => {
    if (answer.version === "find-1" && answer.candidates.length) answer.candidates = Array.from({ length: 7 }, (_, i) => ({ ...candidate("a.txt", `Defect ${i}`), line_number: i + 1 }));
    return answer;
  }, ["a.txt"]);
  f.scan.candidates.push(scanner("a.txt"));
  await runStagedReview(f.args);
  const batch = f.requests.filter((r) => r.purpose === "verify").map((r) => JSON.parse(r.messages[1]!.text).batch as VerifyBatch).find((b) => b.candidates.some((c) => c.id === "c1"))!;
  expect(batch.candidates.map((c) => c.id)).toEqual(expect.arrayContaining(["c1", "k1"]));
});
it("preserves a good item in the same batch when another item exhausts prose corrections", async () => {
  const f = setup((answer) => {
    if (answer.version === "find-1" && answer.candidates.length) answer.candidates.push(candidate("a.txt", "Another defect"));
    if (answer.version === "verify-1") answer.verdicts[0]!.problem = "";
    return answer;
  }, ["a.txt"]);
  const r = await runStagedReview(f.args);
  expect(r.report.findings.map((f) => f.title)).toEqual(["Another defect"]);
  expect(r.report.low_confidence[0]!.reason).toBe("unresolved by the verifier");
});

// Failure cases: accepted sessions accumulate, assembly errors expose array
// offsets, and completion order decides candidate ids.
it("closes an accepted verifier before opening its fresh assembly correction", async () => {
  let corrected = false;
  const f = setup((answer, request) => {
    if (answer.version === "verify-1") {
      answer.verdicts.forEach((v) => { v.verdict = "refuted"; });
      if (!request.callId.includes(":assembly")) answer.verdicts.find((v) => v.id === "c1")!.reason = "word ".repeat(30);
      else {
        corrected = true;
        expect(f.closed.size).toBe(f.opened.length - 1);
        expect(request.messages[1]!.text).toContain("candidate c1");
        expect(request.messages[1]!.text).not.toContain("dropped[0]");
        expect(request.messages[1]!.text).toContain("Previous answer:");
      }
    }
    return answer;
  }, ["a.txt"]);
  f.scan.candidates.push(scanner("a.txt"));
  const r = await runStagedReview(f.args);
  expect(corrected).toBe(true);
  expect(r.missing).toEqual([]);
  expect(new Set(r.usage.calls.map((call) => call.callId)).size).toBe(r.usage.calls.length);
  expect(f.closed.size).toBe(f.opened.length);
});
it("drops only the offending scanner when its assembly corrections are exhausted", async () => {
  const f = setup((answer) => {
    if (answer.version === "verify-1") {
      const scanner = answer.verdicts.find((v) => v.id === "c1")!;
      scanner.verdict = "refuted";
      scanner.reason = "word ".repeat(30);
    }
    return answer;
  }, ["a.txt"]);
  f.scan.candidates.push(scanner("a.txt"));
  const r = await runStagedReview(f.args);
  expect(r.report.findings).toHaveLength(1);
  expect(r.report.not_reviewed.map((c) => c.id)).toEqual(["c1"]);
  expect(r.missing.join(" ")).toContain("candidates c1 were not verified");
});
it("keeps candidate ids and session records stable when finders finish in reverse order", async () => {
  const run = async (reverse: boolean) => {
    const f = setup(async (answer, _request, brief) => {
      if (brief.unit) await new Promise((resolve) => setTimeout(resolve, reverse ? 6 - Number(brief.unit.id.slice(1)) : Number(brief.unit.id.slice(1))));
      return answer;
    }, ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"]);
    const r = await runStagedReview(f.args);
    return { roles: r.sessions.map((s) => s.role), candidates: f.requests.filter((r) => r.purpose === "verify").flatMap((r) => (JSON.parse(r.messages[1]!.text).batch as VerifyBatch).candidates.map((c) => [c.id, c.kind === "finder" ? c.candidate.file_path : c.candidate.filePath])) };
  };
  expect(await run(true)).toEqual(await run(false));
});
