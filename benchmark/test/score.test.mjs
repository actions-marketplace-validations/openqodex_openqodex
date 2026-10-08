// The scorer decides what the benchmark says about a build, so it is checked
// against hand-written reports whose right score is known: an exact hit, a
// duplicate, a near miss by one line, a wrong kind, two bugs on one line, a
// bug found at its second location, an accepted side issue, a false finding,
// a clean change, a missing report, and what a brief did and did not say.
import { describe, expect, it } from "vitest";
import { classify, regressions, runDifferences, scoreBrief, scoreSample, summarize, value } from "../lib/score.mjs";

const bug = (id, file, lines, anchorLine, kind, severity, extra = {}) => ({ id, file, lines, anchor: { line: anchorLine, text: "x" }, kind, severity, found_by: ["reasoning"], truth: "t", ...extra });

const spec = {
  id: "hand",
  guards: "g",
  language: "python",
  framework: "flask",
  clean: false,
  graph: { gaps: [{ file: "src/router.js", line: 7, cause: "dynamic" }], floors: ["src/handlers.js#onSave"], callers: ["src/cart.ts:8"] },
  bugs: [
    bug("sqli", "app/search.py", [14, 14], 14, ["security"], "critical"),
    bug("off-by-one", "app/server.py", [23, 23], 23, ["bug"], "major"),
    bug("root", "Dockerfile", [3, 11], 11, ["security"], "major", { mentions: ["root"] }),
    bug("apt", "Dockerfile", [3, 3], 3, ["maintainability", "security"], "minor"),
    bug("lodash", "package-lock.json", [11, 17], 11, ["security"], "major", { also: [{ file: "package.json", lines: [7, 7] }] }),
  ],
  extras: [{ file: "app/server.py", lines: [30, 32], why: "a real side issue" }],
};

const finding = (file_path, line_number, category, title, extra = {}) => ({ origin: "agent", severity: "major", category, confidence: 0.9, file_path, line_number, line_end: line_number, title, description: title, suggested_change: null, source: null, candidate: null, notes: [], problem: title, consequence: "c", fix: "f", ...extra });

const report = (findings, extra = {}) => ({
  version: 1,
  kind: "review",
  verdict: "passed",
  findings,
  outside_change: [],
  dropped: [],
  scanners: [],
  impact: { status: "ok", build: { durationMs: 100 } },
  completion: { status: "complete", missing: [], reviewer: { duration_ms: 60_000, rounds: 1, usage: { turns: 9, input_tokens: 100_000, output_tokens: 5_000, cost_usd: 0.5 } } },
  ...extra,
});

const brief = [
  "# Review brief",
  "",
  "## What this change reaches",
  "",
  "Call sites of the touched and removed code, certain first:",
  "- src/cart.ts:8 in `cartTotal` calls `formatPrice` (1 hop, certain)",
  "",
  "What the graph could not see:",
  "- The callers of `onSave` are a floor: 1 call goes through a value (a callback or a computed member) in the repository root project, and could reach it.",
  "- In the changed files and their callers' files, 1 call site could not be bound (1 no-receiver-type):",
  "  - src/handlers.js:7 `set`: no-receiver-type",
  "",
  "## The changed lines",
].join("\n");

describe("matching one finding to a planted bug", () => {
  it("counts a finding on the planted line with a planted kind as a hit", () => {
    expect(classify(finding("app/search.py", 14, "security", "SQL injection"), spec)).toEqual({ outcome: "hit", bug: "sqli" });
  });

  it("calls a finding one line below the planted line a near miss, not a hit", () => {
    expect(classify(finding("app/server.py", 24, "bug", "page offset"), spec)).toEqual({ outcome: "near", bug: "off-by-one", distance: 1 });
  });

  it("calls a finding on the planted line with a kind the bug does not have a wrong kind, not a hit", () => {
    expect(classify(finding("app/search.py", 14, "performance", "slow query"), spec)).toEqual({ outcome: "wrong-kind", bug: "sqli", expected: ["security"] });
  });

  it("gives a finding on a line two bugs share to the bug whose words it uses", () => {
    expect(classify(finding("Dockerfile", 3, "security", "The container runs as root"), spec).bug).toBe("root");
    expect(classify(finding("Dockerfile", 3, "maintainability", "apt-get install has no -y"), spec).bug).toBe("apt");
  });

  it("finds a bug at its second location, with the path written another way", () => {
    expect(classify(finding("./package.json", 7, "security", "lodash 4.17.15 is vulnerable"), spec)).toEqual({ outcome: "hit", bug: "lodash" });
  });

  it("leaves a listed side issue out, and calls anything else false", () => {
    expect(classify(finding("app/server.py", 31, "bug", "connection leak"), spec).outcome).toBe("accepted");
    expect(classify(finding("app/other.py", 5, "style", "naming"), spec).outcome).toBe("false");
  });

  it("counts a finding that only asks for a test apart on a planted case, and as false on a clean case", () => {
    expect(classify(finding("app/other.py", 5, "maintainability", "Changed formatting has no covering test"), spec).outcome).toBe("test-gap");
    expect(classify(finding("src/a.ts", 5, "maintainability", "Changed formatting has no covering test"), { ...spec, clean: true, bugs: [], extras: [] }).outcome).toBe("false");
  });
});

describe("scoring one review", () => {
  const findings = [
    finding("app/search.py", 14, "security", "SQL injection"),
    finding("app/search.py", 14, "security", "SQL injection again"),
    finding("app/server.py", 24, "bug", "page offset"),
    finding("Dockerfile", 3, "security", "The container runs as root"),
    finding("Dockerfile", 3, "maintainability", "apt-get install has no -y"),
    finding("package.json", 7, "security", "lodash 4.17.15 is vulnerable", { candidate: "c3", source: "osv-scanner:GHSA" }),
    finding("app/server.py", 31, "bug", "connection leak"),
    finding("app/other.py", 5, "style", "naming"),
    finding("app/search.py", 14, "performance", "slow query"),
  ];
  const s = scoreSample({ spec, report: report(findings), brief, row: { config: "claude-graph-on", repeat: 1, wallMs: 90_000 } });

  it("counts bugs found, not findings, and by severity", () => {
    expect(s.recall).toEqual({ hit: 4, of: 5 });
    expect(s.bySeverity.critical).toEqual({ hit: 1, of: 1 });
    expect(s.bySeverity.major).toEqual({ hit: 2, of: 3 });
    expect(s.bySeverity.minor).toEqual({ hit: 1, of: 1 });
  });

  it("scores precision over every finding but the accepted side issue, a duplicate counting as correct", () => {
    expect(s.precision).toEqual({ hit: 5, of: 8 });
    expect([s.falseFindings, s.nearMisses, s.wrongKinds, s.accepted]).toEqual([1, 1, 1, 1]);
  });

  it("records how each bug was found or missed", () => {
    const by = Object.fromEntries(s.bugs.map((b) => [b.id, b]));
    expect(by.sqli).toMatchObject({ found: true, findings: 2, via: "reviewer", wrongKind: ["performance"] });
    expect(by["off-by-one"]).toMatchObject({ found: false, near: [1] });
    expect(by.lodash).toMatchObject({ found: true, via: "scanner" });
  });

  it("reads time, turns, tokens and cost from the saved report and row", () => {
    expect([s.wallMs, s.reviewerMs, s.turns, s.inputTokens, s.costUsd]).toEqual([90_000, 60_000, 9, 100_000, 0.5]);
  });

  it("scores a missing report as a review that missed every bug", () => {
    const failed = scoreSample({ spec, report: null, brief: null });
    expect(failed.status).toBe("failed");
    expect(failed.recall).toEqual({ hit: 0, of: 5 });
  });
});

describe("a clean change", () => {
  const clean = { id: "clean", guards: "g", language: "typescript", framework: "none", clean: true, bugs: [] };
  it("passes its control with no finding, and fails it with any finding, which counts as false", () => {
    expect(scoreSample({ spec: clean, report: report([]), brief: null }).controls).toEqual({ hit: 1, of: 1 });
    const one = scoreSample({ spec: clean, report: report([finding("src/a.ts", 3, "bug", "a guess")]), brief: null });
    expect(one.controls).toEqual({ hit: 0, of: 1 });
    expect(one.precision).toEqual({ hit: 0, of: 1 });
    expect(one.falseFindings).toBe(1);
  });
  it("fails its control when the review wrote no report", () => {
    expect(scoreSample({ spec: clean, report: null, brief: null }).controls).toEqual({ hit: 0, of: 1 });
  });
});

describe("what the brief told the reviewer", () => {
  it("counts a floor and a caller the brief names, and not a gap site it leaves out", () => {
    const b = scoreBrief(spec, brief);
    expect(b.graph).toBe("on");
    expect(b.gaps).toEqual({ hit: 1, of: 2 });
    expect(b.callers).toEqual({ hit: 1, of: 1 });
    expect(b.failures).toEqual(["the brief does not name the dynamic call at src/router.js:7 as unseen"]);
  });
  it("gives a brief with the graph off no credit", () => {
    const off = scoreBrief(spec, "## What this change reaches\n\nThe code graph is off for this review.\n");
    expect(off.graph).toBe("off");
    expect(off.gaps).toEqual({ hit: 0, of: 2 });
    expect(off.callers).toEqual({ hit: 0, of: 1 });
  });
});

describe("summing and comparing runs", () => {
  const sample = (found, config = "claude-graph-on") => scoreSample({ spec, report: report(found ? [finding("app/search.py", 14, "security", "SQL injection")] : []), brief, row: { config, repeat: 1, wallMs: 1000 } });

  it("sums ratios as hits over checks, never averages of averages", () => {
    const t = summarize([sample(true), sample(false), sample(false)]);
    expect(t.recall).toEqual({ hit: 1, of: 15 });
    expect(value(t.recall)).toBeCloseTo(1 / 15);
    expect(t.wallMs).toMatchObject({ n: 3, mean: 1000 });
  });

  it("reports a bug found in every earlier review and missed in two of three now as a regression, and one miss as no regression", () => {
    const before = [sample(true), sample(true), sample(true)];
    expect(regressions(before, [sample(true), sample(false), sample(false)]).map((r) => r.bug)).toContain("sqli");
    expect(regressions(before, [sample(true), sample(true), sample(false)]).map((r) => r.bug)).not.toContain("sqli");
  });

  it("names a different model or case set before any comparison", () => {
    const a = { reviewer: { name: "claude", version: "2.1.294", model: "m1" }, cases: ["a"], repeat: 3, configs: ["x"] };
    const b = { ...a, reviewer: { ...a.reviewer, model: "m2" } };
    expect(runDifferences(a, a)).toEqual([]);
    expect(runDifferences(a, b)[0]).toMatch(/reviewer model/);
  });
});
