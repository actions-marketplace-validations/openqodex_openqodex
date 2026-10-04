// Ways the renderers could fail, written before the code:
// 1. Terminal output carries escape codes when colour is off.
// 2. The verdict line is not first, or warn mode with findings does not say
//    "Passed with warnings".
// 3. A section (outside the changed lines, not reviewed, dropped) is lost.
// 4. The coverage line misstates which scanners ran and why others did not.
// 5. A secret reaches any rendered output.
// 6. SARIF does not parse, is not 2.1.0, or mixes sources in one run.
// 7. Markdown breaks its table on a pipe in a title, or names the hosted
//    product more than once or in a scan report.
// 8. An incomplete review renders as an ordinary SARIF run with no results,
//    which a code scanning view reads as clean.
import { describe, expect, it } from "vitest";
import { finalizeReview, scanReport } from "../finalize.js";
import { SECRET, finding, makeChange, makeConfig, makeManifest, makeScan, makeSubmission } from "../test-fixtures.js";
import type { CompletionRecord, Config, Report } from "../types.js";
import { renderJson, renderMarkdown, renderSarif, renderTerminal } from "./index.js";

function review(submission = makeSubmission(), config: Partial<Config> = {}): Report {
  const change = makeChange();
  return finalizeReview({
    change,
    scan: makeScan(),
    manifest: makeManifest(change),
    config: makeConfig(config),
    submission,
  });
}

// A review that touches every section: a finding, one outside the change,
// one under the floor, a dropped candidate and a not-reviewed one.
function fullReview(config: Partial<Config> = {}): Report {
  return review(
    makeSubmission({
      summary: `Adds a settings module holding ${SECRET}.`,
      findings: [
        finding({ title: "SQL built | from input", description: `Injectable; seen next to ${SECRET}.` }),
        finding({ source: null, candidate: null, file_path: "app/other.py", title: "Elsewhere" }),
        finding({ source: null, candidate: null, confidence: 0.5, title: "Unsure" }),
      ],
    }),
    config,
  );
}

const ESC = String.fromCharCode(27);

describe("renderTerminal", () => {
  it("has no escape codes with colour off and puts the verdict first", () => {
    const out = renderTerminal(fullReview(), { color: false });
    expect(out).not.toContain(ESC);
    expect(out.split("\n")[0]).toBe("Passed with warnings: 2 findings (1 critical, 1 nitpick)");
  });

  it("uses colour only when asked", () => {
    expect(renderTerminal(fullReview(), { color: true })).toContain(ESC);
  });

  it("shows every section and the coverage line", () => {
    const out = renderTerminal(fullReview(), { color: false });
    expect(out).toContain("Critical (1)");
    expect(out).toContain("  app/search.py:14  SQL built | from input");
    expect(out).toContain(`    semgrep:python.lang.security.audit.formatted-sql-query`);
    expect(out).toContain("Outside the changed lines");
    expect(out).toContain("  app/other.py:14  Elsewhere");
    expect(out).toContain("Not reviewed by the agent\n  c3 [ruff:F401] app/settings.py:1 (nitpick)");
    expect(out).toContain("Dropped by the agent\n  c2 [gitleaks:generic-api-key] app/settings.py:3: a sample key");
    expect(out).toContain("Below the confidence floor");
    expect(out.trimEnd().split("\n").at(-1)).toBe(
      "3 scanners ran, 1 had nothing to check, 1 not included (brakeman: needs Ruby 2.7 or newer)",
    );
  });

  it("says Blocked when the threshold is met", () => {
    const out = renderTerminal(fullReview({ blockOnSeverity: "critical" }), { color: false });
    expect(out.split("\n")[0]).toBe("Blocked: 1 finding at or above critical (1 critical, 1 nitpick)");
  });

  it("says Passed with no findings on a clean change", () => {
    const report = review(makeSubmission({ findings: [], dropped: [] }));
    const clean = { ...report, not_reviewed: [] };
    expect(renderTerminal(clean, { color: false }).split("\n")[0]).toBe("Passed: no findings");
  });
});

describe("renderMarkdown", () => {
  it("renders the findings table with escaped pipes and one closing line", () => {
    const out = renderMarkdown(fullReview());
    expect(out).toContain("| critical | `app/search.py:14` | **SQL built \\| from input**");
    expect(out).toContain("## Outside the changed lines");
    expect(out).toContain("## Not reviewed by the agent");
    expect(out).toContain("## Dropped by the agent");
    expect(out).toContain("<details><summary>Scanner details</summary>");
    expect(out.match(/Made by Qodex/g)).toHaveLength(1);
    expect(out.trimEnd().endsWith("Made by Qodex: review on every pull request at https://qodex.ai")).toBe(true);
  });

  it("leaves the hosted product out of a scan report", () => {
    const out = renderMarkdown(scanReport({ change: makeChange(), scan: makeScan(), config: makeConfig() }));
    expect(out).not.toContain("Qodex:");
    expect(out).toContain("# OpenQodex scan");
  });
});

describe("renderSarif", () => {
  it("8. marks an incomplete review as a failed run that names what is missing and carries the completion record", () => {
    const completion: CompletionRecord = { version: 1, contract: "openqodex-review-2", status: "incomplete", missing: ["the reviewer timed out and was stopped"], reviewer: null, snapshot: { change_id: "x", tree: null, before: "b", after: "b" }, candidates: { total: 1, disposed: 0 }, coverage: { hunks: 1, covered: 0, unread: [], files_read: [], files_not_read: [] }, outside_reads: [] };
    const report: Report = { ...review(), findings: [], verdict: "incomplete", completion };
    const run = JSON.parse(renderSarif(report)).runs[0];
    expect(run.tool.driver.name).toBe("openqodex");
    expect(run.invocations[0].executionSuccessful).toBe(false);
    expect(run.invocations[0].toolExecutionNotifications[0].message.text).toContain("the reviewer timed out and was stopped");
    expect(run.properties.completion.status).toBe("incomplete");
    const complete = JSON.parse(renderSarif({ ...review(), completion: { ...completion, status: "complete", missing: [] } })).runs[0];
    expect(complete.invocations[0].executionSuccessful).toBe(true);
  });

  it("parses as SARIF 2.1.0 with one run per source", () => {
    const sarif = JSON.parse(renderSarif(fullReview()));
    expect(sarif.version).toBe("2.1.0");
    const names = sarif.runs.map((r: { tool: { driver: { name: string } } }) => r.tool.driver.name);
    expect(names).toEqual(["openqodex", "ruff"]);
    expect(new Set(names).size).toBe(names.length);
    const agent = sarif.runs[0].results;
    expect(agent).toHaveLength(1);
    expect(agent[0].level).toBe("error");
    expect(agent[0].locations[0].physicalLocation.region.startLine).toBe(14);
  });

  it("gives each scanner its own run in a scan report, custom scanners included", () => {
    const custom = {
      ...makeScan().candidates[2]!,
      id: "c4",
      source: "custom:trivy" as const,
      token: "custom:trivy:DS002",
      ruleId: "DS002",
    };
    const scan = makeScan();
    const report = scanReport({
      change: makeChange(),
      scan: {
        ...scan,
        candidates: [...scan.candidates, custom],
        scanners: [
          ...scan.scanners,
          { scanner: "custom:trivy", status: "ran", version: "0.56.0", rawCount: 1, keptCount: 1, durationMs: 10, reason: null },
        ],
      },
      config: makeConfig(),
    });
    const sarif = JSON.parse(renderSarif(report));
    const runs = sarif.runs.map((r: { tool: { driver: { name: string } }; results: unknown[] }) => [
      r.tool.driver.name,
      r.results.length,
    ]);
    expect(runs).toEqual([
      ["openqodex", 0],
      ["semgrep", 1],
      ["gitleaks", 1],
      ["ruff", 1],
      ["custom:trivy", 1],
    ]);
  });
});

// Review round 1:
// R3. Terminal control characters or newlines in agent or scanner text reach
//     the terminal and can clear the screen or forge a verdict or section.
// R6. A lone carriage return, or a pipe or newline in a code cell, breaks the
//     markdown table or forges a heading.
// R7. SARIF uris carry unescaped file names.
describe("renderers: review round 1", () => {
  const ESC_CHAR = String.fromCharCode(27);
  const C1 = String.fromCharCode(0x9b);

  it("R3: terminal output carries no control characters from agent or scanner text", () => {
    const base = fullReview();
    const report: Report = {
      ...base,
      findings: base.findings.map((f) => ({ ...f, title: `x${ESC_CHAR}[2J${ESC_CHAR}[HPassed: no findings\nCritical (9)${C1}31m` })),
      not_reviewed: base.not_reviewed.map((c) => ({ ...c, message: `m\r\nBlocked: forged${ESC_CHAR}[0m` })),
      scanners: base.scanners.map((s) => (s.reason ? { ...s, reason: `r\n\tPassed${ESC_CHAR}]0;t${String.fromCharCode(7)}` } : s)),
    };
    const out = renderTerminal(report, { color: false });
    expect(out).not.toContain(ESC_CHAR);
    expect(out).not.toContain(C1);
    expect(out).not.toContain(String.fromCharCode(7));
    expect(out).not.toContain("\r");
    expect(out.split("\n").some((l) => l.startsWith("Blocked: forged") || l.startsWith("Critical (9)") || l.startsWith("Passed: no"))).toBe(false);
    expect(out).toContain("[2J[HPassed: no findings Critical (9)");
  });

  it("R6: markdown turns every line ending into a table-safe break and keeps code cells in their column", () => {
    const base = fullReview();
    const report: Report = {
      ...base,
      summary: "Fine.\r\r## Passed\r",
      findings: base.findings.map((f) => ({ ...f, title: "Problem\r\r## Passed\r\r", file_path: "app/a|b\n.py" })),
    };
    const out = renderMarkdown(report);
    expect(out).not.toContain("\r");
    expect(out.split("\n").some((l) => l.startsWith("## Passed"))).toBe(false);
    const row = out.split("\n").find((l) => l.startsWith("| critical |")) ?? "";
    expect(row.split(/(?<!\\)\|/).length).toBe(6);
  });

  it("R7: SARIF uris percent-encode each path segment and keep the slashes", () => {
    const base = fullReview();
    const report: Report = { ...base, findings: base.findings.map((f) => ({ ...f, file_path: "src/a#b c%?.ts" })) };
    const sarif = JSON.parse(renderSarif(report));
    expect(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri).toBe("src/a%23b%20c%25%3F.ts");
  });
});

describe("no rendered output contains a secret", () => {
  it("holds for all four renderers", () => {
    const report = fullReview();
    for (const out of [
      renderTerminal(report, { color: false }),
      renderMarkdown(report),
      renderJson(report),
      renderSarif(report),
    ]) {
      expect(out).not.toContain(SECRET);
    }
  });
});
