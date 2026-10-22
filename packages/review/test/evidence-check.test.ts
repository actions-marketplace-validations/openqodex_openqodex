// Failure cases: invented quotes, wrong line windows, removed evidence
// checked against head text, missing examination, unknown verdict ids,
// unresolved scanners, and confirmed anchors outside the change.
import { afterAll, expect, it } from "vitest";
import { checkEvidence, checkFindAnswer, checkVerifyAnswer } from "../src/evidence-check.js";
import { hunkRefs, unitsOf } from "../src/units.js";
import { snapshotText, lineCounter } from "../src/snapshot.js";
import { cleanupFixtures, candidate, fixture, scanner, verdict } from "./staged-fixture.js";

afterAll(cleanupFixtures);
it("rejects invented quotes and quotes farther than two lines away", () => {
  const { change } = fixture();
  const cite = { file_path: "a.txt", line_number: 4, quote: "unsafe   operation" };
  expect(checkEvidence(cite, () => "unsafe operation\n\n\n\n", change)).toContain("a.txt:4");
  expect(checkEvidence({ ...cite, line_number: 3 }, () => "unsafe operation\n\n\n\n", change)).toBeNull();
  expect(checkEvidence({ ...cite, quote: "invented" }, () => "unsafe operation", change)).not.toBeNull();
});
it("checks deletion evidence in removed lines even when its file is gone", () => {
  const { change } = fixture();
  const cite = { file_path: "a.txt", line_number: 1, quote: "old   operation", removed: true as const };
  expect(checkEvidence(cite, () => null, change)).toBeNull();
  expect(checkEvidence({ ...cite, quote: "unsafe operation" }, () => null, change)).not.toBeNull();
});
it("strips unknown keys and names a missing examination and analysis", () => {
  const { change, dir } = fixture();
  const unit = unitsOf(change, hunkRefs(change))[0]!;
  const out = checkFindAnswer({ version: "find-1", change_id: change.id, unit: unit.id, examined: [], analysis: [], candidates: [], extra: true }, unit, change, snapshotText(dir));
  expect(out.errors.join(" ")).toContain("h1");
  expect(out.answer).not.toHaveProperty("extra");
});
it("rejects a finder below the confidence floor or without evidence", () => {
  const { change, dir } = fixture();
  const unit = unitsOf(change, hunkRefs(change))[0]!;
  const out = checkFindAnswer({ version: "find-1", change_id: change.id, unit: unit.id, examined: ["h1"], analysis: [{ hunk: "h1", changed: "Operation changed", could_break: "Inputs" }], candidates: [{ ...candidate("a.txt"), confidence: 0.49, evidence: [] }] }, unit, change, snapshotText(dir));
  expect(out.errors.join(" ")).toMatch(/confidence/);
  expect(out.errors.join(" ")).toMatch(/evidence/);
});
it("rejects unresolved scanners, duplicate verdicts, unknown ids and wrong anchors", () => {
  const { change, dir } = fixture();
  const c = { kind: "scanner" as const, id: "c1", candidate: scanner("a.txt") };
  const batch = { file: "a.txt", hunks: hunkRefs(change), candidates: [c] };
  const value = { version: "verify-1", change_id: change.id, verdicts: [verdict(c, "unresolved"), { ...verdict(c), id: "k99", line_number: 2 }, verdict(c)] };
  const errors = checkVerifyAnswer(value, batch, change, snapshotText(dir), lineCounter(dir)).errors.join(" ");
  expect(errors).toContain("a scanner candidate is confirmed or refuted");
  expect(errors).toContain("exactly one");
  expect(errors).toContain("not in this batch");
  expect(errors).toContain("not a line this change");
});
it("rejects missing ids and duplicate cycles", () => {
  const { change, dir } = fixture();
  const c = { kind: "scanner" as const, id: "c1", candidate: scanner("a.txt") };
  const batch = { file: "a.txt", hunks: hunkRefs(change), candidates: [c, { ...c, id: "c2" }] };
  const value = { version: "verify-1", change_id: change.id, verdicts: [{ ...verdict(c), duplicate_of: "c2" }, { ...verdict(c), id: "c2", duplicate_of: "c1" }] };
  expect(checkVerifyAnswer(value, batch, change, snapshotText(dir), lineCounter(dir)).errors.join(" ")).toContain("cycle");
  value.verdicts.pop();
  expect(checkVerifyAnswer(value, batch, change, snapshotText(dir), lineCounter(dir)).errors.join(" ")).toContain("candidate c2");
});
