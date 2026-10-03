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
import { describe, expect, it } from "vitest";
import { finalizeReview } from "./finalize.js";
import { checkPush } from "./push-gate.js";
import { makeChange, makeConfig, makeManifest, makeScan, makeSubmission } from "./test-fixtures.js";
import type { Latest, Report } from "./types.js";

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

describe("checkPush", () => {
  it("abstains with the counts and report path for a reviewed change in warn mode", () => {
    const { latest, report } = reviewed(null);
    const d = checkPush({ currentChangeId: change.id, latest, report, config: makeConfig() });
    expect(d.decision).toBe("abstain");
    expect(d.message).toBe("OpenQodex review of this change: 1 critical, 1 nitpick. Report: .openqodex/reviews/x/report.md");
  });

  it("abstains with no message for a reviewed change with nothing found", () => {
    const { latest, report } = reviewed(null);
    const empty = { ...report, findings: [], not_reviewed: [] };
    expect(checkPush({ currentChangeId: change.id, latest, report: empty, config: makeConfig() })).toEqual({
      decision: "abstain",
      message: null,
    });
  });

  it("abstains and gives the one step when the change was not reviewed", () => {
    const d = checkPush({ currentChangeId: change.id, latest: null, report: null, config: makeConfig() });
    expect(d.decision).toBe("abstain");
    expect(d.message).toContain("has not reviewed this change");
    expect(d.message).toContain("review my change with openqodex");
    expect(d.message).toContain("review my change with openqodex");
  });

  it("does not count a review of an earlier version, a scan, or an unfinalized review", () => {
    const { latest, report } = reviewed(null);
    const cases: Latest[] = [
      { ...latest, change_id: "0".repeat(64) },
      { ...latest, kind: "scan" },
      { ...latest, finalized: false },
    ];
    for (const l of cases) {
      const d = checkPush({ currentChangeId: change.id, latest: l, report, config: makeConfig({ blockOnSeverity: "critical" }) });
      expect(d.decision).toBe("deny");
      expect(d.message).toContain("has not reviewed this change");
    }
    const moved = checkPush({ currentChangeId: change.id, latest: cases[0] ?? null, report, config: makeConfig() });
    expect(moved.message).toContain("the last review was of an earlier version");
  });

  it("denies a blocked review when block_on_severity is set, and says what to run", () => {
    const { latest, report } = reviewed("critical");
    expect(report.verdict).toBe("blocked");
    const d = checkPush({ currentChangeId: change.id, latest, report, config: makeConfig({ blockOnSeverity: "critical" }) });
    expect(d.decision).toBe("deny");
    expect(d.message).toContain("at or above critical");
    expect(d.message).toContain("review my change with openqodex");
  });

  it("abstains on a passing review of this change when block_on_severity is set", () => {
    const { latest, report } = reviewed(null);
    const d = checkPush({
      currentChangeId: change.id,
      latest: { ...latest, verdict: "passed" },
      // Judged under the same threshold the config sets now.
      report: { ...report, block_on_severity: "critical" },
      config: makeConfig({ blockOnSeverity: "critical" }),
    });
    expect(d.decision).toBe("abstain");
  });

  it("never allows", () => {
    const { latest, report } = reviewed(null);
    for (const blockOn of [null, "critical"] as const) {
      for (const l of [null, latest, { ...latest, verdict: "blocked" as const }]) {
        const d = checkPush({ currentChangeId: change.id, latest: l, report, config: makeConfig({ blockOnSeverity: blockOn }) });
        expect(["abstain", "deny"]).toContain(d.decision);
      }
    }
  });

  it("denies a passing review made before block_on_severity was set", () => {
    const { latest, report } = reviewed(null);
    const d = checkPush({ currentChangeId: change.id, latest, report, config: makeConfig({ blockOnSeverity: "critical" }) });
    expect(d.decision).toBe("deny");
    expect(d.message).toContain("under the current block_on_severity");
  });
});
