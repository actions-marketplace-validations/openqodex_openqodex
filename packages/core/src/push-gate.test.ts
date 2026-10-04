// Ways the push gate could fail, written before the code:
// 1. It ever returns "allow".
// 2. With no block_on_severity it denies, or stays silent about an
//    unreviewed change.
// 3. It treats a review of an earlier version of the change, a scan, or an
//    unfinalized review as a review of this change.
// 4. With block_on_severity set it lets a blocked or missing review through
//    without denying, or denies a passing review of this change.
// 5. Its message does not say what to run.
// 6. A review judged with no threshold, or another one, passes a push after
//    block_on_severity is set (the config is outside the change id).
// 7. An incomplete record blocks a push, even with block_on_severity set.
// 8. A legacy receipt (the old two-step protocol) counts as a complete,
//    independent review, or suddenly blocks a push the old version let through.
// 9. A complete passing review of this change is not silent.
import { describe, expect, it } from "vitest";
import { finalizeReview } from "./finalize.js";
import { checkPush } from "./push-gate.js";
import { makeChange, makeConfig, makeManifest, makeScan, makeSubmission } from "./test-fixtures.js";
import type { CompletionRecord, Latest, Report } from "./types.js";

const change = makeChange();

function reviewed(blockOn: "critical" | null): { latest: Latest; report: Report } {
  const report = finalizeReview({
    change,
    scan: makeScan(),
    manifest: makeManifest(change),
    config: makeConfig({ blockOnSeverity: blockOn }),
    submission: makeSubmission(),
  });
  return {
    report,
    latest: { dir: ".openqodex/reviews/x", change_id: change.id, kind: "review", finalized: true, verdict: report.verdict },
  };
}

// The same review as a complete record: what `review` writes when its own
// reviewer process answered and every check passed.
function complete(blockOn: "critical" | null): { latest: Latest; report: Report } {
  const { latest, report } = reviewed(blockOn);
  const completion = { status: "complete", missing: [] } as unknown as CompletionRecord;
  return { latest: { ...latest, completion: "complete" }, report: { ...report, completion } };
}

function incomplete(): { latest: Latest; report: Report } {
  const { latest, report } = reviewed(null);
  const completion = { status: "incomplete", missing: ["the reviewer timed out and was stopped"] } as unknown as CompletionRecord;
  return { latest: { ...latest, finalized: false, verdict: null, completion: "incomplete" }, report: { ...report, verdict: "incomplete", findings: [], completion } };
}

describe("checkPush", () => {
  it("9. is silent for a complete passing review of this change", () => {
    const { latest, report } = complete(null);
    expect(checkPush({ currentChangeId: change.id, latest, report, config: makeConfig() })).toEqual({ decision: "abstain", message: null });
  });

  it("2, 5. abstains with one line asking for openqodex review when the change was not reviewed", () => {
    const d = checkPush({ currentChangeId: change.id, latest: null, report: null, config: makeConfig() });
    expect(d.decision).toBe("abstain");
    expect(d.message).toContain("has not reviewed this change");
    expect(d.message).toContain("openqodex review");
    expect(d.message?.split("\n")).toHaveLength(1);
  });

  it("3. does not count a review of an earlier version, a scan, or an unfinalized review", () => {
    const { latest, report } = complete(null);
    const cases: Latest[] = [
      { ...latest, change_id: "0".repeat(64) },
      { ...latest, kind: "scan" },
      { ...latest, finalized: false, completion: undefined },
    ];
    for (const l of cases) {
      const d = checkPush({ currentChangeId: change.id, latest: l, report, config: makeConfig({ blockOnSeverity: "critical" }) });
      expect(d.decision).toBe("deny");
      expect(d.message).toContain("has not reviewed this change");
    }
    const moved = checkPush({ currentChangeId: change.id, latest: cases[0] ?? null, report, config: makeConfig() });
    expect(moved.message).toContain("the last review was of an earlier version");
  });

  it("4, 5. denies a complete blocked review when block_on_severity is set, and says what to run", () => {
    const { latest, report } = complete("critical");
    expect(report.verdict).toBe("blocked");
    const d = checkPush({ currentChangeId: change.id, latest, report, config: makeConfig({ blockOnSeverity: "critical" }) });
    expect(d.decision).toBe("deny");
    expect(d.message).toContain("at or above critical");
    expect(d.message).toContain("openqodex review");
  });

  it("4. abstains on a complete passing review of this change when block_on_severity is set", () => {
    const { latest, report } = complete(null);
    const d = checkPush({
      currentChangeId: change.id,
      latest: { ...latest, verdict: "passed" },
      report: { ...report, block_on_severity: "critical" },
      config: makeConfig({ blockOnSeverity: "critical" }),
    });
    expect(d).toEqual({ decision: "abstain", message: null });
  });

  it("7. an incomplete record of this change never blocks, and says the review did not finish", () => {
    const { latest, report } = incomplete();
    for (const blockOn of [null, "critical"] as const) {
      const d = checkPush({ currentChangeId: change.id, latest, report, config: makeConfig({ blockOnSeverity: blockOn }) });
      expect(d.decision).toBe("abstain");
      expect(d.message).toContain("incomplete");
      expect(d.message).toContain("openqodex review");
    }
  });

  it("8. a legacy receipt counts as reviewed, says it was not an independent review, and blocks only a blocked verdict", () => {
    const passing = reviewed(null);
    const d = checkPush({ currentChangeId: change.id, latest: { ...passing.latest, verdict: "passed" }, report: { ...passing.report, block_on_severity: "critical" }, config: makeConfig({ blockOnSeverity: "critical" }) });
    expect(d.decision).toBe("abstain");
    expect(d.message).toContain("not an independent review");
    const blocked = reviewed("critical");
    const b = checkPush({ currentChangeId: change.id, latest: blocked.latest, report: blocked.report, config: makeConfig({ blockOnSeverity: "critical" }) });
    expect(b.decision).toBe("deny");
    expect(b.message).toContain("not an independent review");
  });

  it("1. never allows", () => {
    for (const r of [reviewed(null), complete(null), incomplete()]) {
      for (const blockOn of [null, "critical"] as const) {
        for (const l of [null, r.latest, { ...r.latest, verdict: "blocked" as const }]) {
          const d = checkPush({ currentChangeId: change.id, latest: l, report: r.report, config: makeConfig({ blockOnSeverity: blockOn }) });
          expect(["abstain", "deny"]).toContain(d.decision);
        }
      }
    }
  });

  it("6. denies a passing review made before block_on_severity was set", () => {
    const { latest, report } = complete(null);
    const d = checkPush({ currentChangeId: change.id, latest, report, config: makeConfig({ blockOnSeverity: "critical" }) });
    expect(d.decision).toBe("deny");
    expect(d.message).toContain("under the current block_on_severity");
  });
});
