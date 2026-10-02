// Ways finalize could fail, written before the code:
// 1. A submission that breaks the schema (wrong version, a bad severity, a
//    missing title, confidence above 1, line_end before line_number) still
//    produces a report instead of throwing with the field's path.
// 2. A submission for an older change, or a manifest from another run, is
//    accepted.
// 3. A source that is not a token in this scan or a selected lens is kept or
//    silently set to null instead of rejected.
// 4. A candidate id that is not in the scan, or whose token differs from the
//    finding's source, is accepted.
// 5. A dropped entry naming an unknown candidate, or a candidate both raised
//    and dropped, is accepted.
// 6. A finding under 0.7, or under its lens's floor, reaches the findings.
// 7. A finding on a file outside the change, or on lines the change did not
//    add or modify, counts toward the verdict.
// 8. A disabled rule still shows, as a finding or as a not-reviewed candidate.
// 9. Two findings on the same file, line and category both show, or the
//    lower severity wins.
// 10. A secret the agent quotes reaches the report.
// 11. A candidate neither raised nor dropped is lost instead of listed as
//     not reviewed, or a dropped one is listed as not reviewed.
// 12. The verdict blocks without block_on_severity, misses a not-reviewed
//     candidate at the threshold, or blocks on something below it.
// 13. scanReport maps categories or severities wrongly, or ignores the
//     threshold.
import { describe, expect, it } from "vitest";
import { finalizeReview, scanReport } from "./finalize.js";
import { matchesGlob } from "./glob.js";
import {
  KEY_CANDIDATE,
  LINT_CANDIDATE,
  SECRET,
  SQL_CANDIDATE,
  finding,
  makeChange,
  makeConfig,
  makeManifest,
  makeScan,
  makeSubmission,
} from "./test-fixtures.js";
import { OpenQodexError } from "./types.js";
import type { Config } from "./types.js";

// matchesGlob belongs to another stream; the disabled_rules tests run once it
// is merged.
const globBuilt = (() => {
  try {
    return matchesGlob("a", "a");
  } catch {
    return false;
  }
})();

function run(submission: unknown, over: { config?: Partial<Config> } = {}) {
  const change = makeChange();
  return finalizeReview({
    change,
    scan: makeScan(),
    manifest: makeManifest(change),
    config: makeConfig(over.config),
    submission,
  });
}

function expectThrow(submission: unknown, message: RegExp) {
  let caught: unknown;
  try {
    run(submission);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(OpenQodexError);
  expect((caught as Error).message).toMatch(message);
}

describe("finalizeReview: schema", () => {
  it("accepts a valid submission", () => {
    const report = run(makeSubmission());
    expect(report.kind).toBe("review");
    expect(report.findings).toHaveLength(1);
  });

  it("rejects a wrong version", () => {
    expectThrow(makeSubmission({ version: 2 }), /invalid at version/);
  });

  it("rejects a non-object", () => {
    expectThrow("not json", /invalid at the top level/);
  });

  it("rejects a bad severity and names the path", () => {
    expectThrow(makeSubmission({ findings: [finding({ severity: "high" })] }), /findings\[0\]\.severity/);
  });

  it("rejects a missing title", () => {
    expectThrow(makeSubmission({ findings: [finding({ title: undefined })] }), /findings\[0\]\.title/);
  });

  it("rejects confidence above 1", () => {
    expectThrow(makeSubmission({ findings: [finding({ confidence: 1.5 })] }), /findings\[0\]\.confidence/);
  });

  it("rejects line_end before line_number", () => {
    expectThrow(makeSubmission({ findings: [finding({ line_number: 15, line_end: 14 })] }), /findings\[0\]\.line_end/);
  });

  it("rejects a dropped entry without a reason", () => {
    expectThrow(makeSubmission({ dropped: [{ candidate: "c2" }] }), /dropped\[0\]\.reason/);
  });
});

describe("finalizeReview: change binding", () => {
  it("accepts the full change id as well as the short one", () => {
    expect(run(makeSubmission({ change_id: makeChange().id })).verdict).toBe("passed");
  });

  it("rejects a submission for another change", () => {
    expectThrow(makeSubmission({ change_id: "aaaaaaaaaaaa" }), /the change moved since the brief; run openqodex review again/);
  });

  it("rejects a manifest from another change", () => {
    const change = makeChange();
    expect(() =>
      finalizeReview({
        change,
        scan: makeScan(),
        manifest: makeManifest(change, { change_id: "bbbbbbbbbbbb" }),
        config: makeConfig(),
        submission: makeSubmission(),
      }),
    ).toThrow(/the change moved/);
  });
});

describe("finalizeReview: citations", () => {
  it("rejects a source that is not in this scan", () => {
    expectThrow(
      makeSubmission({ findings: [finding({ source: "semgrep:made.up.rule", candidate: null })] }),
      /finding 0 .* cites source "semgrep:made.up.rule"/,
    );
  });

  it("rejects a lens that was not selected", () => {
    expectThrow(
      makeSubmission({ findings: [finding({ source: "lens:eval-on-user-input", candidate: null })] }),
      /finding 0 .* cites source "lens:eval-on-user-input"/,
    );
  });

  it("accepts a selected lens and a null source", () => {
    const report = run(
      makeSubmission({
        findings: [
          finding({ source: "lens:sql-string-concatenation", candidate: null }),
          finding({ source: null, candidate: null, category: "bug", line_number: 15, line_end: 15 }),
        ],
        dropped: [],
      }),
    );
    expect(report.findings.map((f) => f.source)).toEqual(["lens:sql-string-concatenation", null]);
  });

  it("rejects a candidate id that is not in this scan", () => {
    expectThrow(makeSubmission({ findings: [finding({ candidate: "c9" })] }), /finding 0 .* raises candidate "c9"/);
  });

  it("rejects a candidate whose token differs from the source", () => {
    expectThrow(
      makeSubmission({ findings: [finding({ candidate: "c2" })], dropped: [] }),
      /raises candidate c2, whose token is "gitleaks:generic-api-key"/,
    );
  });

  it("rejects a dropped entry naming an unknown candidate", () => {
    expectThrow(makeSubmission({ dropped: [{ candidate: "c7", reason: "x" }] }), /dropped\[0\] names candidate "c7"/);
  });

  it("rejects a candidate that is both raised and dropped", () => {
    expectThrow(
      makeSubmission({ dropped: [{ candidate: "c1", reason: "x" }] }),
      /candidate c1 is both raised by finding 0 and listed in dropped\[0\]/,
    );
  });
});

describe("finalizeReview: filters", () => {
  it("moves a finding under 0.7 to low_confidence", () => {
    const report = run(makeSubmission({ findings: [finding({ confidence: 0.65 })] }));
    expect(report.findings).toEqual([]);
    expect(report.low_confidence).toEqual([
      { title: "SQL built from request input", file_path: "app/search.py", confidence: 0.65, floor: 0.7 },
    ]);
  });

  it("applies a lens floor above 0.7", () => {
    const report = run(
      makeSubmission({ findings: [finding({ source: "lens:sql-string-concatenation", candidate: null, confidence: 0.72 })] }),
    );
    expect(report.findings).toEqual([]);
    expect(report.low_confidence[0]?.floor).toBe(0.75);
  });

  it("moves a finding on a file outside the change to outside_change and does not count it", () => {
    const report = run(
      makeSubmission({ findings: [finding({ file_path: "app/other.py", source: null, candidate: null })] }),
      { config: { blockOnSeverity: "critical" } },
    );
    expect(report.findings).toEqual([]);
    expect(report.outside_change).toHaveLength(1);
    expect(report.outside_change[0]?.notes).toEqual(["the file is not in this change"]);
    expect(report.verdict).toBe("passed");
  });

  it("moves a finding on unchanged lines to outside_change", () => {
    const report = run(makeSubmission({ findings: [finding({ line_number: 20, line_end: 22, source: null, candidate: null })] }));
    expect(report.outside_change[0]?.notes).toEqual(["lines 20 to 22 are not a line this change added or modified"]);
  });

  it("keeps a finding whose range reaches a changed line", () => {
    const report = run(makeSubmission({ findings: [finding({ line_number: 10, line_end: 14 })] }));
    expect(report.findings).toHaveLength(1);
  });

  it("dedups by file, line and category keeping the highest severity", () => {
    const report = run(
      makeSubmission({
        findings: [
          finding({ severity: "minor", source: null, candidate: null }),
          finding({ severity: "critical", source: null, candidate: null, title: "Worse" }),
          finding({ severity: "minor", source: null, candidate: null, category: "bug" }),
        ],
      }),
    );
    expect(report.findings.map((f) => [f.category, f.severity, f.title])).toEqual([
      ["security", "critical", "Worse"],
      ["bug", "minor", "SQL built from request input"],
    ]);
  });

  it("redacts a secret the agent quotes, by fingerprint", () => {
    const report = run(
      makeSubmission({
        summary: `Adds ${SECRET} to settings.`,
        findings: [
          finding({
            source: null,
            candidate: null,
            file_path: "app/settings.py",
            line_number: 3,
            line_end: 3,
            title: `Hard-coded key ${SECRET}`,
            description: `The key ${SECRET} is committed.`,
            suggested_change: `API_KEY = os.environ["API_KEY"]  # was ${SECRET}`,
          }),
        ],
        dropped: [{ candidate: "c2", reason: `the value ${SECRET} is a sample` }],
      }),
    );
    expect(JSON.stringify(report)).not.toContain(SECRET);
    expect(report.findings[0]?.description).toBe("The key [redacted] is committed.");
  });
});

describe.skipIf(!globBuilt)("finalizeReview: disabled_rules (needs matchesGlob)", () => {
  it("drops findings and candidates whose source matches a disabled glob", () => {
    const report = run(makeSubmission({ dropped: [] }), { config: { disabledRules: ["semgrep:*", "gitleaks:generic-api-key"] } });
    expect(report.findings).toEqual([]);
    expect(report.not_reviewed.map((c) => c.id)).toEqual(["c3"]);
  });

  it("drops lens findings by a lens glob", () => {
    const report = run(
      makeSubmission({ findings: [finding({ source: "lens:sql-string-concatenation", candidate: null })] }),
      { config: { disabledRules: ["lens:sql-*"] } },
    );
    expect(report.findings).toEqual([]);
  });
});

describe("finalizeReview: candidates and verdict", () => {
  it("lists candidates neither raised nor dropped as not reviewed, and dropped ones with their reason", () => {
    const report = run(makeSubmission());
    expect(report.not_reviewed.map((c) => c.id)).toEqual(["c3"]);
    expect(report.dropped.map((d) => [d.candidate.id, d.reason])).toEqual([["c2", "a sample key in a local settings file"]]);
  });

  it("passes without block_on_severity whatever it finds", () => {
    const report = run(makeSubmission({ dropped: [] }));
    expect(report.not_reviewed.map((c) => c.id)).toEqual(["c2", "c3"]);
    expect(report.verdict).toBe("passed");
  });

  it("blocks on a finding at the threshold", () => {
    expect(run(makeSubmission(), { config: { blockOnSeverity: "critical" } }).verdict).toBe("blocked");
  });

  it("blocks on a not-reviewed candidate at the threshold", () => {
    const report = run(makeSubmission({ findings: [], dropped: [{ candidate: "c1", reason: "parameterised upstream" }] }), {
      config: { blockOnSeverity: "critical" },
    });
    expect(report.not_reviewed.map((c) => c.id)).toEqual(["c2", "c3"]);
    expect(report.verdict).toBe("blocked");
  });

  it("passes when everything counted is below the threshold", () => {
    const report = run(makeSubmission({ findings: [finding({ severity: "minor" })] }), {
      config: { blockOnSeverity: "major" },
    });
    expect(report.verdict).toBe("passed");
  });
});

describe("scanReport", () => {
  it("turns every candidate into a scanner finding with the mapped category", () => {
    const report = scanReport({ change: makeChange(), scan: makeScan(), config: makeConfig() });
    expect(report.kind).toBe("scan");
    expect(report.findings.map((f) => [f.source, f.severity, f.category, f.title, f.origin])).toEqual([
      [SQL_CANDIDATE.token, "major", "security", SQL_CANDIDATE.ruleId, "scanner"],
      [KEY_CANDIDATE.token, "critical", "security", "generic-api-key", "scanner"],
      [LINT_CANDIDATE.token, "nitpick", "maintainability", "F401", "scanner"],
    ]);
    expect(report.verdict).toBe("passed");
  });

  it("maps a custom scanner to security", () => {
    const custom = { ...LINT_CANDIDATE, source: "custom:trivy" as const, token: "custom:trivy:DS002", ruleId: "DS002" };
    const report = scanReport({ change: makeChange(), scan: makeScan({ candidates: [custom] }), config: makeConfig() });
    expect(report.findings[0]?.category).toBe("security");
  });

  it("blocks at the threshold and passes below it", () => {
    const blocked = scanReport({ change: makeChange(), scan: makeScan(), config: makeConfig({ blockOnSeverity: "critical" }) });
    expect(blocked.verdict).toBe("blocked");
    const passed = scanReport({
      change: makeChange(),
      scan: makeScan({ candidates: [LINT_CANDIDATE] }),
      config: makeConfig({ blockOnSeverity: "minor" }),
    });
    expect(passed.verdict).toBe("passed");
  });
});
