// The benchmark's release check (benchmark/release-check.mjs): a published
// package against the build about to be released, on the same cases, with
// the real scanners, two passes each, compared case by case. Every build
// here is a real package: this checkout's own build, that build packed by
// npm pack, and packed copies of it with one change each.
//
// Failure list, written before the code:
// 1. A build whose scanner finds one fewer planted bug passes the check.
// 2. Two builds of the same code read as a change, so every release is
//    refused, or the check says nothing about what it compared.
// 3. A package that is missing, or a run that failed, reads as "no change",
//    and the release goes out unchecked.
// 4. A scanner one build pins at a version that is not installed is missing
//    from that build's scans only, and its bugs read as the product's loss.
// 5. A review the caller names and pays for is run but left out of the
//    verdict, or compared other than by loop/compare.mjs.
// 6. The published package's code runs with the caller's keys: its install
//    step and its scans get every variable of the check's environment, an
//    API key, an npm token, an Azure endpoint and its key included.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "./global-setup.js";
import { root, rustHome, skipNetwork, toolsHome } from "./support.js";
import { removeTempDirs, tempDir } from "../temp-dirs.mjs";

afterAll(removeTempDirs);

type Result = { status: number | null; stdout: string; stderr: string };
type Verdict = { verdict: string; exitCode: number; losses: string[]; gains: string[]; changes: string[]; notes: string[] };

// One planted case that only squawk checks, so each scan takes seconds.
const CASE = "postgres-migration-locks";

// The packages are unpacked into one cache of this file's own.
let cache = "";
const packages: Record<string, string> = {};

// release-check.mjs as a person starts it: the shared scanner tools as the
// developer's warm OpenQodex home, a throwaway HOME and temp folder.
function check(args: string[], env: NodeJS.ProcessEnv = {}): Result {
  const p = spawnSync(process.execPath, [join(root, "benchmark/release-check.mjs"), ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 900_000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, HOME: tempDir("oq-release-user-"), TMPDIR: tempDir("oq-release-tmp-"), OPENQODEX_HOME: toolsHome, OPENQODEX_BENCH_CACHE: cache, OPENQODEX_AUTO_UPDATE: "0", ...rustHome(), ...env },
  });
  return { status: p.status, stdout: p.stdout ?? "", stderr: p.stderr ?? String(p.error ?? "") };
}

const readJson = <T = any>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

// packages/cli as npm packs it, after `edit` changes the staged copy.
function pack(name: string, edit?: (dir: string) => void): string {
  const pkg = readJson<{ files: string[] }>(join(root, "packages/cli/package.json"));
  const dir = join(tempDir(`oq-release-${name}-`), "package");
  mkdirSync(dir, { recursive: true });
  for (const f of ["package.json", ...pkg.files]) if (existsSync(join(root, "packages/cli", f))) cpSync(join(root, "packages/cli", f), join(dir, f), { recursive: true });
  edit?.(dir);
  const out = tempDir(`oq-release-${name}-tgz-`);
  const p = spawnSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", out], { cwd: dir, encoding: "utf8", env: { ...process.env, HOME: tempDir("oq-release-npm-"), npm_config_cache: tempDir("oq-release-npm-cache-") } });
  if (p.status !== 0) throw new Error(`npm pack exited ${p.status}: ${p.stderr}`);
  return join(out, JSON.parse(p.stdout)[0].filename);
}

beforeAll(() => {
  // --candidate local is the build benchmark/build-cli.mjs recorded.
  const p = spawnSync(process.execPath, [join(root, "benchmark/build-cli.mjs")], { cwd: root, encoding: "utf8", timeout: 600_000 });
  if (p.status !== 0) throw new Error(`benchmark/build-cli.mjs exited ${p.status}: ${p.stderr}`);
  cache = tempDir("oq-release-cache-");
  packages.same = pack("same");
  // A scratch build whose squawk config leaves out the rule that finds the
  // index built without CONCURRENTLY: one fewer planted bug found.
  packages.regressed = pack("regressed", (dir) => {
    const file = join(dir, "dist/bin.js");
    const text = readFileSync(file, "utf8");
    const owned = /(withOwnedConfig\(\w+\.scratch\.temp, SQUAWK_CONFIG, )""/g;
    const hits = text.match(owned)?.length ?? 0;
    if (hits !== 1) throw new Error(`the squawk adapter's owned config appears ${hits} times in dist/bin.js; the crafted regression needs it once`);
    writeFileSync(file, text.replace(owned, `$1${JSON.stringify('excluded_rules = ["require-concurrent-index-creation"]\n')}`));
  });
  // A scratch build that writes the environment it was given to a file in
  // HOME each time it starts, and then works as before.
  packages.recorder = pack("recorder", (dir) => {
    const file = join(dir, "dist/bin.js");
    const [shebang, ...rest] = readFileSync(file, "utf8").split("\n");
    const record = 'import { writeFileSync as __oqRecord } from "node:fs";\n__oqRecord(`${process.env.HOME}/oq-env-${process.argv.slice(2, 4).join("_")}-${process.pid}.json`, JSON.stringify(process.env));';
    writeFileSync(file, [shebang, record, ...rest].join("\n"));
  });
  // A scratch build that pins squawk at a version nobody installed.
  packages.repinned = pack("repinned", (dir) => {
    const file = join(dir, "toolchain.json");
    const table = readJson(file);
    table.tools.squawk.version = "0.0.1";
    writeFileSync(file, `${JSON.stringify(table, null, 2)}\n`);
  });
}, 900_000);

describe.skipIf(skipNetwork("release check (semgrep rule packs, osv.dev)"))("the release check on real packages", () => {
  it("refuses a build whose scanner finds one fewer planted bug, naming the bug it lost", () => {
    const out = join(tempDir("oq-release-run-"), "check");
    const r = check(["--base", "local", "--candidate", `file:${packages.regressed}`, "--suites", "planted", "--cases", CASE, "--allow-missing-scanners", "--out", out]);
    expect(r.status, r.stderr).toBe(1);
    const v = readJson<Verdict>(join(out, "release-check.json"));
    expect(v).toMatchObject({ verdict: "loss", exitCode: 1 });
    expect(v.losses).toEqual([expect.stringMatching(/postgres-migration-locks@[0-9a-f]{8} index-without-concurrently, major: found by the base, missed by the candidate/)]);
    const report = readFileSync(join(out, "release-check.md"), "utf8");
    expect(report).toMatch(/index-without-concurrently/);
    expect(report).not.toMatch(/no change/i);
    expect(r.stdout).toMatch(/index-without-concurrently/);
    // Both builds ran twice, and each pair of passes was identical.
    for (const side of ["base", "candidate"]) expect(readJson(join(out, `planted-scan-${side}`, "identical.json")).identical).toBe(true);
  });

  it("reads two builds of the same code as no change and says what it compared", () => {
    const out = join(tempDir("oq-release-run-"), "check");
    const r = check(["--base", "local", "--candidate", `file:${packages.same}`, "--suites", "planted", "--cases", CASE, "--allow-missing-scanners", "--out", out]);
    expect(r.status, r.stderr).toBe(0);
    const v = readJson<Verdict>(join(out, "release-check.json"));
    expect(v).toMatchObject({ verdict: "no change", exitCode: 0, losses: [], gains: [], changes: [] });
    const report = readFileSync(join(out, "release-check.md"), "utf8");
    expect(report).toMatch(/Verdict: no change/);
    expect(report).toMatch(/- planted: 1 case, scanner-only, two identical passes per build/);
    // The scanners that ran on neither side are named, so a reader knows what was not compared.
    const missing = readJson<{ scannersMissing: { scanner: string }[] }>(join(out, "planted-scan-base", "manifest.json")).scannersMissing.map((m) => m.scanner);
    if (missing.length > 0) expect(report).toMatch(new RegExp(`not compared: ${missing.join(", ")}`));
  });

  it("refuses to compare when a scanner is missing from one build only, rather than read its bugs as lost", () => {
    const out = join(tempDir("oq-release-run-"), "check");
    const r = check(["--base", "local", "--candidate", `file:${packages.repinned}`, "--suites", "planted", "--cases", CASE, "--allow-missing-scanners", "--out", out]);
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/squawk/);
    expect(r.stdout + r.stderr).not.toMatch(/no change/i);
    expect(readJson<Verdict>(join(out, "release-check.json"))).toMatchObject({ verdict: "could not run", exitCode: 2 });
  });

  it("puts a paid review on both builds through loop/compare.mjs and into the verdict", () => {
    const out = join(tempDir("oq-release-run-"), "check");
    const r = check(["--base", "local", "--candidate", `file:${packages.same}`, "--suites", "planted", "--cases", CASE, "--allow-missing-scanners", "--reviewers", "model:scripted", "--repeat", "1", "--max-usd", "1", "--max-minutes", "20", "--review-max-usd", "1", "--out", out]);
    expect(r.status, r.stderr).toBe(0);
    for (const side of ["base", "candidate"]) expect(readJson(join(out, `planted-review-${side}`, "manifest.json")).ended.how).toBe("finished");
    const report = readFileSync(join(out, "release-check.md"), "utf8");
    // compare.mjs's own table, for the scripted model's cell.
    expect(report).toMatch(/server path, model:scripted/);
    expect(report).toMatch(/\| Metric \| Parent \| Candidate \|/);
    expect(readJson<Verdict>(join(out, "release-check.json")).losses).toEqual([]);
  });
});

describe.skipIf(skipNetwork("release check (scanner installs, semgrep rule packs)"))("the published package's code runs with the caller's keys", () => {
  it("gives the install step and the scans of a package no key, token or Azure variable of the caller", () => {
    const home = tempDir("oq-release-user-");
    const secrets = { OPENAI_API_KEY: "sk-release-check-openai", NPM_TOKEN: "npm_release-check-token", NODE_AUTH_TOKEN: "npm_release-check-auth", AZURE_OPENAI_API_KEY: "release-check-azure-key", AZURE_OPENAI_ENDPOINT: "https://release-check.openai.azure.com/", ANTHROPIC_API_KEY: "sk-ant-release-check" };
    const out = join(tempDir("oq-release-run-"), "check");
    const r = check(["--base", "local", "--candidate", `file:${packages.recorder}`, "--suites", "planted", "--cases", CASE, "--allow-missing-scanners", "--install-scanners", "--out", out], { HOME: home, ...secrets });
    expect(r.status, r.stderr).toBe(0);
    const records = readdirSync(home).filter((f) => f.startsWith("oq-env-"));
    // The install step and the scans each started the package's CLI.
    expect(records.some((f) => f.startsWith("oq-env-doctor_--install-"))).toBe(true);
    expect(records.some((f) => f.startsWith("oq-env-scan_"))).toBe(true);
    for (const f of records) {
      const text = readFileSync(join(home, f), "utf8");
      for (const [name, value] of Object.entries(secrets)) {
        expect(text, `${f} holds ${name}`).not.toContain(value);
        expect(Object.keys(JSON.parse(text)), f).not.toContain(name);
      }
      expect(JSON.parse(text), f).toMatchObject({ HOME: home, PATH: expect.any(String) });
    }
  });
});

describe("a missing package or a failed run reads as no change", () => {
  it("exits 2 for a package that is not there, and never writes no change", () => {
    const out = join(tempDir("oq-release-run-"), "check");
    const r = check(["--base", `file:${join(tempDir("oq-release-none-"), "openqodex-0.0.0.tgz")}`, "--candidate", "local", "--suites", "planted", "--cases", CASE, "--allow-missing-scanners", "--out", out]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/there is no file/);
    expect(r.stdout + r.stderr).not.toMatch(/no change/i);
    const v = readJson<Verdict>(join(out, "release-check.json"));
    expect(v).toMatchObject({ verdict: "could not run", exitCode: 2 });
    expect(readFileSync(join(out, "release-check.md"), "utf8")).not.toMatch(/no change/i);
  });

  it("exits 2 when a run fails (no scanner installed), and never writes no change", () => {
    const cold = tempDir("oq-release-cold-home-");
    mkdirSync(join(cold, "tools"), { recursive: true });
    const out = join(tempDir("oq-release-run-"), "check");
    const r = check(["--base", "local", "--candidate", `file:${packages.same}`, "--suites", "planted", "--cases", CASE, "--out", out], { OPENQODEX_HOME: cold });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--allow-missing-scanners/);
    expect(r.stdout + r.stderr).not.toMatch(/no change/i);
    expect(readJson<Verdict>(join(out, "release-check.json"))).toMatchObject({ verdict: "could not run", exitCode: 2 });
  });
});
