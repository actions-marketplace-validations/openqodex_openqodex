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
// 14. review.severity_threshold hides a finding at or above
//     block_on_severity, so a blocked verdict names nothing; hides a
//     not-reviewed candidate; or loses count of what it hid.
import { describe, expect, it } from "vitest";
import { finalizeReview, scanReport } from "./finalize.js";
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

  it("dedups a repeated finding keeping the highest severity, and keeps another category", () => {
    const report = run(
      makeSubmission({
        findings: [
          finding({ severity: "minor", source: null, candidate: null }),
          finding({ severity: "critical", source: null, candidate: null, description: "Worse" }),
          finding({ severity: "minor", source: null, candidate: null, category: "bug" }),
        ],
      }),
    );
    expect(report.findings.map((f) => [f.category, f.severity, f.title])).toEqual([
      ["security", "critical", "SQL built from request input"],
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

describe("finalizeReview: disabled_rules", () => {
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

// Review round 1, each written to fail on the code before its fix:
// R1. An error message echoes a secret from the agent's title or source.
// R2. A secret survives in a field outside the cleaned list (a file path, a
//     scanner reason).
// R4. A huge line_end stalls finalize.
// R5. Two distinct problems on one line in one category collapse into one.
describe("finalizeReview: review round 1", () => {
  function message(submission: unknown): string {
    try {
      run(submission);
    } catch (err) {
      return (err as Error).message;
    }
    return "did not throw";
  }

  it("R1: redacts the agent's text in error messages", () => {
    const viaTitle = message(makeSubmission({ findings: [finding({ title: `key ${SECRET}`, source: "nope:x", candidate: null })] }));
    expect(viaTitle).toMatch(/cites source "nope:x"/);
    expect(viaTitle).not.toContain(SECRET);
    const viaSource = message(makeSubmission({ findings: [finding({ source: `x:${SECRET}`, candidate: null })] }));
    expect(viaSource).toMatch(/cites source/);
    expect(viaSource).not.toContain(SECRET);
    const viaCandidate = message(makeSubmission({ findings: [finding({ candidate: SECRET })] }));
    expect(viaCandidate).toMatch(/raises candidate/);
    expect(viaCandidate).not.toContain(SECRET);
    const viaDropped = message(makeSubmission({ dropped: [{ candidate: SECRET, reason: "x" }] }));
    expect(viaDropped).toMatch(/dropped\[0\]/);
    expect(viaDropped).not.toContain(SECRET);
  });

  it("R2: redacts every string in the report, file paths and scanner reasons included", () => {
    const change = makeChange();
    const scan = makeScan();
    const leakyScan = {
      ...scan,
      scanners: scan.scanners.map((s) => (s.scanner === "brakeman" ? { ...s, reason: `failed near ${SECRET}` } : s)),
    };
    const report = finalizeReview({
      change,
      scan: leakyScan,
      manifest: makeManifest(change),
      config: makeConfig(),
      submission: makeSubmission({
        findings: [
          finding({ source: null, candidate: null, file_path: `debug/${SECRET}.py` }),
          finding({ source: null, candidate: null, file_path: `low/${SECRET}.py`, confidence: 0.5 }),
        ],
      }),
    });
    expect(report.outside_change).toHaveLength(1);
    expect(report.low_confidence).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain(SECRET);
    const scanOnly = scanReport({ change, scan: leakyScan, config: makeConfig() });
    expect(JSON.stringify(scanOnly)).not.toContain(SECRET);
  });

  it("R4: a huge line_end is checked against coverage in bounded time", () => {
    const started = Date.now();
    const report = run(makeSubmission({ findings: [finding({ source: null, candidate: null, line_number: 16, line_end: 300_000_000 })] }));
    expect(Date.now() - started).toBeLessThan(200);
    expect(report.outside_change).toHaveLength(1);
    const reaching = run(makeSubmission({ findings: [finding({ line_number: 1, line_end: 300_000_000 })] }));
    expect(reaching.findings).toHaveLength(1);
  });

  it("R5: keeps distinct problems on one line, removes only true duplicates", () => {
    const report = run(
      makeSubmission({
        findings: [
          finding({}),
          finding({ source: null, candidate: null, title: "Hard-coded credential" }),
          finding({ source: null, candidate: null, title: "Hard-coded credential", severity: "major" }),
          finding({ severity: "major", title: "Same candidate again" }),
        ],
      }),
    );
    expect(report.findings.map((f) => [f.title, f.severity])).toEqual([
      ["SQL built from request input", "critical"],
      ["Hard-coded credential", "critical"],
    ]);
  });
});

describe("severity_threshold", () => {
  const nitpick = finding({ severity: "nitpick", category: "style", title: "Unused import", source: null, candidate: null, file_path: "app/settings.py", line_number: 1, line_end: 1 });

  it("counts a nitpick below the threshold instead of listing it, and keeps not-reviewed candidates", () => {
    const report = run(makeSubmission({ findings: [...(makeSubmission().findings as unknown[]), nitpick] }), {
      config: { severityThreshold: "minor" },
    });
    expect(report.findings.map((f) => f.title)).toEqual(["SQL built from request input"]);
    expect(report.below_threshold).toBe(1);
    expect(report.not_reviewed.map((c) => c.id)).toEqual([LINT_CANDIDATE.id]);
  });

  it("never hides a finding at or above block_on_severity, in a review or a scan", () => {
    const config = { severityThreshold: "critical" as const, blockOnSeverity: "nitpick" as const };
    const review = run(makeSubmission({ findings: [nitpick] }), { config });
    expect(review.findings.map((f) => f.title)).toEqual(["Unused import"]);
    expect(review.below_threshold).toBe(0);
    expect(review.verdict).toBe("blocked");
    const scan = scanReport({ change: makeChange(), scan: makeScan(), config: makeConfig(config) });
    expect(scan.findings).toHaveLength(3);
    expect(scan.below_threshold).toBe(0);
  });

  it("hides scanner findings below the threshold in a scan report", () => {
    const scan = scanReport({ change: makeChange(), scan: makeScan(), config: makeConfig({ severityThreshold: "major" }) });
    expect(scan.findings.map((f) => f.source)).toEqual([SQL_CANDIDATE.token, KEY_CANDIDATE.token]);
    expect(scan.below_threshold).toBe(1);
  });
});
