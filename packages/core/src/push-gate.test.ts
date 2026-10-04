// Ways the push gate could fail, written before the code:
// 1. It ever returns "allow".
// 2. With no block_on_severity it denies, or stays silent about an
//    unreviewed change.
// 3. It treats a review of an earlier version of the change as a review of
//    this change.
// 4. With block_on_severity set it lets a blocked or missing review through
//    without denying, or denies a passing review of this change.
// 5. Its message does not say what to run.
// 6. A review judged with no threshold, or another one, passes a push after
//    block_on_severity is set (the config is outside the change id).
// 7. An incomplete record blocks a push, even with block_on_severity set.
// 8. A legacy receipt (the old two-step protocol) counts as a complete
//    record, or suddenly blocks a push the old version let through.
// 9. A complete passing review of this change is not silent.
import { describe, expect, it } from "vitest";
import { finalizeReview } from "./finalize.js";
import { checkPush, gateReceipt } from "./push-gate.js";
import { makeChange, makeConfig, makeManifest, makeScan, makeSubmission } from "./test-fixtures.js";
import type { GateReceipt } from "./push-gate.js";
import type { Report } from "./types.js";

const change = makeChange();

const DIR = ".openqodex/reviews/x";

function judged(blockOn: "critical" | null): Report {
  return finalizeReview({
    change,
    scan: makeScan(),
    manifest: makeManifest(change),
    config: makeConfig({ blockOnSeverity: blockOn }),
    submission: makeSubmission(),
  });
}

const complete = (blockOn: "critical" | null): GateReceipt => gateReceipt(judged(blockOn), "complete", DIR);
const legacy = (blockOn: "critical" | null): GateReceipt => gateReceipt(judged(blockOn), "legacy", DIR);
function incomplete(): GateReceipt {
  const report: Report = { ...judged(null), verdict: "incomplete", findings: [], completion: { status: "incomplete", missing: ["the reviewer timed out and was stopped"] } as unknown as Report["completion"] };
  return gateReceipt(report, "incomplete", DIR);
}

describe("checkPush", () => {
  it("9. is silent for a complete passing review of this change", () => {
    expect(checkPush({ currentChangeId: change.id, receipt: complete(null), config: makeConfig() })).toEqual({ decision: "abstain", message: null });
  });

  it("2, 5. abstains with one line asking for openqodex review when the change was not reviewed", () => {
    const d = checkPush({ currentChangeId: change.id, receipt: null, config: makeConfig() });
    expect(d.decision).toBe("abstain");
    expect(d.message).toContain("has not reviewed this change");
    expect(d.message).toContain("openqodex review");
    expect(d.message?.split("\n")).toHaveLength(1);
  });

  it("3. does not count a review of an earlier version", () => {
    const earlier = { ...complete(null), change_id: "0".repeat(64) };
    const d = checkPush({ currentChangeId: change.id, receipt: earlier, config: makeConfig({ blockOnSeverity: "critical" }) });
    expect(d.decision).toBe("deny");
    expect(d.message).toContain("has not reviewed this change");
    const moved = checkPush({ currentChangeId: change.id, receipt: earlier, config: makeConfig() });
    expect(moved.message).toContain("the last review was of an earlier version");
  });

  it("4, 5. denies a complete blocked review when block_on_severity is set, and says what to run", () => {
    const r = complete("critical");
    expect(r.verdict).toBe("blocked");
    const d = checkPush({ currentChangeId: change.id, receipt: r, config: makeConfig({ blockOnSeverity: "critical" }) });
    expect(d.decision).toBe("deny");
    expect(d.message).toContain("at or above critical");
    expect(d.message).toContain(`${DIR}/report.md`);
    expect(d.message).toContain("openqodex review");
  });

  it("4. abstains on a complete passing review of this change when block_on_severity is set", () => {
    const r = { ...complete(null), verdict: "passed" as const, block_on_severity: "critical" as const };
    expect(checkPush({ currentChangeId: change.id, receipt: r, config: makeConfig({ blockOnSeverity: "critical" }) })).toEqual({ decision: "abstain", message: null });
  });

  it("7. an incomplete record of this change never blocks, and says the review did not finish", () => {
    for (const blockOn of [null, "critical"] as const) {
      const d = checkPush({ currentChangeId: change.id, receipt: incomplete(), config: makeConfig({ blockOnSeverity: blockOn }) });
      expect(d.decision).toBe("abstain");
      expect(d.message).toContain("incomplete");
      expect(d.message).toContain("the reviewer timed out");
      expect(d.message).toContain("openqodex review");
    }
  });

  it("8. a legacy receipt counts as reviewed, names the reviewing agent, and blocks only a blocked verdict", () => {
    const passing = { ...legacy(null), verdict: "passed" as const, block_on_severity: "critical" as const };
    const d = checkPush({ currentChangeId: change.id, receipt: passing, config: makeConfig({ blockOnSeverity: "critical" }) });
    expect(d.decision).toBe("abstain");
    expect(d.message).toContain("reviewed by the coding agent you are using");
    const b = checkPush({ currentChangeId: change.id, receipt: legacy("critical"), config: makeConfig({ blockOnSeverity: "critical" }) });
    expect(b.decision).toBe("deny");
    expect(b.message).toContain("reviewed by the coding agent you are using");
  });

  it("1. never allows", () => {
    for (const r of [legacy(null), complete(null), complete("critical"), incomplete(), null]) {
      for (const blockOn of [null, "critical"] as const) {
        const d = checkPush({ currentChangeId: change.id, receipt: r, config: makeConfig({ blockOnSeverity: blockOn }) });
        expect(["abstain", "deny"]).toContain(d.decision);
      }
    }
  });

  it("6. denies a passing review made before block_on_severity was set", () => {
    const d = checkPush({ currentChangeId: change.id, receipt: complete(null), config: makeConfig({ blockOnSeverity: "critical" }) });
    expect(d.decision).toBe("deny");
    expect(d.message).toContain("under the current block_on_severity");
  });
});
