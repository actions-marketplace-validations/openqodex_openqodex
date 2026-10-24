// Failures guarded: suite cases dropped from the denominator, incomplete
// findings lost, native bodies split, held tools partly judged, truth pins
// ignored, empty reviews sent to the model, and an unbounded priced run.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { benchRoot } from "../lib/cases.mjs";
import { cacheRoot } from "../lib/licence.mjs";
import { attemptDir, planJobs, runManifest, sampleRecord } from "../lib/runner.mjs";
import { rawPath, readCase, readSuite, specCopy, truthOf } from "../lib/suites.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";
import { convertOpts, finding, fixturePlan, savedRun as martianRun, suite as martianSuite } from "./martian-board-fixture.mjs";
import { convertRun } from "../outside/convert/martian.mjs";

afterAll(removeTempDirs);
const suite = readSuite("greptile");
const cases = suite.file.cases.map((e) => readCase(e.id));
const cache = cacheRoot();
const hasTruth = cases.every((c) => Object.values(c.truthSets).every((set) => existsSync(rawPath(cache, "greptile", { path: set.file }))));
const needsTruth = " (needs pinned Greptile truth in the bench cache; skipped without it)";
const test = (name, fn) => it.skipIf(!hasTruth)(name + needsTruth, fn);
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); };
const tool = "openqodex-library-r1";
const boardPath = (folder, file) => join(folder, "outside/greptile", file);
const report = (findings = [], status = "complete", extra = {}) => ({ completion: { status }, findings, outside_change: [], ...extra });

function savedRun({ planned = cases.slice(0, 2), reviewers = ["model:scripted"], reports = [report([finding()]), report()], native = null } = {}) {
  const folder = tempDir("oq-greptile-board-");
  const { jobs, configs } = planJobs({ cases: planned.map((c) => c.name), caseIds: Object.fromEntries(planned.map((c) => [c.name, c.id])), reviewers, graph: native === null ? ["on"] : ["off"], repeat: 1 });
  const settings = { runId: "greptile-board-test", mode: "review", suite: "greptile", split: "dev", splitHash: suite.splitHash, cases: planned.map((c) => c.name), caseIds: planned.map((c) => c.id), caseHashes: Object.fromEntries(planned.map((c) => [c.name, c.hash])), configs, repeat: 1 };
  write(join(folder, "manifest.json"), runManifest({ startedAt: "2026-10-24T00:00:00Z", settings, jobs }));
  for (const c of planned) write(join(folder, "cases", `${c.name}.json`), specCopy(c, truthOf(c, { cache })));
  for (const job of jobs) {
    const index = planned.findIndex((c) => c.id === job.caseId);
    const rep = reports[index];
    if (rep === "unstarted") continue;
    const dir = attemptDir(folder, job, 1);
    const row = sampleRecord({ job, attempt: 1, result: { code: rep === null ? 1 : 0, wallMs: 1 }, report: rep, startedAt: "2026-10-24T00:00:00Z" });
    write(join(dir, "sample.json"), native === null ? row : { ...row, reviewer: "control", status: "complete", nativeBody: native });
    if (native === null && rep !== null) write(join(dir, "report/report.json"), rep);
  }
  return folder;
}

// A scripted model provider is the only stand-in. The CLI starts its real
// uncached relay, whose connection probe is counted apart from judge calls.
async function provider() {
  const seen = [];
  const server = createServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => { text += chunk; });
    req.on("end", () => {
      const request = JSON.parse(text);
      const probe = request.messages?.at(-1)?.content === "Reply yes.";
      if (!probe) seen.push(request);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: "gpt-5.2", choices: [{ message: { content: probe ? "yes" : JSON.stringify({ match: true, reasoning: "Scripted match." }) }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const envFile = join(tempDir("oq-greptile-provider-"), "model.env");
  writeFileSync(envFile, `AZURE_OPENAI_BASE_URL=http://127.0.0.1:${server.address().port}/v1\nAZURE_OPENAI_KEY=scripted-provider-key\n`);
  return { seen, envFile, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function cli(folder, args = [], model = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(benchRoot, "outside/boards/greptile-run.mjs"), folder, ...args], { env: { ...process.env, ...(model ? { OPENQODEX_BENCH_MODEL_ENV: model.envFile } : { OPENQODEX_BENCH_MODEL_ENV: join(folder, "must-not-read-model.env") }) } });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("a case the run never reviewed is counted missed, not dropped", async () => {
  const folder = savedRun();
  const model = await provider();
  try {
    const result = await cli(folder, ["--max-usd", "1"], model);
    expect(result.code, result.stderr).toBe(0);
    const input = read(boardPath(folder, "input.json"));
    expect(input.suite).toEqual({ name: "greptile", cases: cases.map((c) => c.id) });
    expect(input.cases).toHaveLength(cases.length);
    expect(input.cases[2]).toMatchObject({ caseId: cases[2].id, comments: [], status: "not-run", truthSets: truthOf(cases[2], { cache }).sets });
    expect(read(boardPath(folder, "eval.json")).perTool[tool]).toMatchObject({ caught: 1, missed: cases.length - 1, of: cases.length, planned: 2, notRun: cases.length - 2, rate: 1 / cases.length });
    const verdicts = read(boardPath(folder, `${tool}/verdicts.json`));
    expect(verdicts.map((v) => v.id)).toEqual(cases.map((c) => c.id));
    expect(verdicts[2]).toEqual({ id: cases[2].id, label: "missed", reason: "not-run" });
  } finally { await model.close(); }

  const ctx = await martianSuite();
  const partial = { ...ctx, ids: new Map([...ctx.ids].slice(0, 2)) };
  const { data, record } = await convertRun(await martianRun(partial, { plan: fixturePlan() }), convertOpts(ctx));
  expect(Object.keys(data)).toHaveLength(ctx.ids.size);
  expect(record.notRun).toEqual([{ tool, caseId: [...ctx.ids.values()][2] }]);
  const missing = Object.values(data).find((entry) => entry.openqodex.caseId === [...ctx.ids.values()][2]);
  expect(missing.reviews[0]).toMatchObject({ review_comments: [], openqodex: { status: "not-run" } });
});

test("an incomplete review sends what the developer was shown, as Martian does", async () => {
  const f = finding();
  const observation = finding({ title: "An observation", line_number: null });
  const folder = savedRun({ reports: [report([f], "incomplete", { observations: [observation] }), report()] });
  const manifest = read(join(folder, "manifest.json"));
  const config = manifest.configs[0].id;
  const retry = attemptDir(folder, { case: cases[0].name, config, repeat: 1 }, 2);
  write(join(retry, "sample.json"), { case: cases[0].name, config, repeat: 1, attempt: 2 });
  write(join(retry, "report/report.json"), report([finding({ title: "Retry must not replace first" })]));
  const result = await cli(folder, ["--dry-run"]);
  expect(result.code, result.stderr).toBe(0);
  const first = read(boardPath(folder, "input.json")).cases[0];
  expect(first.status).toBe("incomplete");
  expect(first.comments).toEqual([
    "src/a.ts:10: Index read past the end. The loop reads one element past the array. It throws at run time. Fix: Stop the loop one element earlier.",
    "src/a.ts: An observation. The loop reads one element past the array. It throws at run time. Fix: Stop the loop one element earlier.",
  ]);
  expect(existsSync(boardPath(folder, "eval.json"))).toBe(false);
});

test("a control review becomes one comment and a finding without a fix sentence holds its tool name, not just the finding", async () => {
  const body = "Native review.\n```json\n[{\"summary\":\"The loop overruns\"}]\n```";
  const native = savedRun({ reviewers: ["control"], native: body });
  expect((await cli(native, ["--dry-run"])).code).toBe(0);
  expect(read(boardPath(native, "input.json")).cases[0]).toMatchObject({ tool: "claude-code-control-r1", comments: [body] });
  const folder = savedRun({ reports: [report([finding({ fix: " " })]), report([finding()])] });
  const model = await provider();
  try {
    const result = await cli(folder, ["--max-usd", "1"], model);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Held, not sent: ${tool}`);
    expect(model.seen).toHaveLength(0);
    expect(read(boardPath(folder, "eval.json")).perTool).toEqual({});
    expect(existsSync(boardPath(folder, `${tool}/verdicts.json`))).toBe(false);
  } finally { await model.close(); }
});

it("the script refuses a truth set other than the record's profile", async () => {
  const folder = tempDir("oq-greptile-truth-refusal-");
  write(join(folder, "manifest.json"), { suite: "greptile" });
  const result = await cli(folder, ["--dry-run", "--truth-set", "augment"]);
  expect(result.code).toBe(2);
  expect(result.stderr.trim().split("\n")).toHaveLength(1);
  expect(result.stderr).toMatch(/truth set augment.*profile greptile/);
  expect(existsSync(boardPath(folder, "input.json"))).toBe(false);
});

test("a case with no comment is missed without a model call", async () => {
  const folder = savedRun({ planned: cases.slice(0, 4), reports: [report([finding()]), null, "unstarted", report()] });
  const model = await provider();
  try {
    const result = await cli(folder, ["--max-usd", "1"], model);
    expect(result.code, result.stderr).toBe(0);
    expect(model.seen).toHaveLength(1);
    expect(read(boardPath(folder, `${tool}/verdicts.json`)).slice(1, 4)).toEqual(cases.slice(1, 4).map((c, i) => ({ id: c.id, label: "missed", reason: ["failed", "unstarted", "empty"][i] })));
  } finally { await model.close(); }
});

test("a priced run requires a cap and refuses a forecast above it before contacting a provider", async () => {
  const folder = savedRun();
  for (const [args, why] of [[[], /--max-usd.*required/], [["--max-usd", "0"], /forecast.*exceeds/]]) {
    const result = await cli(folder, args);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(why);
    expect(existsSync(boardPath(folder, "eval.json"))).toBe(false);
  }
});

test("a saved Greptile evaluation refuses overwrite unless force is given", async () => {
  const folder = savedRun();
  write(boardPath(folder, "eval.json"), { saved: true });
  const refused = await cli(folder, ["--dry-run"]);
  expect(refused.code).toBe(2);
  expect(refused.stderr.trim().split("\n")).toHaveLength(1);
  expect(refused.stderr).toMatch(/eval.json.*--force/);
  expect((await cli(folder, ["--dry-run", "--force"])).code).toBe(0);
});

it("the Martian converter refuses a planned case outside the frozen suite", async () => {
  const ctx = await martianSuite();
  const folder = await martianRun(ctx, { plan: fixturePlan() });
  const manifest = read(join(folder, "manifest.json"));
  manifest.jobs[0].caseId = "martian/not-in-suite@12345678";
  write(join(folder, "manifest.json"), manifest);
  await expect(convertRun(folder, convertOpts(ctx))).rejects.toThrow(/not-in-suite.*not in.*suite/);
});

test("the Greptile converter refuses a planned case outside the frozen suite in one line", async () => {
  const folder = savedRun();
  const manifest = read(join(folder, "manifest.json"));
  manifest.jobs[0].caseId = "greptile/not-in-suite@12345678";
  write(join(folder, "manifest.json"), manifest);
  const result = await cli(folder, ["--dry-run"]);
  expect(result.code).toBe(2);
  expect(result.stderr.trim().split("\n")).toHaveLength(1);
  expect(result.stderr).toMatch(/not-in-suite.*not in.*suite/);
});

test("a changed planned case hash refuses conversion before writing input", async () => {
  const folder = savedRun();
  const manifest = read(join(folder, "manifest.json"));
  manifest.caseHashes[cases[0].name] = "0".repeat(64);
  write(join(folder, "manifest.json"), manifest);
  const result = await cli(folder, ["--dry-run"]);
  expect(result.code).toBe(2);
  expect(result.stderr).toMatch(/case hash.*suite/);
  expect(existsSync(boardPath(folder, "input.json"))).toBe(false);
});
