// review --finalize checks the agent's findings without a model. Each case is a
// submission it must reject or a run it must bind to.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import "./global-setup.js";
import { demo, readBrief, readJson, report, run, submission, writeConfig } from "./support.js";
import type { Brief } from "./support.js";
import type { Report } from "@openqodex/core";

function brief(label: string, dir: string): Brief {
  const r = run(label, dir, ["review", "--agent"]);
  if (r.status !== 0) throw new Error(`review --agent exited ${r.status}: ${r.stderr}`);
  return readBrief(dir);
}
const write = (b: Brief, body: unknown) => writeFileSync(join(b.path, "agent-findings.json"), JSON.stringify(body));

describe("review --finalize", () => {
  // One demo repo, in order: two briefs of the same change (older, newer), the
  // rejections, finalizing the older run by its path, and last the stale edit.
  let dir: string; let older: Brief; let newer: Brief;
  beforeAll(() => {
    dir = demo("finalize");
    older = brief("finalize-brief-older", dir);
    newer = brief("finalize-brief-newer", dir);
  }, 300_000);

  it("rejects findings written for another change id", () => {
    write(newer, submission("0".repeat(64), newer.candidates, []));
    expect(run("finalize-wrong-id", dir, ["review", "--finalize"]).status).toBe(2);
  });
  it("rejects an invalid submission and names the bad field", () => {
    write(newer, { ...submission(newer.changeId, newer.candidates, []), findings: [{ severity: "wrong" }] });
    const r = run("finalize-invalid", dir, ["review", "--finalize"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("findings[0].severity");
  });
  describe("given the findings path of an older run", () => {
    let result: number | null;
    beforeAll(() => {
      const body = submission(older.changeId, older.candidates, []);
      body.dropped.shift();
      write(older, body);
      result = run("finalize-older-run", dir, ["review", "--finalize", join(older.path, "agent-findings.json")]).status;
    });
    it("finalizes that run, not the newest one", () => {
      expect(result).toBe(0);
      expect(readJson<Report>(join(older.path, "report.json")).kind).toBe("review");
      expect(existsSync(join(newer.path, "report.json"))).toBe(false);
    });
    it("keeps a candidate the agent neither raised nor dropped as not reviewed", () => {
      expect(readJson<Report>(join(older.path, "report.json")).not_reviewed).toHaveLength(1);
    });
  });
  it("rejects findings when a file changed after the brief", () => {
    write(newer, submission(newer.changeId, newer.candidates, []));
    appendFileSync(join(dir, "app/search.py"), "\n# Changed after the brief\n");
    expect(run("finalize-stale", dir, ["review", "--finalize", join(newer.path, "agent-findings.json")]).status).toBe(2);
  });
});

it("exits 1 with verdict blocked when the agent raises a critical finding and block_on_severity is critical", () => {
  const dir = demo("finalize-blocked");
  writeConfig(dir, "review:\n  block_on_severity: critical\n");
  const b = brief("finalize-blocked-brief", dir);
  const body = submission(b.changeId, b.candidates, []);
  body.findings.push({ severity: "critical", category: "security", confidence: 1, file_path: "app/config.py", line_number: 2, title: "Exposed credential", description: "The credential must be removed", suggested_change: null, source: null, candidate: null });
  write(b, body);
  expect(run("finalize-blocked", dir, ["review", "--finalize"]).status).toBe(1);
  expect(report(dir).verdict).toBe("blocked");
}, 300_000);
