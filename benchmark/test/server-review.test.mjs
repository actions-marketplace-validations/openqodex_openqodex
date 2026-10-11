// The server path of the benchmark (benchmark/lib/server-review.mjs): one
// review of a materialised case through the library's server profile, the
// way a host runs it, saved as a sample the scorer reads; the scripted model
// (benchmark/lib/scripted-model.mjs); and the rule that names which models
// run.mjs may review with.
//
// The model provider is the only stand-in: the scripted model answers from
// its script, with no network. The library is the built package
// (packages/cli/dist/lib.js, the bundle a run's provenance covers), and git,
// the graph, the budget ledger and the scorer are the real ones. Scanners
// are read from an empty install root, so none runs: a review here proves
// the driver, not the scanners.
//
// Failures guarded, written before the code:
// 1. A server review writes outside its workDir: into the clone, the
//    results folder, HOME, TMPDIR or the OpenQodex home, or leaves its
//    workDir behind.
// 2. An incomplete server review is scored as complete.
// 3. The model recorded is not the one that answered: the sample names the
//    model asked for, or a model when the provider named none.
// 4. A model id that boards.json neither records as probed nor maps as an
//    alias is reviewed with.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { benchRoot, git, readLock, repoRoot } from "../lib/cases.mjs";
import { runBudget } from "../lib/budget.mjs";
import { executeRun, planJobs, runManifest } from "../lib/runner.mjs";
import { materialise } from "../lib/suites.mjs";
import { resolveModelReviewer, serverAttempt } from "../lib/server-review.mjs";
import { createScriptedReviewer, SCRIPTED_PRICES } from "../lib/scripted-model.mjs";
import { loadRun, scoreRun } from "../score.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const LIB = join(repoRoot, "packages/cli/dist/lib.js");
const { reviewChange } = await import(pathToFileURL(LIB).href);
const CASE = "flask-path-traversal";
const CASE_ID = `planted/${CASE}@${readLock().cases[CASE].hash.slice(0, 8)}`;
const CAPS = { maxUsd: 1, reviewMaxUsd: 0.5 };

// A script for the scripted model; every field is the script's own.
const script = (more = {}) => ({ version: 1, model: "scripted", served: "scripted-1", prices: { input: 0, cachedInput: 0, output: 0 }, summary: "Adds a download route.", findings: [], dropReason: "The candidate is not reachable from a request.", reply: null, ...more });

// The flask case in the server shape: the base and the change as two commits.
function serverRepo(root) {
  return materialise({ name: CASE, materialise: { kind: "folders" } }, join(root, "repo"), { shape: "server" });
}

// Every file under a folder, with its sha256, the .git folder left out.
function tree(dir) {
  const out = {};
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const path = relative(dir, join(e.parentPath, e.name));
    if (path === ".git" || path.startsWith(".git/")) continue;
    out[path] = createHash("sha256").update(readFileSync(join(dir, path))).digest("hex");
  }
  return out;
}

const filesUnder = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name))).sort() : []);

// One server review of the flask case as run.mjs runs it: a run folder with
// its manifest, the spec copy and the budget ledger, and one job whose
// attempt is the driver's. Returns the run folder and the job's sample.
async function oneRun(root, reviewer, { prices = { [reviewer.model]: SCRIPTED_PRICES } } = {}) {
  const out = join(root, "run");
  const repo = serverRepo(root);
  const workRoot = join(root, "w");
  mkdirSync(workRoot);
  const installRoot = join(root, "tools");
  mkdirSync(installRoot);
  const name = "model:scripted";
  const { configs, jobs } = planJobs({ cases: [CASE], caseIds: { [CASE]: CASE_ID }, reviewers: [name], graph: ["on"], repeat: 1 });
  const settings = { runId: "server-test", mode: "review", path: "server", suite: "planted", split: "dev", reviewers: { [name]: { name, kind: "model", model: reviewer.model } }, cases: [CASE], caseIds: [CASE_ID], configs: configs.map((c) => c.id), repeat: 1, concurrency: 1 };
  let saved = null;
  await executeRun({
    out,
    manifest: runManifest({ startedAt: new Date().toISOString(), settings, jobs }),
    copies: [[join(benchRoot, "cases", CASE, "case.json"), join("cases", `${CASE}.json`)]],
    jobs,
    budget: runBudget({ dir: out, caps: CAPS, path: "server", prices }),
    runJob: async (job, k, meter) => {
      saved = await serverAttempt({ reviewChange, job, attempt: k, out, repo, reviewer, meter, deadlineMs: 120_000, workRoot, installRoot });
    },
  });
  return { out, repo, workRoot, sample: saved, job: jobs[0] };
}

describe("a server review writes outside its workDir", () => {
  it("leaves the clone, HOME, TMPDIR and the OpenQodex home as they were, saves only the sample's files and removes its workDir", { timeout: 180_000 }, () => {
    const root = tempDir("oq-server-out-");
    const repo = serverRepo(root);
    const sandbox = Object.fromEntries(["home", "tmp", "oqhome", "work"].map((k) => [k, join(root, "sandbox", k)]));
    for (const dir of Object.values(sandbox)) mkdirSync(dir, { recursive: true });
    mkdirSync(join(sandbox.oqhome, "tools"));
    const before = { files: tree(repo.dir), head: git(repo.dir, "rev-parse", "HEAD").trim(), refs: git(repo.dir, "for-each-ref").trim() };
    const out = join(root, "run");
    // The driver in a process of its own, whose HOME, TMPDIR and OpenQodex
    // home are empty folders this test reads afterwards.
    const code = `
      import { reviewChange } from ${JSON.stringify(pathToFileURL(LIB).href)};
      import { runBudget } from ${JSON.stringify(pathToFileURL(join(benchRoot, "lib/budget.mjs")).href)};
      import { planJobs } from ${JSON.stringify(pathToFileURL(join(benchRoot, "lib/runner.mjs")).href)};
      import { serverAttempt } from ${JSON.stringify(pathToFileURL(join(benchRoot, "lib/server-review.mjs")).href)};
      import { createScriptedReviewer, SCRIPTED_PRICES } from ${JSON.stringify(pathToFileURL(join(benchRoot, "lib/scripted-model.mjs")).href)};
      const a = JSON.parse(process.env.OQ_TEST_ARGS);
      const reviewer = createScriptedReviewer(a.script);
      const { jobs } = planJobs({ cases: [a.case], caseIds: { [a.case]: a.caseId }, reviewers: ["model:scripted"], graph: ["on"], repeat: 1 });
      const budget = runBudget({ dir: a.out, caps: a.caps, path: "server", prices: { scripted: SCRIPTED_PRICES } });
      const ticket = budget.admit(jobs[0]);
      // Whether the library's own result carried the scan record, read as it
      // returns, so the test knows whether the sample should hold scan.json.
      let scanned = null;
      const observed = async (...args) => {
        const result = await reviewChange(...args);
        scanned = result.scan !== undefined && result.scan !== null;
        return result;
      };
      const { record } = await serverAttempt({ reviewChange: observed, job: jobs[0], attempt: 1, out: a.out, repo: a.repo, reviewer, meter: ticket.review, deadlineMs: 120000, workRoot: a.workRoot, installRoot: a.installRoot });
      ticket.review.close();
      process.stdout.write(JSON.stringify({ record, scanned }));
    `;
    const env = { ...process.env, HOME: sandbox.home, TMPDIR: sandbox.tmp, OPENQODEX_HOME: sandbox.oqhome, OQ_TEST_ARGS: JSON.stringify({ script: script(), case: CASE, caseId: CASE_ID, out, caps: CAPS, repo, workRoot: sandbox.work, installRoot: join(sandbox.oqhome, "tools") }) };
    const p = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env, encoding: "utf8", cwd: root, maxBuffer: 64 * 1024 * 1024 });
    expect(p.status, p.stderr).toBe(0);
    const { record, scanned } = JSON.parse(p.stdout);
    expect(typeof scanned).toBe("boolean");
    expect(record.status).toBe("complete");
    expect(record.outside).toEqual([]);
    // The clone: the same files, the same head, the same refs.
    expect(tree(repo.dir)).toEqual(before.files);
    expect(git(repo.dir, "rev-parse", "HEAD").trim()).toBe(before.head);
    expect(git(repo.dir, "for-each-ref").trim()).toBe(before.refs);
    expect(git(repo.dir, "status", "--porcelain", "--ignored", "-uall").trim()).toBe("");
    // Nothing in HOME, TMPDIR or the OpenQodex home, and the workDir gone.
    expect(filesUnder(sandbox.home)).toEqual([]);
    expect(filesUnder(sandbox.tmp).filter((f) => !f.startsWith("node-compile-cache"))).toEqual([]);
    expect(filesUnder(sandbox.oqhome)).toEqual([]);
    expect(readdirSync(sandbox.work)).toEqual([]);
    // The results folder holds the sample's own files and the run's ledger,
    // and none of the reviewed code.
    const sampleDir = join("samples", CASE, "model-scripted-graph-on", "1");
    // report/scan.json is the library's scan record, which its result
    // carries since PR 135 (ReviewResult.scan) and the scorer reads to judge
    // who found each issue: the sample holds it exactly when the result does.
    const own = ["completion.json", "dispositions.json", "progress.txt", "report/report.json", "report/report.md", ...(scanned ? ["report/scan.json"] : []), "rounds.json", "sample.json", "usage.json"];
    expect(filesUnder(out)).toEqual(["budget.jsonl", ...own.map((f) => join(sampleDir, f))].sort());
    const app = readFileSync(join(repo.dir, "files", "app.py"), "utf8");
    for (const f of filesUnder(out)) expect(readFileSync(join(out, f), "utf8")).not.toContain(app.trim().split("\n").slice(0, 6).join("\n"));
  });

  it("refuses a work root inside the clone or the results folder before any review", async () => {
    const root = tempDir("oq-server-root-");
    const repo = serverRepo(root);
    const out = join(root, "run");
    const meter = { authorize: async () => true, wrap: (r) => r };
    const job = { jobId: `${CASE_ID}/model-scripted-graph-on/1`, caseId: CASE_ID, case: CASE, config: "model-scripted-graph-on", reviewer: "model:scripted", graph: true, repeat: 1 };
    const reviewer = createScriptedReviewer(script());
    let calls = 0;
    const counted = { ...reviewer, complete: async (r) => (calls++, reviewer.complete(r)) };
    for (const workRoot of [join(repo.dir, "work"), join(out, "work")]) {
      mkdirSync(workRoot, { recursive: true });
      await expect(serverAttempt({ reviewChange, job, attempt: 1, out, repo, reviewer: counted, meter, deadlineMs: 60_000, workRoot, installRoot: join(root, "tools") })).rejects.toThrow(/work root/);
    }
    expect(calls).toBe(0);
  });
});

describe("an incomplete server review is scored as complete", () => {
  it("saves a review whose answers never pass their checks as incomplete, and the score counts it so", { timeout: 180_000 }, async () => {
    const root = tempDir("oq-server-incomplete-");
    const { out, sample } = await oneRun(root, createScriptedReviewer(script({ reply: "I read the change and it looks fine." })));
    expect(sample.record.status).toBe("incomplete");
    expect(sample.record.resultStatus).toBe("incomplete");
    expect(sample.record.failure).toMatch(/answer/);
    const saved = JSON.parse(readFileSync(join(out, "samples", CASE, "model-scripted-graph-on", "1", "sample.json"), "utf8"));
    expect(saved.status).toBe("incomplete");
    const report = JSON.parse(readFileSync(join(out, "samples", CASE, "model-scripted-graph-on", "1", "report", "report.json"), "utf8"));
    expect(report.completion.status).toBe("incomplete");
    const { score } = scoreRun(loadRun(out));
    expect(score.population).toMatchObject({ planned: 1, complete: 0, incomplete: 1, failed: 0, unstarted: 0 });
  });

  it("saves a review the budget refused as incomplete, and the score counts it so", { timeout: 180_000 }, async () => {
    const root = tempDir("oq-server-refused-");
    // Each call may cost more than the review's whole cap, so the first is refused.
    const pricey = { input: 1_000_000, cachedInput: 1_000_000, output: 1_000_000 };
    const { out, sample } = await oneRun(root, createScriptedReviewer(script({ prices: pricey })), { prices: { scripted: pricey } });
    expect(sample.record.status).toBe("incomplete");
    expect(sample.record.failure).toMatch(/budget|refused/i);
    const { score } = scoreRun(loadRun(out));
    expect(score.population).toMatchObject({ planned: 1, complete: 0, incomplete: 1 });
  });

  it("saves a complete review as complete, and the score counts it so", { timeout: 180_000 }, async () => {
    const root = tempDir("oq-server-complete-");
    const { out, sample } = await oneRun(root, createScriptedReviewer(script()));
    expect(sample.record.status).toBe("complete");
    const { score } = scoreRun(loadRun(out));
    expect(score.population).toMatchObject({ planned: 1, complete: 1, incomplete: 0 });
  });
});

describe("the model recorded is not the one that answered", () => {
  it("records the model the provider says answered, never the one asked for", { timeout: 180_000 }, async () => {
    const root = tempDir("oq-server-served-");
    const { sample } = await oneRun(root, createScriptedReviewer(script({ model: "scripted", served: "scripted-answered-7" })));
    expect(sample.record.requestedModel).toBe("scripted");
    expect(sample.record.servedModel).toBe("scripted-answered-7");
    expect(sample.record.servedModels).toEqual(["scripted-answered-7"]);
  });

  it("records no served model when the provider named none", { timeout: 180_000 }, async () => {
    const root = tempDir("oq-server-unnamed-");
    const { sample } = await oneRun(root, createScriptedReviewer(script({ served: null })));
    expect(sample.record.status).toBe("complete");
    expect(sample.record.servedModel).toBeNull();
    expect(sample.record.servedModels).toEqual([]);
  });
});

describe("a model id that boards.json neither records as probed nor maps as an alias is reviewed with", () => {
  const boards = JSON.parse(readFileSync(join(benchRoot, "outside", "boards.json"), "utf8"));
  const withAlias = (aliases) => ({ ...boards, aliases });

  it("refuses an id that is neither a probed deployment nor an alias", () => {
    expect(() => resolveModelReviewer("model:gpt-6.1", { boards: withAlias({}) })).toThrow(/refused: gpt-6\.1 .*alias/);
    const unprobed = structuredClone(boards);
    unprobed.deployments.reviewer.probed = null;
    expect(() => resolveModelReviewer("model:gpt-6.1-sol", { boards: unprobed })).toThrow(/not been probed/);
    expect(() => resolveModelReviewer("model:gpt-6.1", { boards: { ...unprobed, aliases: { "gpt-6.1": "gpt-6.1-sol" } } })).toThrow(/not been probed/);
    expect(() => resolveModelReviewer("model:gpt-6.1", { boards: withAlias({ "gpt-6.1": "gpt-9" }) })).toThrow(/gpt-9/);
  });

  it("takes a probed deployment, an alias to one, and the scripted model, and records the alias", () => {
    expect(resolveModelReviewer("model:gpt-6.1-sol", { boards })).toMatchObject({ name: "model:gpt-6.1-sol", kind: "deployment", deployment: "gpt-6.1-sol", alias: null });
    expect(resolveModelReviewer("model:gpt-6.1", { boards: withAlias({ "gpt-6.1": "gpt-6.1-sol" }) })).toMatchObject({ name: "model:gpt-6.1", kind: "deployment", deployment: "gpt-6.1-sol", alias: "gpt-6.1" });
    expect(resolveModelReviewer("model:scripted", { boards })).toMatchObject({ name: "model:scripted", kind: "scripted" });
  });

  it("run.mjs refuses --reviewers model:gpt-6.1 while boards.json maps no such alias, before anything runs", () => {
    expect(boards.aliases["gpt-6.1"]).toBeUndefined();
    const out = join(tempDir("oq-server-alias-"), "run");
    const p = spawnSync(process.execPath, [join(benchRoot, "run.mjs"), "--reviewers", "model:gpt-6.1", "--cases", CASE, "--repeat", "1", "--max-usd", "1", "--max-minutes", "5", "--review-max-usd", "0.5", "--out", out], { encoding: "utf8", cwd: repoRoot });
    expect(p.status).toBe(2);
    expect(p.stderr).toMatch(/gpt-6\.1.*alias/);
    expect(existsSync(out)).toBe(false);
  });
});

// The scripted model answers from its script and nothing else.
describe("the scripted model", () => {
  it("answers with the change id and every candidate the brief names, and reports its usage", async () => {
    const reviewer = createScriptedReviewer(script({ served: "scripted-x" }));
    const brief = ["- `change_id`: `0123456789ab`, the change this brief is for.", "- c1 [semgrep:rule] files/app.py:17 (major) A path from a parameter."].join("\n");
    const answer = await reviewer.complete({ callId: "c-1", attempt: 1, purpose: "brief", messages: [{ role: "system", text: "s" }, { role: "user", text: brief }], tools: [], maxOutputTokens: 1000 });
    expect(answer.message.toolCalls).toEqual([]);
    expect(JSON.parse(answer.message.text)).toMatchObject({ version: 2, change_id: "0123456789ab", findings: [], dropped: [{ candidate: "c1", file_path: "files/app.py", line_number: 17 }] });
    expect(answer.usage).toMatchObject({ model: "scripted", servedModel: "scripted-x", costUsd: 0 });
    expect(answer.usage.inputTokens).toBeGreaterThan(0);
    // Writing a script file and reading it back gives the same script.
    const dir = tempDir("oq-scripted-");
    writeFileSync(join(dir, "s.json"), JSON.stringify(script()));
    expect(execFileSync(process.execPath, ["--input-type=module", "-e", `import { readScript } from ${JSON.stringify(pathToFileURL(join(benchRoot, "lib/scripted-model.mjs")).href)}; process.stdout.write(JSON.stringify(readScript(${JSON.stringify(join(dir, "s.json"))}).script));`], { encoding: "utf8" })).toBe(JSON.stringify(script()));
  });
});
