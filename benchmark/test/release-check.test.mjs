// How the release check (benchmark/release-check.mjs) reads a review
// comparison: loop/compare.mjs's result on two sides of reviews, and the
// verdict and exit code the check takes from it. The sides are data, as in
// decide.test.mjs; compare.mjs runs for real.
//
// Failure list, written before the code:
// 1. A gate metric one side measures and the other does not (the
//    candidate's reviews report no cost) reads as no change, and the check
//    exits 0 on a comparison it could not make.
// 2. A loss the comparison shows is hidden behind such a metric: the check
//    reports "could not run" when it can name a loss.
import { describe, expect, it } from "vitest";
import { GATE_METRICS, comparePairs, makeSide } from "../loop/compare.mjs";
import { decideVerdict, reviewOutcome } from "../release-check.mjs";

const ALPHA = 0.05 / (2 * GATE_METRICS.length);

// One review of one case with one minor bug: found or not, at a cost (null
// when the review reported none).
function review({ caseId, repeat, config, found, cost }) {
  const hits = found ? [{ outcome: "hit", bug: "b1", severity: "minor", severityAgreement: "exact" }] : [];
  return {
    jobId: `${caseId}/${config}/${repeat}`,
    caseId,
    case: caseId,
    config,
    repeat,
    origin: "planted",
    clean: false,
    status: "complete",
    bugs: [{ id: "b1", severity: "minor", found }],
    findings: hits,
    issueRecall: { all: { hit: hits.length, of: 1 }, criticalMajor: { hit: 0, of: 0 } },
    precision: { correct: hits.length, unresolved: 0, of: hits.length },
    issues: { correct: hits.length, unresolved: 0, of: hits.length },
    costUsd: cost,
    wallMs: 30_000,
    budgetRefused: false,
    undeliveredComplete: false,
  };
}

function side({ runId, found, cost }) {
  const config = "model:scripted-graph-on";
  const jobs = [];
  for (let r = 1; r <= 3; r++) for (let c = 0; c < 12; c++) jobs.push(review({ caseId: `planted/case-${String(c).padStart(2, "0")}@00000000`, repeat: r, config, found: found(c), cost }));
  return makeSide({ runId, path: "server", reviewer: "model:scripted", model: "model:scripted", config, rules: { version: 7, hash: "r".repeat(64) }, jobs });
}

const outcomeOf = (base, candidate) => {
  const result = comparePairs([{ parent: base, candidate }], { alpha: ALPHA, seed: "release-check-test" });
  expect(result.problems).toEqual([]);
  return reviewOutcome(result, { suite: "planted", alpha: ALPHA });
};

describe("a gate metric one side measures and the other does not", () => {
  it("is named as not comparable, and the check exits 2 instead of reading no change", () => {
    const o = outcomeOf(side({ runId: "base", found: () => true, cost: 0.1 }), side({ runId: "candidate", found: () => true, cost: null }));
    expect(o.incomparable).toEqual([expect.stringMatching(/cost per review/)]);
    expect(o.losses).toEqual([]);
    expect(decideVerdict(o)).toEqual({ verdict: "could not run", code: 2, why: expect.stringMatching(/cost per review/) });
  });

  it("does not hide a loss the comparison shows: the check exits 1 and names the metric it could not compare", () => {
    const o = outcomeOf(side({ runId: "base", found: () => true, cost: 0.1 }), side({ runId: "candidate", found: () => false, cost: null }));
    expect(o.losses.join("\n")).toMatch(/issue recall/);
    // A candidate with no finding has no precision either.
    expect(o.incomparable).toEqual(expect.arrayContaining([expect.stringMatching(/cost per review/), expect.stringMatching(/displayed precision/)]));
    expect(decideVerdict(o)).toMatchObject({ verdict: "loss", code: 1 });
  });

  it("reads two sides that measure the same metrics alike as no change", () => {
    const o = outcomeOf(side({ runId: "base", found: () => true, cost: 0.1 }), side({ runId: "candidate", found: () => true, cost: 0.1 }));
    expect(o.incomparable).toEqual([]);
    expect(decideVerdict(o)).toMatchObject({ verdict: "no change", code: 0 });
  });
});
