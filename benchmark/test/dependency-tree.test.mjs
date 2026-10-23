// Failure case: scanner dependency information changes review scoring.
import { expect, it } from "vitest";
import { shownFindings } from "../lib/score.mjs";
import { removeShownFindings } from "../loop/validate.mjs";
import { sampleRecord } from "../lib/runner.mjs";
import { serverSampleRecord } from "../lib/server-review.mjs";
import { analyseSample, scannerReport } from "../lib/scanners.mjs";
it("scores agent outside findings and ignores scanner outside advisories", () => {
  const counted = { origin: "scanner", title: "changed candidate" };
  const agent = { origin: "agent", title: "outside review finding" };
  // Each shown finding carries its tier (rules version 10); scanner information outside the change is not shown.
  expect(shownFindings({ findings: [counted], outside_change: [agent, { origin: "scanner", title: "old advisory" }] })).toEqual([{ ...counted, tier: "finding" }, { ...agent, tier: "finding" }]);
});

// Failure cases: a harm index drops scanner information instead of the
// agent finding, counts include information, or a shown advisory vanishes.
it("maps harm indexes past scanner outside entries to their raw positions", () => {
  const scanner = { origin: "scanner", title: "old advisory" };
  const agent = { origin: "agent", title: "outside finding" };
  const report = { findings: [{ title: "changed" }], outside_change: [scanner, agent] };
  expect(removeShownFindings(report, new Set([1]))).toEqual({ findings: report.findings, outside_change: [scanner] });
});

it("uses the same shown count in laptop and server records", () => {
  const report = { findings: [{}], outside_change: [{ origin: "scanner" }, { origin: "agent" }] };
  const args = { job: {}, attempt: 1, report, result: { rounds: [] } };
  expect(sampleRecord(args).findings).toBe(2);
  expect(serverSampleRecord(args).findings).toBe(2);
});

it("diagnoses shown advisories separately from filter losses and raised candidates", () => {
  const candidate = { id: "c1", token: "osv-scanner:GHSA-old", source: "osv-scanner", ruleId: "GHSA-old", filePath: "package-lock.json", lineStart: 1, lineEnd: 1, message: "old advisory", severity: "high" };
  const job = { case: "tiny", caseId: "tiny", config: "scan", repeat: 1 };
  const sample = analyseSample({ job, spec: { bugs: [{ id: "old", file: "package-lock.json", lines: [1, 1], mentions: ["advisory"] }] },
    scan: { candidates: [candidate], scanners: [], trail: [{ token: candidate.token, file: candidate.filePath, lineStart: 1, lineEnd: 1, stage: "shown" }] },
    report: { findings: [], outside_change: [{ origin: "scanner", candidate: "c1" }] } });
  expect(sample.candidates[0].disposition).toBe("unanswered");
  expect(sample.truth[0].filterLosses).toEqual([]);
  expect(sample.truth[0].shown).toEqual([{ scanner: "osv-scanner", token: candidate.token, stage: "shown" }]);
  const report = scannerReport({ samples: [sample] });
  expect(report.filterLosses).toEqual([]);
  expect(report.shown).toHaveLength(1);
});
