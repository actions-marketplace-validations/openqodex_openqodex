// Failure cases: the version 2 builder loses outside entries or fixed notes,
// review rendering loses them, or SARIF counts informational advisories.
import { expect, it } from "vitest";
import { checkSubmission, scanReport } from "./finalize.js";
import { makeChange, makeConfig, makeManifest, makeScan } from "./test-fixtures.js";
import { renderReview } from "./render/review.js";
import { renderSarif } from "./render/sarif.js";

it("preserves outside entries in version 2 reports and review output while SARIF omits them", () => {
  const change = makeChange(); const config = makeConfig({ blockOnSeverity: "minor" });
  const scan = makeScan({ candidates: [], outside: [{ id: "o1", token: "osv-scanner:GHSA-old", source: "osv-scanner", ruleId: "GHSA-old", filePath: "package-lock.json", lineStart: 1, lineEnd: 1, severity: "high", reviewSeverity: "major", message: "lodash@4.17.15. Fixed in 4.17.21", reference: null }] });
  const checked = checkSubmission({ change, scan, config, manifest: makeManifest(change), lineCount: () => 10, submission: { version: 2, change_id: change.id, summary: "No changed defect.", findings: [], dropped: [] } });
  expect(checked.ok).toBe(true);
  if (!checked.ok) return;
  expect(checked.report.outside_change).toHaveLength(1); expect(checked.report.verdict).toBe("passed");
  for (const format of ["terminal", "markdown"] as const) {
    const text = renderReview(checked.report, { format });
    expect(text.replaceAll("\\", "")).toContain("Outside the changed lines (1), never counted");
    expect(text).toContain("In the tree before this change.");
    expect(text).toContain("Fixed in 4.17.21");
  }
  const report = scanReport({ change, scan, config });
  expect(report.outside_change).toHaveLength(1);
  expect(renderSarif(report)).not.toContain("GHSA-old");
  const outside = report.outside_change[0];
  const numbered = renderReview({ ...report, findings: [{ ...outside, title: "Changed advisory" }] }, { format: "markdown" });
  expect(numbered.replaceAll("\\", "")).toContain("1. Major security: Changed advisory");
  expect(numbered.replaceAll("\\", "")).toContain("2. Major security: GHSA-old");
});
