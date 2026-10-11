// The scanner-only benchmark run (benchmark/run.mjs --mode scan) with the
// built CLI and the real scanner binaries on the frozen planted cases: two
// passes on one build must be identical, a difference between them must be
// caught, and a scanner from a --scanner-config overlay must run only after
// the run's own `openqodex trust`. The overlay scanners are real shell
// scripts run as real processes, the way a developer's custom scanner runs.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "./global-setup.js";
import { root, rustHome, skipNetwork, toolsHome } from "./support.js";
import { removeTempDirs, tempDir } from "../temp-dirs.mjs";

afterAll(removeTempDirs);

type Result = { status: number | null; stdout: string; stderr: string };

// run.mjs as a developer starts it, with the shared scanner tools as the
// developer's warm OpenQodex home, a throwaway HOME, and a temp folder of
// this file's own for the case repositories and the run's own home, which
// run.mjs keeps for inspection.
function bench(args: string[], env: NodeJS.ProcessEnv = {}): Result {
  const p = spawnSync(process.execPath, [join(root, "benchmark/run.mjs"), ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, HOME: tempDir("oq-bench-user-"), TMPDIR: tempDir("oq-bench-tmp-"), OPENQODEX_HOME: toolsHome, OPENQODEX_AUTO_UPDATE: "0", ...rustHome(), ...env },
  });
  return { status: p.status, stdout: p.stdout ?? "", stderr: p.stderr ?? String(p.error ?? "") };
}

const readJson = <T = any>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const sarif = (message: string) => JSON.stringify({ version: "2.1.0", runs: [{ tool: { driver: { name: "overlay" } }, results: [{ ruleId: "overlay-rule", message: { text: message }, locations: [{ physicalLocation: { artifactLocation: { uri: "files/app.py" }, region: { startLine: 24 } } }] }] }] });

// A custom scanner on PATH, and the overlay that names it.
function overlay(name: string, body: string): { config: string; bin: string } {
  const bin = tempDir("oq-bench-bin-");
  const script = join(bin, name);
  writeFileSync(script, `#!/bin/sh\n${body}\n`);
  chmodSync(script, 0o755);
  const config = join(tempDir("oq-bench-overlay-"), "overlay.yaml");
  writeFileSync(config, `version: 1\nscanners:\n  custom:\n    - source: https://github.com/openqodex/${name}\n      name: ${name}\n      run: ${name}\n      install: path\n      paths: ["**/*.py", "*.py"]\n`);
  return { config, bin };
}

beforeAll(() => {
  // The run refuses a bundle benchmark/build-cli.mjs did not record.
  const p = spawnSync(process.execPath, [join(root, "benchmark/build-cli.mjs")], { cwd: root, encoding: "utf8", timeout: 600_000 });
  if (p.status !== 0) throw new Error(`benchmark/build-cli.mjs exited ${p.status}: ${p.stderr}`);
}, 600_000);

describe.skipIf(skipNetwork("scanner-only benchmark (semgrep rule packs, osv.dev)"))("two scanner-only runs differ and nobody notices", () => {
  it("scans the planted cases twice on one build, with identical scores and samples, and records the inputs and the time of each pass", () => {
    const out = join(tempDir("oq-bench-scan-"), "run");
    const r = bench(["--mode", "scan", "--cases", "demo-polyglot,flask-path-traversal", "--check-identical", "--allow-missing-scanners", "--out", out]);
    expect(r.status, r.stderr).toBe(0);
    const identical = readJson(join(out, "identical.json"));
    expect(identical).toMatchObject({ identical: true, cause: null, differences: [] });
    for (const folder of [out, `${out}-pass2`]) {
      const m = readJson(join(folder, "manifest.json"));
      expect(m).toMatchObject({ mode: "scan", configs: ["scan"], toolsHome: "warm", scannerOverlay: null });
      expect(m.ended.how).toBe("finished");
      expect(typeof m.ended.elapsedMin).toBe("number");
      expect(m.external.toolchainHash).toMatch(/^[0-9a-f]{64}$/);
      expect(m.external.semgrepPacks.map((p: { pack: string }) => p.pack)).toEqual(["p/default", "p/secrets", "p/security-audit"]);
      expect(m.external.osvAdvisories.advisories).toBeGreaterThan(0);
      expect(typeof m.scannersComplete).toBe("boolean");
    }
    expect(identical.passes.map((p: { elapsedMin: number }) => typeof p.elapsedMin)).toEqual(["number", "number"]);
    // The expected scanner's own candidate counts without the spec's words.
    const score = readJson(join(out, "score.json"));
    expect(score.mode).toBe("scan");
    const caseId = Object.keys(score.perBug.scan).find((id) => id.startsWith("planted/demo-polyglot@"))!;
    expect(score.perBug.scan[caseId]["shell-rm-unquoted"].found).toEqual([true]);
    const outcomes = readFileSync(join(out, "outcomes.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const shell = outcomes.filter((o) => o.caseId === caseId && o.token.startsWith("shellcheck:SC2115"));
    expect(shell.map((o) => [o.outcome, o.evidence])).toEqual([["hit", "finder"]]);
  });

  it("catches a scanner whose output changes between the two passes and exits 3, naming it a product difference", () => {
    // Each call reports the same line with a message that counts the calls.
    const flaky = ['n=$(cat "$(dirname "$0")/count" 2>/dev/null || echo 0)', "n=$((n + 1))", 'echo "$n" > "$(dirname "$0")/count"', "cat <<EOF", sarif("call $n"), "EOF"].join("\n");
    const { config, bin } = overlay("flaky-check", flaky);
    const out = join(tempDir("oq-bench-scan-"), "run");
    const r = bench(["--mode", "scan", "--cases", "flask-path-traversal", "--check-identical", "--allow-missing-scanners", "--scanner-config", config, "--out", out], { PATH: `${bin}:${process.env.PATH}` });
    expect(r.status, r.stderr).toBe(3);
    const identical = readJson(join(out, "identical.json"));
    expect(identical).toMatchObject({ identical: false, cause: "product" });
    expect(identical.differences.join("\n")).toMatch(/samples\/flask-path-traversal\/scan\/1\/report\/scan\.json/);
    expect(r.stderr).toMatch(/not identical/);
  });
});

describe("an overlay scanner runs without the trust step", () => {
  it("runs the overlay's scanner after the run's own trust step, in the run's own home, and records what was approved", () => {
    const { config, bin } = overlay("overlay-check", ["cat <<'EOF'", sarif("overlay finding"), "EOF"].join("\n"));
    const trustFile = join(toolsHome, "trust.json");
    const before = existsSync(trustFile) ? readFileSync(trustFile, "utf8") : null;
    const out = join(tempDir("oq-bench-scan-"), "run");
    const r = bench(["--mode", "scan", "--cases", "flask-path-traversal", "--allow-missing-scanners", "--scanner-config", config, "--out", out], { PATH: `${bin}:${process.env.PATH}` });
    expect(r.status, r.stderr).toBe(0);
    const scan = readJson(join(out, "samples/flask-path-traversal/scan/1/report/scan.json"));
    expect(scan.scanners.find((s: { scanner: string }) => s.scanner === "custom:overlay-check")).toMatchObject({ status: "ran" });
    expect(scan.candidates.map((c: { token: string }) => c.token)).toContain("custom:overlay-check:overlay-rule");
    const m = readJson(join(out, "manifest.json"));
    expect(m.scannerOverlay.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.scannerOverlay.trusted).toEqual([expect.objectContaining({ name: "overlay-check", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })]);
    // The developer's own approvals are untouched.
    expect(existsSync(trustFile) ? readFileSync(trustFile, "utf8") : null).toBe(before);
  });

  it("scans nothing when the trust step fails", () => {
    const { config } = overlay("missing-check", "exit 0");
    const out = join(tempDir("oq-bench-scan-"), "run");
    // The script's folder is not on PATH, so trust cannot find the program.
    const r = bench(["--mode", "scan", "--cases", "flask-path-traversal", "--allow-missing-scanners", "--scanner-config", config, "--out", out]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/openqodex trust/);
    expect(existsSync(join(out, "samples"))).toBe(false);
  });
});

describe("a scanner-only run on a machine without some scanners is taken as complete", () => {
  it("refuses without --allow-missing-scanners and names each missing scanner", () => {
    const empty = tempDir("oq-bench-cold-home-");
    mkdirSync(join(empty, "tools"), { recursive: true });
    const out = join(tempDir("oq-bench-scan-"), "run");
    const r = bench(["--mode", "scan", "--cases", "flask-path-traversal", "--out", out], { OPENQODEX_HOME: empty });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--allow-missing-scanners/);
    expect(r.stderr).toMatch(/semgrep/);
    expect(existsSync(join(out, "samples"))).toBe(false);
  });
});
