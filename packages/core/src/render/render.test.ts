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
// 8. JSON is not the report as is.
import { describe, expect, it } from "vitest";
import { finalizeReview, scanReport } from "../finalize.js";
import { SECRET, finding, makeChange, makeConfig, makeManifest, makeScan, makeSubmission } from "../test-fixtures.js";
import type { Config, Report } from "../types.js";
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

describe("renderJson", () => {
  it("is the report as is", () => {
    const report = fullReview();
    expect(JSON.parse(renderJson(report))).toEqual(JSON.parse(JSON.stringify(report)));
  });
});

describe("renderSarif", () => {
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
