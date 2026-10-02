import { beforeAll, describe, expect, it } from "vitest";
import "./global-setup.js";
import { demo, report, run, writeConfig } from "./support.js";

// Scanner severities top out at high, shown as major, so major is the
// threshold a scan can meet. The critical case is the finalized review's.
describe("scan with block_on_severity: major", () => {
  let dir: string; let blockedStatus: number | null; let blocking: string[];
  beforeAll(() => {
    dir = demo("block");
    writeConfig(dir, "review:\n  block_on_severity: major\n");
    blockedStatus = run("block-major", dir, ["scan", "--format", "json"]).status;
    blocking = [...new Set(report(dir).findings.filter((f) => f.severity === "major").map((f) => f.source!))];
  }, 300_000);

  it("exits 1 when a finding is at the threshold", () => {
    expect(blocking.length).toBeGreaterThan(0);
    expect(blockedStatus).toBe(1);
  });
  // Cross-scanner dedup keeps one finding per issue, so disabling the kept
  // citation can bring its duplicate back (semgrep's secret rule hides
  // gitleaks'). Each round disables what still blocks, at most three rounds.
  it("exits 0 once disabled_rules covers every blocking finding's citation", () => {
    const disabled = [...blocking];
    let status: number | null = null;
    for (let round = 1; round <= 3; round++) {
      writeConfig(dir, `review:\n  block_on_severity: major\n  disabled_rules:\n${disabled.map((t) => `    - ${JSON.stringify(t)}`).join("\n")}\n`);
      status = run(`block-disabled-${round}`, dir, ["scan", "--format", "json"]).status;
      const found = report(dir).findings;
      expect(found.filter((f) => disabled.includes(f.source!)).map((f) => f.source)).toEqual([]);
      const still = found.filter((f) => f.severity === "major").map((f) => f.source!);
      if (still.length === 0) break;
      disabled.push(...still);
    }
    expect(status).toBe(0);
  });
});
