import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import "./global-setup.js";
import { demo, git, inventory, receipt, report, reportDir, root, run, skipNetwork } from "./support.js";

const expected = JSON.parse(readFileSync(join(root, "examples/demo-repo/expected.json"), "utf8")) as { bugs: { id: string; file: string; lines: [number, number]; detectors: { scanner: string; rule_id: string }[] | null }[] };

describe("demo scan", () => {
  it("reports planted scanner bugs on changed lines without editing source files", () => {
    const dir = demo("main-demo");
    const beforeStatus = git(dir, "status", "--porcelain");
    const beforeFiles = inventory(dir);
    const scanned = run("main-demo-scan", dir, ["scan", "--format", "json"], { timeout: 300_000 });
    expect(scanned.status).toBe(0);
    const found = report(dir);
    expect(found.kind).toBe("scan");
    expect(found.scanners).toHaveLength(13);
    for (const bug of expected.bugs) {
      // The Docker root rule anchors to an unchanged line; the change filter drops it.
      if (bug.id === "docker-root" || bug.detectors === null) continue;
      for (const detector of bug.detectors) {
        if (["semgrep", "osv-scanner"].includes(detector.scanner) && skipNetwork(detector.scanner)) continue;
        const status = found.scanners.find((s) => s.scanner === detector.scanner);
        expect(status).toBeDefined();
        if (status?.status === "not_installed" && /Ruby|Go/.test(status.reason ?? "")) {
          process.stdout.write(`${detector.scanner}: ${status.reason}\n`); continue;
        }
        expect(status?.status).toBe("ran");
        expect(found.findings.some((f) => f.source === `${detector.scanner}:${detector.rule_id}` && f.file_path === bug.file && f.line_number <= bug.lines[1] && f.line_end >= bug.lines[0])).toBe(true);
      }
    }
    const touched = new Set(Object.keys(beforeFiles).filter((p) => !p.startsWith(".openqodex/")));
    expect(found.findings.every((f) => touched.has(f.file_path))).toBe(true);
    expect(git(dir, "status", "--porcelain")).toBe(beforeStatus);
    expect(inventory(dir)).toEqual(beforeFiles);
    const out = reportDir(dir);
    for (const name of ["report.json", "report.md", "report.sarif"]) cpSync(join(out, name), join(receipt, "main-demo-scan", name));
    writeFileSync(join(receipt, "main-demo-scan", "terminal.txt"), run("main-demo-terminal", dir, ["scan"]).stdout);
  }, 600_000);
});
