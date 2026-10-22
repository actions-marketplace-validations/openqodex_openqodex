// Failure cases, written before the implementation: an old advisory blocks
// a clean edit or reaches the brief; a bumped pin is listed twice; fixtures
// or disabled scanners still show advisories; links enter the inventory.
// A leading-dash folder loses its outside entries; an oversized nested
// lockfile inherits the changed root lockfile's identity and becomes a candidate.
// Exhausting the aggregate line-mapping budget loses the remaining advisories.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Report, ScanResult } from "@openqodex/core";

const bin = new URL("../../packages/cli/dist/bin.js", import.meta.url).pathname;
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const lock = (version: string) => JSON.stringify({ name: "tiny", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "tiny", version: "1.0.0" }, "node_modules/lodash": { version } } }, null, 2) + "\n";
function repo(file = "package-lock.json", version = "4.17.15", paddingMb = 0) {
  const root = mkdtempSync(join(tmpdir(), "oq-dependency-tree-")); roots.push(root);
  mkdirSync(join(root, "src")); mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), lock(version));
  for (let i = 0; i < paddingMb; i++) appendFileSync(join(root, file), " ".repeat(1024 * 1024));
  writeFileSync(join(root, "src/app.js"), "export const value = 1;\n");
  writeFileSync(join(root, ".gitignore"), "output/\n.openqodex/\n");
  writeFileSync(join(root, ".openqodex.yaml"), "version: 1\ngraph:\n  enabled: false\n");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@openqodex.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: root });
  git("init", "-q"); git("add", "."); git("commit", "-qm", "Baseline");
  writeFileSync(join(root, "src/app.js"), "export const value = 2;\n");
  return root;
}
function command(root: string, args: string[]) {
  return spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: "utf8", timeout: 180_000, env: { ...process.env, OPENQODEX_HOME: process.env.OPENQODEX_E2E_HOME ?? process.env.OPENQODEX_HOME, OPENQODEX_AUTO_UPDATE: "0" } });
}
function scan(root: string, extra: string[] = []) {
  const output = join(root, "output");
  const result = command(root, ["scan", "--only", "osv-scanner", "--report-dir", output, "--config", join(root, ".openqodex.yaml"), ...extra]);
  expect(result.status, result.stderr).toBe(0);
  return { report: JSON.parse(readFileSync(join(output, "report.json"), "utf8")) as Report, scan: JSON.parse(readFileSync(join(output, "scan.json"), "utf8")) as ScanResult };
}
describe("dependency tree", () => {
  it("shows an old vulnerable pin without counting it or briefing the reviewer", () => {
    const root = repo();
    const { report, scan: result } = scan(root);
    const advisory = report.outside_change.find((f) => f.title === "GHSA-35jh-r3h4-6jhm");
    expect(advisory).toMatchObject({ origin: "scanner", description: expect.stringMatching(/lodash@4.17.15:.*Fixed in 4.17.21$/), notes: ["In the tree before this change."] });
    expect(report.findings).toEqual([]); expect(report.verdict).toBe("passed"); expect(result.candidates).toEqual([]);
    expect(result.trail?.filter((t) => t.stage === "shown")).toHaveLength(report.outside_change.length);
    expect(scan(root, ["--block-on-severity", "minor"]).report.verdict).toBe("passed");
    const review = command(root, ["review", "--agent", "--only", "osv-scanner"]);
    expect(review.status, review.stderr).toBe(0);
    const receipt = JSON.parse(readFileSync(join(root, ".openqodex/latest.json"), "utf8"));
    for (const name of ["brief.md", "candidates.json"]) {
      const file = join(root, receipt.dir, name);
      if (existsSync(file)) expect(readFileSync(file, "utf8")).not.toContain(advisory!.title);
    }
  });
  it("keeps a bumped vulnerable pin as a candidate and never lists it twice", () => {
    const root = repo("package-lock.json", "4.17.14");
    writeFileSync(join(root, "package-lock.json"), lock("4.17.15"));
    const { report, scan: result } = scan(root);
    expect(result.candidates.some((c) => c.ruleId === "GHSA-35jh-r3h4-6jhm")).toBe(true);
    expect(report.findings.some((f) => f.title === "GHSA-35jh-r3h4-6jhm")).toBe(true);
    expect(report.outside_change).toEqual([]);
  });
  it("shows an untouched lockfile under a leading-dash folder", () => {
    const file = "-deps/package-lock.json";
    const { report, scan: result } = scan(repo(file));
    expect(result.candidates).toEqual([]);
    expect(result.outside).toContainEqual(expect.objectContaining({ filePath: file, ruleId: "GHSA-35jh-r3h4-6jhm" }));
    expect(report.outside_change).toContainEqual(expect.objectContaining({ file_path: file, title: "GHSA-35jh-r3h4-6jhm" }));
  });
  it("keeps an oversized nested lockfile outside the change beside a changed root lockfile", () => {
    const file = "service/package-lock.json";
    // Valid JSON with trailing whitespace exceeds the adapter's 50 MB cap,
    // but remains a lockfile the real scanner can extract.
    const root = repo(file, "4.17.15", 50);
    writeFileSync(join(root, "package-lock.json"), lock("4.17.15"));
    const { report, scan: result } = scan(root);
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates.every((c) => c.filePath === "package-lock.json")).toBe(true);
    expect(result.outside).toContainEqual(expect.objectContaining({ filePath: file, lineStart: 1, lineEnd: 1, ruleId: "GHSA-35jh-r3h4-6jhm" }));
    expect(report.outside_change).toContainEqual(expect.objectContaining({ file_path: file, title: "GHSA-35jh-r3h4-6jhm" }));
    expect(readFileSync(join(root, "output/report.sarif"), "utf8")).not.toContain(file);
  });
  it("shows advisories at line 1 after the aggregate tree text budget is exhausted", () => {
    const root = repo();
    const paths = ["tree1/package-lock.json", "tree2/package-lock.json", "tree3/package-lock.json"];
    for (const file of paths) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), lock("4.17.15"));
      for (let i = 0; i < 24; i++) appendFileSync(join(root, file), " ".repeat(1024 * 1024));
    }
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@openqodex.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: root });
    git("add", "--", ...paths);
    git("commit", "-qm", "Add tree lockfiles");
    const { report, scan: result } = scan(root);
    expect(result.candidates).toEqual([]);
    for (const file of paths) expect(report.outside_change).toContainEqual(expect.objectContaining({ file_path: file, title: "GHSA-35jh-r3h4-6jhm" }));
    expect(result.outside?.some((f) => f.filePath === paths[0] && f.lineStart > 1)).toBe(true);
    expect(result.outside).toContainEqual(expect.objectContaining({ filePath: paths[2], lineStart: 1, lineEnd: 1 }));
  });
  it("drops a lockfile under test fixtures", () => {
    const { report, scan: result } = scan(repo("test/fixtures/package-lock.json"));
    expect(report.outside_change).toEqual([]);
    expect(result.fixturesDropped).toBe(0);
    expect(result.trail).toContainEqual(expect.objectContaining({ token: "osv-scanner:GHSA-35jh-r3h4-6jhm", stage: "fixture" }));
  });
  it("records a disabled dependency scanner and lists nothing", () => {
    const root = repo();
    writeFileSync(join(root, ".openqodex.yaml"), "version: 1\nscanners:\n  disable: [osv-scanner]\n");
    const { report } = scan(root);
    expect(report.outside_change).toEqual([]); expect(report.findings).toEqual([]);
    expect(report.scanners).toContainEqual(expect.objectContaining({ scanner: "osv-scanner", status: "disabled" }));
  });
  it("refuses an inventory lockfile reached through a link", () => {
    const root = repo("pins/package-lock.json");
    symlinkSync("pins/package-lock.json", join(root, "package-lock.json"));
    const { scan: result } = scan(root);
    expect(result.selection?.find((s) => s.scanner === "osv-scanner")?.paths).toEqual(["pins/package-lock.json"]);
    expect(result.scanners[0]?.reason).toContain("not a regular file");
  });
  it("drops disabled advisory rules without applying the verdict severity floor", () => {
    const root = repo();
    writeFileSync(join(root, ".openqodex.yaml"), "version: 1\nreview:\n  severity_threshold: critical\n  disabled_rules: ['osv-scanner:GHSA-35jh-r3h4-6jhm']\n");
    const { report } = scan(root);
    expect(report.outside_change.length).toBeGreaterThan(0);
    expect(report.outside_change.some((f) => f.title === "GHSA-35jh-r3h4-6jhm")).toBe(false);
  });
});
