// Failure cases: stages silently fall back to one session, traces lose their
// sessions, concurrent calls collide, the snapshot changes, finder failures
// erase successful work, and unresolved scanners receive no correction.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import type { CompletionRecord, ReviewerSessionRecord } from "@openqodex/core";
import "./global-setup.js";
import { demo, readJson, report, reportDir, root, run, stagedProviderEnv, writeConfig } from "./support.js";
import { fixDemoSecret } from "../golden/fixture-secret.mjs";
import { removeTempDirs } from "../temp-dirs.mjs";

afterAll(removeTempDirs);
function review(label: string, config = "review:\n  stages: true\n", extraEnv: NodeJS.ProcessEnv = {}, extraUnit = false, driver: "claude" | "codex" = "claude") {
  const dir = demo(label);
  fixDemoSecret(dir);
  if (extraUnit) {
    const file = join(dir, "app/server.py");
    writeFileSync(file, readFileSync(file, "utf8") + "\n" + "# additional context\n".repeat(1800));
  }
  writeConfig(dir, config);
  const result = run(label, dir, ["review", "--reviewer", driver, "--skip", "semgrep,osv-scanner", "--no-color"], { timeout: 300_000, env: { ...stagedProviderEnv(driver, extraEnv), ...extraEnv } });
  const out = reportDir(dir);
  return { result, report: report(dir), out, reviewer: readJson<{ sessions?: ReviewerSessionRecord[] }>(join(out, "reviewer.json")) };
}
for (const driver of ["claude", "codex"] as const) {
  it(`${driver}: reviews planted candidates with fresh sessions, unique usage and an unchanged snapshot`, () => {
    const r = review(`stages-${driver}`, "review:\n  stages: true\n  block_on_severity: major\n", {}, false, driver);
    expect(r.result.status, r.result.stderr).toBe(1);
    const completion = r.report.completion as CompletionRecord;
    expect(completion.status).toBe("complete");
    expect(completion.snapshot.after).toBe(completion.snapshot.before);
    expect(completion.reviewer!.sessions!.length).toBeGreaterThanOrEqual(4);
    const roles = completion.reviewer!.sessions!.map((s) => s.role);
    expect(new Set(roles).size).toBe(roles.length);
    expect(r.reviewer.sessions).toEqual(completion.reviewer!.sessions);
    const trace = readJson<{ session?: string }[]>(join(r.out, "trace.json"));
    expect(trace.length).toBeGreaterThan(0);
    expect(trace.every((t) => t.session && roles.includes(t.session))).toBe(true);
    const usage = readJson<{ calls: { callId: string }[]; totals: { attempts: number } }>(join(r.out, "usage.json"));
    expect(new Set(usage.calls.map((c) => c.callId)).size).toBe(usage.calls.length);
    expect(usage.totals.attempts).toBe(usage.calls.length);
    expect(existsSync(join(r.out, "briefs/finder-u1-local.md"))).toBe(true);
    const expected = readJson<{ bugs: { id: string; file: string; lines: [number, number] }[] }>(join(root, "examples/demo-repo/expected.json"));
    for (const bug of expected.bugs) expect(r.report.findings.some((f) => f.file_path === bug.file && f.line_number <= bug.lines[1] && f.line_end >= bug.lines[0]), bug.id).toBe(true);
    expect(r.report.findings.some((f) => f.file_path === "app/config.py")).toBe(true);
    expect(r.report.not_reviewed).toEqual([]);
  });
}
it("stages false preserves a single session", () => {
  const r = review("stages-off", "review:\n  stages: false\n");
  expect(r.result.status, r.result.stderr).toBe(0);
  const completion = r.report.completion as CompletionRecord;
  expect(completion.status).toBe("complete");
  expect(completion.reviewer!.rounds).toBe(1);
  expect(completion.reviewer!.sessions).toBeUndefined();
  expect(readJson<{ calls: unknown[] }>(join(r.out, "usage.json")).calls).toHaveLength(1);
});
it("a finder failing twice names its hunks and pass and keeps other findings", () => {
  const r = review("stages-finder-failure", "review:\n  stages: true\n", { OPENQODEX_STANDIN_FAIL_FINDER: "u1:local" }, true);
  expect(r.result.status).toBe(2);
  expect(r.report.completion!.status).toBe("incomplete");
  expect(r.report.completion!.missing.join(" ")).toMatch(/hunk h\d+ of .+ was not examined by the local pass/);
  expect((r.report.completion as CompletionRecord).reviewer!.sessions!.filter((s) => s.role.startsWith("finder:u1:local"))).toHaveLength(2);
  expect(r.report.findings.some((f) => f.file_path === "app/server.py")).toBe(true);
});
it("an unresolved scanner gets a correction and is accepted on the second answer", () => {
  const r = review("stages-unresolved", "review:\n  stages: true\n", { OPENQODEX_STANDIN_UNRESOLVED_SCANNER: "1" });
  expect(r.result.status, r.result.stderr).toBe(0);
  expect(r.report.completion!.status).toBe("complete");
  const rounds = readJson<{ by: string; errors: string[] }[]>(join(r.out, "rounds.json"));
  expect(rounds.some((r) => r.by.startsWith("verifier:") && r.errors.some((e) => e.includes("a scanner candidate is confirmed or refuted")))).toBe(true);
  expect(r.report.not_reviewed).toEqual([]);
  expect(readFileSync(join(r.out, "submission.json"), "utf8")).toContain('"version": 2');
});
