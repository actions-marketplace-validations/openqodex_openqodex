// The reviewer loop's driver (benchmark/loop.mjs) with its stage rules
// (loop/stages.mjs) and its ledger (loop/ledger.mjs). Each failure is
// guarded end to end: the driver is run as a person runs it, it invokes
// run.mjs, and run.mjs reviews with the scripted model, the only stand-in.
// The scripted model's script carries prices, so every review costs what a
// real model at those prices would cost, and the budget ledger, the daily
// cap and the spend in the reviewer ledger are the real ones.
//
// The checkout the driver runs is a clone of this repository at HEAD with
// the built CLI copied in and its provenance recorded, as
// benchmark/build-cli.mjs records it, so run.mjs runs the build it checks.
// Its runs read an empty scanner folder, so no scanner runs: these tests
// prove the driver, not the reviews.
//
// Failures guarded, written before the code:
// 1. An iteration behind after stage 1 spends through stage 3: a candidate
//    worse than its parent at stage 1 must stop there, with its look and
//    what it spent in the ledger, and no later step may run anything.
// 2. The loop reads a test-split run: a held-out run named as a parent or a
//    candidate must be refused before a sample of it is read, with nothing
//    run and nothing written.
// 3. Two iterations take one look number: two changes deciding at once must
//    take looks 1 and 2, each with its own alpha.
// 4. The daily cap is exceeded by a stage 2 decision that was forecast
//    under it: the room left of the day's 60 server dollars must bind the
//    run as a hard cap, so the day's spend stays inside it whatever the
//    forecast said.
// 5. A lever is chosen after the earliest-failure signal said stop: while
//    the last baseline's signal says stop, or no baseline carries one,
//    neither a proposal nor a step goes through.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repoRoot } from "../lib/cases.mjs";
import { bundleHash, treeState } from "../lib/runner.mjs";
import { ruleHash } from "../loop/decide.mjs";
import { lockLedger } from "../loop/propose.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const LOOP = fileURLToPath(new URL("../loop.mjs", import.meta.url));
const CASE = "flask-path-traversal";
const LOSSES = { recall: 2, criticalMajorRecall: 2, precision: 2, severityAgreement: 3, incompleteRate: 2, redundancy: 5, cleanFindings: 0.1, costPerReview: 0.15, secondsPerReview: 0.2 };
// A review answers in one call of 27 output tokens; at 500 dollars per
// million output tokens it costs $0.0135. A call's worst case is its 30
// token allowance, $0.015, which one review's $0.02 cap holds.
const SCRIPT = { version: 1, model: "scripted", served: "scripted-1", prices: { input: 0, cachedInput: 0, output: 500 }, summary: "The scripted model's answer.", findings: [], dropReason: "The scripted model drops every candidate; it reads no code.", reply: null };
const REVIEW_MAX_USD = 0.02;
const MAX_OUTPUT_TOKENS = 30;

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};
const readLines = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const writeLines = (path, lines) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
};

let root;
let checkout;
let head;
let script;
let tools;
let parentRun;

// A clone of this repository at HEAD with the build of this checkout copied
// in, its packages' node_modules linked, and benchmark/.build/provenance.json
// written the way benchmark/build-cli.mjs writes it.
function makeCheckout(dest) {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  execFileSync("git", ["clone", "-q", "--shared", "--no-checkout", repoRoot, dest]);
  execFileSync("git", ["checkout", "-q", "--detach", head], { cwd: dest });
  const built = ["dist", "wasm", "lenses", "locks", "demo", "docs", "skills", "toolchain.json", "README.md", "LICENSE", "NOTICE"];
  for (const p of built) if (existsSync(join(repoRoot, "packages/cli", p))) cpSync(join(repoRoot, "packages/cli", p), join(dest, "packages/cli", p), { recursive: true });
  for (const pk of readdirSync(join(repoRoot, "packages"))) if (existsSync(join(repoRoot, "packages", pk, "dist")) && pk !== "cli") cpSync(join(repoRoot, "packages", pk, "dist"), join(dest, "packages", pk, "dist"), { recursive: true });
  appendFileSync(join(dest, ".git/info/exclude"), "node_modules\n");
  for (const d of [".", ...readdirSync(join(repoRoot, "packages")).map((p) => `packages/${p}`)]) if (existsSync(join(repoRoot, d, "node_modules"))) symlinkSync(join(repoRoot, d, "node_modules"), join(dest, d, "node_modules"));
  const t = treeState(dest);
  writeJson(join(dest, "benchmark/.build/provenance.json"), { version: 1, commit: t.commit, tree: t.tree, commitTree: t.commitTree, dirty: t.dirty, bundleHash: bundleHash(join(dest, "packages/cli")), builtAt: new Date().toISOString(), node: process.version });
  return t.commit;
}

// One run of the checkout's run.mjs, the way the driver runs it.
function runBench(out, args) {
  const p = spawnSync(process.execPath, [join(checkout, "benchmark/run.mjs"), "--reviewers", "model:scripted", "--cases", CASE, "--max-usd", "1", "--max-minutes", "30", "--review-max-usd", String(REVIEW_MAX_USD), "--max-output-tokens", String(MAX_OUTPUT_TOKENS), "--model-script", script, "--install-root", tools, "--allow-missing-scanners", "--out", out, ...args], { encoding: "utf8", cwd: checkout });
  if (p.status !== 0) throw new Error(`run.mjs failed (exit ${p.status}):\n${p.stdout}\n${p.stderr}`);
  return out;
}

// A copy of a run folder under a new run id, its manifest edited by `edit`.
function copyRun(from, runId, edit = (m) => m) {
  const to = join(root, "runs", runId);
  cpSync(from, to, { recursive: true });
  writeJson(join(to, "manifest.json"), edit({ ...readJson(join(to, "manifest.json")), runId }));
  return to;
}

// Every review of a run finds the case's critical bug: a parent the
// candidate is behind.
function everyReviewFindsTheBug(folder) {
  const samples = join(folder, "samples", CASE);
  for (const config of readdirSync(samples)) {
    for (const n of readdirSync(join(samples, config))) {
      const file = join(samples, config, n, "report", "report.json");
      const report = readJson(file);
      report.findings = [{ origin: "agent", severity: "critical", category: "security", confidence: 0.9, file_path: "files/app.py", line_number: 17, line_end: 17, title: "Path traversal in the download route", problem: "The name from the query string is joined to the folder unchecked.", consequence: "A request with ../ reads any file the server can read.", fix: "Use send_from_directory.", candidate: null, source: null }];
      writeJson(file, report);
    }
  }
  return folder;
}

// The lines every live ledger holds before a change: a passing validation
// of the rule as it stands, and a baseline whose signal says go.
const validation = () => ({ v: 1, id: "VAL-0001", at: "2026-10-11T00:00:00.000Z", event: "validation", ruleHash: ruleHash(), look: null, alpha: null, simulation: { sequences: 1000, looks: 10, accepted: 0, harm: { decision: "reverted" } }, saved: { falseAccepts: 0, missedHarms: 0 }, pass: true, reason: "test" });
const baseline = (stop = false, id = "RC-BASE-0001") => ({ v: 1, id, at: "2026-10-11T00:00:01.000Z", event: "baseline", look: null, alpha: null, runs: [], signal: { sameIssueAgreement: stop ? 0.5 : 0.9, unresolvedShare: 0.1, toolStressShare: 0.2, stop } });
const proposed = (id, over = {}) => ({ v: 1, id, at: "2026-10-11T00:00:02.000Z", event: "proposed", record: { lever: "brief.order-and-size", title: `change ${id}`, hypothesis: "h", branch: `b-${id}`, parent: head, commit: head, paths: ["server"], target: "server", aim: "quality", primary: { metric: "recall", better: "higher" }, acceptableLoss: { ...LOSSES }, capUsd: 40, capReviews: 240, proposedBy: "test", ...over }, runs: [], look: null, alpha: null, results: {}, strata: null, causes: {}, stage: null, decision: null, reason: null, spendUsd: 0, laptopReviews: 0, minutes: 0, pr: null });

// The driver, run as a person runs it, on the test's checkout, results
// folder and ledger.
function loopArgs(ledger, results, args) {
  return [LOOP, ...args, "--ledger", ledger, "--results", results, "--checkout", checkout, "--model-script", script, "--install-root", tools, "--allow-missing-scanners"];
}
const loop = (ledger, results, args) => spawnSync(process.execPath, loopArgs(ledger, results, args), { encoding: "utf8", cwd: repoRoot });
const loopAsync = (ledger, results, args) =>
  new Promise((done) => {
    const child = spawn(process.execPath, loopArgs(ledger, results, args), { cwd: repoRoot });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (status) => done({ status, out }));
  });

beforeAll(() => {
  root = tempDir("oq-bench-loop-");
  checkout = join(root, "checkout");
  head = makeCheckout(checkout);
  script = join(root, "script.json");
  writeJson(script, SCRIPT);
  tools = join(root, "home", "tools");
  mkdirSync(tools, { recursive: true });
  // The parent build's run: three repeats of the case, every review
  // scripted and priced.
  parentRun = runBench(join(root, "runs", "parent"), ["--repeat", "3"]);
}, 300_000);

describe("an iteration behind after stage 1 spends through stage 3", () => {
  it("stops the change at stage 1 with its look and spend in the ledger, and runs nothing after", () => {
    const parent = everyReviewFindsTheBug(copyRun(parentRun, "parent-finds"));
    const ledger = join(root, "behind", "reviewer.jsonl");
    const results = join(root, "behind", "results");
    writeLines(ledger, [validation(), baseline(), proposed("RC-0001")]);

    const first = loop(ledger, results, ["step", "--change", "RC-0001", "--parent", parent]);
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const line = readLines(ledger).at(-1);
    expect(line).toMatchObject({ v: 1, id: "RC-0001", event: "decided", stage: 1, decision: "stopped-early", look: 1 });
    expect(line.alpha).toBeCloseTo(0.05 / 2, 15);
    expect(line.reason).toMatch(/recall/);
    // The stage-1 run is the candidate's one repeat, and what it cost is the spend.
    const candidate = join(results, "RC-0001-parent-finds");
    expect(readJson(join(candidate, "manifest.json"))).toMatchObject({ repeat: 1, changeId: "RC-0001", build: { commit: head } });
    expect(line.spend.serverUsd).toBeGreaterThan(0);
    expect(line.spend.serverReviews).toBe(1);
    const spentAfterStage1 = readFileSync(join(candidate, "budget.jsonl"), "utf8");

    // A later step is refused: nothing runs, nothing is written.
    const second = loop(ledger, results, ["step", "--change", "RC-0001", "--parent", parent]);
    expect(second.status).toBe(1);
    expect(second.stderr).toMatch(/stopped-early|decided/);
    expect(readLines(ledger)).toHaveLength(4);
    expect(readJson(join(candidate, "manifest.json")).repeat).toBe(1);
    expect(readFileSync(join(candidate, "budget.jsonl"), "utf8")).toBe(spentAfterStage1);
    expect(readdirSync(results)).toEqual(["RC-0001-parent-finds"]);
  }, 300_000);
});

describe("the loop reads a test-split run", () => {
  // A held-out run whose samples cannot be scored at all (its spec copy is
  // gone): refusing it after scoring them would fail with another error.
  const heldOut = (runId) => {
    const folder = copyRun(parentRun, runId, (m) => ({ ...m, split: "test" }));
    renameSync(join(folder, "cases", `${CASE}.json`), join(folder, `${CASE}.spec-moved-away`));
    return folder;
  };

  it("refuses a held-out parent before reading a sample, and runs and writes nothing", () => {
    const parent = heldOut("parent-test-split");
    const ledger = join(root, "split-parent", "reviewer.jsonl");
    const results = join(root, "split-parent", "results");
    writeLines(ledger, [validation(), baseline(), proposed("RC-0001")]);
    const before = readFileSync(ledger, "utf8");
    const r = loop(ledger, results, ["step", "--change", "RC-0001", "--parent", parent]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/held-out|test split/);
    expect(r.stderr).not.toMatch(/spec is needed/);
    expect(readFileSync(ledger, "utf8")).toBe(before);
    expect(existsSync(results)).toBe(false);
  });

  it("refuses a held-out candidate the same way", () => {
    const candidate = heldOut("candidate-test-split");
    writeJson(join(candidate, "manifest.json"), { ...readJson(join(candidate, "manifest.json")), changeId: "RC-0001" });
    const ledger = join(root, "split-candidate", "reviewer.jsonl");
    const results = join(root, "split-candidate", "results");
    writeLines(ledger, [validation(), baseline(), proposed("RC-0001")]);
    const before = readFileSync(ledger, "utf8");
    const r = loop(ledger, results, ["step", "--change", "RC-0001", "--parent", parentRun, "--candidate", candidate]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/held-out|test split/);
    expect(r.stderr).not.toMatch(/spec is needed/);
    expect(readFileSync(ledger, "utf8")).toBe(before);
    expect(existsSync(results)).toBe(false);
  });
});

describe("two iterations take one look number", () => {
  it("gives two changes deciding at once looks 1 and 2, each with its alpha", async () => {
    const ledger = join(root, "looks", "reviewer.jsonl");
    const results = join(root, "looks", "results");
    writeLines(ledger, [validation(), baseline(), proposed("RC-0001"), proposed("RC-0002")]);
    // Each change's stage-1 run is a saved run made for it: nothing is run.
    const fed = (id) => copyRun(parentRun, `candidate-${id}`, (m) => ({ ...m, changeId: id }));
    // The ledger's own lock is held while both steps start and score their
    // runs, so both reach their decision before either may write: a step
    // that reads its look outside the lock reads the same one as the other.
    const held = lockLedger(ledger);
    const both = Promise.all([
      loopAsync(ledger, results, ["step", "--change", "RC-0001", "--parent", parentRun, "--candidate", fed("RC-0001")]),
      loopAsync(ledger, results, ["step", "--change", "RC-0002", "--parent", parentRun, "--candidate", fed("RC-0002")]),
    ]);
    await new Promise((wake) => setTimeout(wake, 5000));
    held.release();
    const [a, b] = await both;
    expect(a.status, a.out).toBe(0);
    expect(b.status, b.out).toBe(0);
    const looks = readLines(ledger).filter((l) => l.look !== null);
    expect(looks.map((l) => l.id).sort()).toEqual(["RC-0001", "RC-0002"]);
    expect(looks.map((l) => l.look).sort()).toEqual([1, 2]);
    for (const l of looks) expect(l.alpha).toBeCloseTo(0.05 / (l.look * (l.look + 1)), 15);
    expect(existsSync(results)).toBe(false);
  }, 120_000);
});

describe("the daily cap is exceeded by a stage 2 decision that was forecast under it", () => {
  it("holds the stage 2 run to the day's room, so the day's server spend stays inside 60 dollars", () => {
    const ledger = join(root, "daily", "reviewer.jsonl");
    const results = join(root, "daily", "results");
    const now = new Date().toISOString();
    // RC-0001 passed stage 1 at $0.001 a review, so stage 2's three reviews
    // are forecast at $0.003. Another change spent $59.97 on the server
    // today, leaving $0.03, which one review's $0.02 cap fits in. Each
    // review really costs $0.0135: three of them would pass the cap.
    const stage1 = { v: 1, id: "RC-0001", at: now, event: "stage", runs: [], look: 1, alpha: 0.025, stage: 1, decision: null, reason: "stage 1 continues", spend: { serverUsd: 0.001, serverReviews: 1, laptopUsd: 0, laptopReviews: 0, runs: [] }, spendUsd: 0.001, laptopReviews: 0, minutes: 1, pr: null };
    const other = { v: 1, id: "RC-0002", at: now, event: "decided", runs: [], look: 2, alpha: 0.05 / 6, stage: 1, decision: "stopped-early", reason: "test", spend: { serverUsd: 59.97, serverReviews: 400, laptopUsd: 0, laptopReviews: 0, runs: [] }, spendUsd: 59.97, laptopReviews: 0, minutes: 300, pr: null };
    writeLines(ledger, [validation(), baseline(), proposed("RC-0001"), proposed("RC-0002"), stage1, other]);

    const r = loop(ledger, results, ["step", "--change", "RC-0001", "--parent", parentRun]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const lines = readLines(ledger);
    const line = lines.at(-1);
    // The forecast said it fits; the hard cap stopped it, and no decision was taken on part of the runs.
    expect(line).toMatchObject({ id: "RC-0001", event: "stage", stage: 2, look: null, decision: null });
    expect(line.spend.forecastUsd).toBeLessThan(0.03);
    expect(line.reason).toMatch(/daily/);
    const today = now.slice(0, 10);
    const spentToday = lines.filter((l) => l.spend && l.at.slice(0, 10) === today).reduce((s, l) => s + l.spend.serverUsd, 0);
    expect(spentToday).toBeLessThanOrEqual(60 + 1e-9);
    expect(line.spend.serverUsd).toBeGreaterThan(0);
    const manifest = readJson(join(results, `RC-0001-${basename(parentRun)}`, "manifest.json"));
    expect(manifest.budget.hardCaps.maxUsd).toBeLessThanOrEqual(0.03 + 1e-9);

    // The next step the same day finds no room for a review and runs nothing.
    const again = loop(ledger, results, ["step", "--change", "RC-0001", "--parent", parentRun]);
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/daily/);
    expect(readLines(ledger)).toHaveLength(lines.length);
  }, 300_000);
});

describe("a lever is chosen after the earliest-failure signal said stop", () => {
  const record = () => {
    const file = join(root, "signal", "record.json");
    writeJson(file, { lever: "brief.order-and-size", title: "t", hypothesis: "h", branch: "b", parent: head, primary: { metric: "recall" }, acceptableLoss: { ...LOSSES }, proposedBy: "test" });
    return file;
  };

  it("refuses a proposal and a step while the last baseline's signal says stop, and before any baseline carries one", () => {
    for (const [name, lines] of [
      ["stop", [validation(), baseline(false, "RC-BASE-0001"), baseline(true, "RC-BASE-0002"), proposed("RC-0001")]],
      ["stop-line", [validation(), baseline(false), { v: 1, id: "STOP-0001", at: "2026-10-11T00:00:03.000Z", event: "stop", look: null, alpha: null, reason: "unresolved findings are 40 percent of displayed findings" }, proposed("RC-0001")]],
      ["no-signal", [validation(), { ...baseline(), signal: undefined }, proposed("RC-0001")]],
    ]) {
      const ledger = join(root, "signal", name, "reviewer.jsonl");
      const results = join(root, "signal", name, "results");
      writeLines(ledger, lines);
      const before = readFileSync(ledger, "utf8");
      const p = loop(ledger, results, ["propose", record()]);
      expect(p.status, `${name}: ${p.stdout}${p.stderr}`).toBe(1);
      expect(p.stderr).toMatch(/signal|stop/);
      const s = loop(ledger, results, ["step", "--change", "RC-0001", "--parent", parentRun]);
      expect(s.status, `${name}: ${s.stdout}${s.stderr}`).toBe(1);
      expect(s.stderr).toMatch(/signal|stop/);
      expect(readFileSync(ledger, "utf8")).toBe(before);
      expect(existsSync(results)).toBe(false);
    }
  });
});
