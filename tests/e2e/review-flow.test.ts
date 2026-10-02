import { appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import "./global-setup.js";
import type { Candidate } from "@openqodex/core";
import { demo, report, reportDir, run } from "./support.js";

function brief(label: string) {
  const dir = demo(label);
  const result = run(`${label}-brief`, dir, ["review", "--agent"], { timeout: 300_000 });
  expect(result.status).toBe(0);
  const path = reportDir(dir);
  const candidates = JSON.parse(readFileSync(join(path, "candidates.json"), "utf8")) as Candidate[];
  const changeId = JSON.parse(readFileSync(join(path, "manifest.json"), "utf8")) as { change_id: string };
  return { dir, result, path, candidates, changeId: changeId.change_id };
}
function submission(changeId: string, candidates: Candidate[], raised: Candidate[]) {
  return { version: 1, change_id: changeId, summary: "Reviewed the planted change", findings: raised.map((c) => ({ severity: c.reviewSeverity, category: "security", confidence: 1, file_path: c.filePath, line_number: c.lineStart, title: c.ruleId, description: c.message, suggested_change: null, source: c.token, candidate: c.id })), dropped: candidates.filter((c) => !raised.includes(c)).map((c) => ({ candidate: c.id, reason: "Not actionable here" })) };
}
describe("review flow", () => {
  it("redacts the generated secret and finalizes two raised candidates", () => {
    const x = brief("review-valid");
    const secret = readFileSync(join(x.dir, "app/config.py"), "utf8").match(/sk_live_[A-Za-z0-9]{24}/)?.[0];
    expect(secret).toBeDefined();
    expect(x.result.stdout).toContain(x.changeId);
    expect(x.result.stdout).toContain("agent-findings.json");
    expect(x.candidates.some((c) => c.filePath === "app/config.py")).toBe(true);
    expect(x.candidates.some((c) => c.filePath === "app/search.py")).toBe(true);
    for (const file of readdirSync(x.path)) expect(readFileSync(join(x.path, file), "utf8")).not.toContain(secret);
    const raised = [x.candidates.find((c) => c.filePath === "app/config.py")!, x.candidates.find((c) => c.filePath === "app/search.py")!];
    writeFileSync(join(x.path, "agent-findings.json"), JSON.stringify(submission(x.changeId, x.candidates, raised)));
    const result = run("review-valid-finalize", x.dir, ["review", "--finalize", join(x.path, "agent-findings.json"), "--format", "json"]);
    expect(result.status).toBe(0);
    expect(report(x.dir)).toMatchObject({ kind: "review", not_reviewed: [] });
    expect(report(x.dir).findings).toHaveLength(2);
  }, 600_000);
  it("rejects a wrong change id", () => {
    const x = brief("review-wrong-id");
    writeFileSync(join(x.path, "agent-findings.json"), JSON.stringify(submission("wrong", x.candidates, [])));
    expect(run("review-wrong-id-finalize", x.dir, ["review", "--finalize"]).status).toBe(2);
  }, 600_000);
  it("names the invalid field in an agent submission", () => {
    const x = brief("review-invalid");
    writeFileSync(join(x.path, "agent-findings.json"), JSON.stringify({ ...submission(x.changeId, x.candidates, []), findings: [{ severity: "wrong" }] }));
    const result = run("review-invalid-finalize", x.dir, ["review", "--finalize"]);
    expect(result.status).toBe(2); expect(result.stderr).toContain("findings[0].severity");
  }, 600_000);
  it("preserves a candidate the agent did not raise or drop", () => {
    const x = brief("review-unresolved");
    const body = submission(x.changeId, x.candidates, []);
    body.dropped.shift();
    writeFileSync(join(x.path, "agent-findings.json"), JSON.stringify(body));
    expect(run("review-unresolved-finalize", x.dir, ["review", "--finalize"]).status).toBe(0);
    expect(report(x.dir).not_reviewed).toHaveLength(1);
  }, 600_000);
  it("rejects a changed file after the brief", () => {
    const x = brief("review-stale");
    writeFileSync(join(x.path, "agent-findings.json"), JSON.stringify(submission(x.changeId, x.candidates, [])));
    appendFileSync(join(x.dir, "app/search.py"), "\n# Changed after brief\n");
    expect(run("review-stale-finalize", x.dir, ["review", "--finalize"]).status).toBe(2);
  }, 600_000);
  it("blocks a critical finalized review", () => {
    const x = demo("review-blocked");
    writeFileSync(join(x, ".openqodex.yaml"), "review:\n  block_on_severity: critical\n");
    const b = run("review-blocked-brief", x, ["review", "--agent"]); expect(b.status).toBe(0);
    const path = reportDir(x); const candidates = JSON.parse(readFileSync(join(path, "candidates.json"), "utf8")) as Candidate[];
    const id = (JSON.parse(readFileSync(join(path, "manifest.json"), "utf8")) as { change_id: string }).change_id;
    const body = submission(id, candidates, []);
    body.findings.push({ severity: "critical", category: "security", confidence: 1, file_path: "app/config.py", line_number: 2, title: "Exposed credential", description: "The credential must be removed", suggested_change: null, source: null, candidate: null });
    writeFileSync(join(path, "agent-findings.json"), JSON.stringify(body));
    expect(run("review-blocked-finalize", x, ["review", "--finalize"]).status).toBe(1);
    expect(report(x).verdict).toBe("blocked");
  }, 600_000);
});
