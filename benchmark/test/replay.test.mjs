import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { checkSubmission, DEFAULT_CONFIG } from "../../packages/core/dist/index.js";
import { hashFolder } from "../lib/index.mjs";
import { replayRun, replaySubmission } from "../loop/replay.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);
const cli = fileURLToPath(new URL("../loop/replay.mjs", import.meta.url));
const f = (extra = {}) => ({ severity: "minor", category: "bug", confidence: 0.8, file_path: "a.py", line_number: 2, title: "Division by zero", problem: "The divisor is zero.", consequence: "The request fails.", fix: "Reject zero.", source: null, candidate: null, ...extra });
const spec = { id: "division", guards: "Division is checked", language: "python", framework: "none", clean: false, bugs: [{ id: "zero", file: "a.py", lines: [2, 2], anchor: { line: 2, text: "return 1 / 0" }, mentions: ["zero"], kind: ["bug"], severity: "minor", truth: "The divisor is zero.", found_by: ["reasoning"] }], extras: [] };
const brief = "## Changed files\n\n| Status | Path |\n|---|---|\n| modified | a.py |\n\n## Diff\n\n```diff\ndiff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1,3 +1,3 @@\n # context\n-return 1\n+return 1 / 0\n # context\n```\n";
const manifest = { version: 3, change_id: "abcdef", lenses: [{ name: "division", confidenceFloor: 0.85 }] };
const scan = { candidates: [], scanners: [], secretFingerprints: [] };
const submission = (findings) => ({ version: 2, change_id: "abcdef", summary: "Check division.", findings, dropped: [] });
const input = (findings) => ({ change: { id: "abcdef", shortId: "abcdef", files: [{ path: "a.py" }], coverage: new Map([["a.py", new Set([2])]]), deletionPoints: new Map(), baseRef: "HEAD", baseSha: "123", notReviewed: [], stats: {} }, scan, manifest, config: DEFAULT_CONFIG, submission: submission(findings), lineCount: (path) => path === "a.py" ? 3 : null });
const write = (path, data) => writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data));

function savedRun(findingsByRepeat) {
  const root = tempDir("oq-replay-");
  const run = join(root, "run");
  mkdirSync(join(run, "cases"), { recursive: true });
  write(join(run, "manifest.json"), { version: 1, cases: ["division"], configs: ["claude-graph-off"], repeat: findingsByRepeat.length });
  write(join(run, "cases", "division.json"), spec);
  for (const [i, findings] of findingsByRepeat.entries()) {
    const dir = join(run, "samples", "division", "claude-graph-off", String(i + 1));
    mkdirSync(join(dir, "report"), { recursive: true });
    write(join(dir, "sample.json"), { case: "division", config: "claude-graph-off", repeat: i + 1, attempt: 1 });
    write(join(dir, "report", "brief.md"), brief);
    write(join(dir, "report", "manifest.json"), manifest);
    write(join(dir, "report", "scan.json"), scan);
    write(join(dir, "report", "submission.json"), submission(findings));
    const checked = checkSubmission(input(findings));
    expect(checked.ok).toBe(true);
    write(join(dir, "report", "report.json"), { ...checked.report, completion: { status: "complete" } });
  }
  return { root, run };
}

it("a replay applies a check other than the product's", () => {
  for (const invalid of [f({ line_number: 1 }), f({ problem: "word ".repeat(21) }), f({ source: "lens:unknown" })]) {
    const args = input([invalid]);
    const core = checkSubmission(args);
    expect(core.ok).toBe(false);
    expect(replaySubmission(args)).toEqual(core);
  }
  // A floor is inclusive, and a lens's higher floor still wins.
  const args = input([f({ confidence: 0.8 }), f({ confidence: 0.79, title: "Low confidence" }), f({ confidence: 0.84, source: "lens:division", title: "Lens floor" })]);
  expect(replaySubmission(args, { floor: 0.8 }).report.findings.map((x) => x.title)).toEqual(["Division by zero"]);
});

it("a replay changes a saved run", () => {
  const { root, run } = savedRun([[f({ severity: "nitpick" }), f({ severity: "info", category: "maintainability", title: "Missing tests" })], [f()]]);
  const before = hashFolder(run);
  for (const mode of ["threshold", "union", "floor"]) {
    const out = join(root, `${mode}.md`);
    const result = spawnSync(process.execPath, [cli, mode, run, "--out", out], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(result.stdout);
  }
  const threshold = replayRun(run, { mode: "threshold" }).rows[0];
  expect(threshold.addedHits).toBe(1);
  expect(threshold.addedTestRequests).toBe(1);
  // Reject a normal path, a parent symlink, and an alias of a saved file.
  symlinkSync(run, join(root, "alias"));
  symlinkSync(join(run, "manifest.json"), join(root, "saved.json"));
  for (const out of [join(run, "replay.md"), join(root, "alias", "replay.md"), join(root, "saved.json")]) {
    const result = spawnSync(process.execPath, [cli, "threshold", run, "--out", out], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("run folder");
  }
  expect(hashFolder(run)).toEqual(before);
});

it("the union counts one bug found in two repeats twice", () => {
  // Two titles about one truth item survive product dedup, but recall is one.
  const { run } = savedRun([[f()], [f(), f({ title: "Zero divisor crashes" })]]);
  const row = replayRun(run, { mode: "union" }).rows[0];
  expect(row.beforeHits).toBe(1);
  expect(row.hits).toBe(1);
  expect(row.of).toBe(1);
  expect(row.findings).toBe(2);
  const single = savedRun([[f()]]);
  expect(replayRun(single.run, { mode: "union" }).rows[0].status).toBe("insufficient repeats");
});

it("a saved submission rejected by core is scored as a successful replay", () => {
  const { run } = savedRun([[f()]]);
  write(join(run, "samples", "division", "claude-graph-off", "1", "report", "submission.json"), submission([f({ line_number: 1 })]));
  expect(() => replayRun(run, { mode: "threshold" })).toThrow(/not a line this change/);
});
