// Each test names the saved-output failure it guards. No judge is called.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { benchRoot } from "../lib/cases.mjs";
import { boardReview } from "../lib/board-reviews.mjs";
import { entryProblems, hashFolder, sha256 } from "../lib/index.mjs";
import { BOARDS } from "../lib/outside-boards.mjs";
import { readGreptileOutside } from "../lib/greptile-board.mjs";
import { martianEvaluations, readMartianOutside } from "../lib/martian-board.mjs";
import { martianFindings, martianGolden, readMartianEvaluation } from "../lib/score.mjs";
import { martianTruth, readCase, readSuite, specCopy, truthOf } from "../lib/suites.mjs";
import { extractAsset } from "../fetch-run.mjs";
import { packageRun, publishRun } from "../publish-run.mjs";
import { convertRun } from "../outside/convert/martian.mjs";
import { loadRun, scoreRun } from "../score.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";
import { CLAUDE, FIXTURES, MODEL, convertOpts, fixturePlan, fixtureReport, savedRun, suite } from "./martian-board-fixture.mjs";

afterAll(removeTempDirs);
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); };
const pins = read(join(benchRoot, "outside/boards.json"));
const judgeModel = pins.deployments[pins.boards.martian.judge.deployment].id;
const tool = "openqodex-cli-claude-r1";
const boardPath = (folder, board, path) => join(folder, "outside", board, path);
const readBlock = (folder, board) => { const run = loadRun(folder); return BOARDS[board](folder, scoreRun(run).jobs, run.specs); };
const options = () => ({ runs: tempDir("oq-outside-index-"), out: tempDir("oq-outside-asset-"), env: { OPENQODEX_BENCH_MODEL_ENV: join(benchRoot, "test/fixtures/no-model.env") }, dryRun: true, writeIndex: true });

async function martianRun({ native = null, empty = false } = {}) {
  const ctx = await suite();
  const selected = empty ? { ...ctx, ids: new Map([...ctx.ids].slice(0, 2)) } : ctx;
  const config = native === null ? CLAUDE : "control-graph-off";
  const name = native === null ? tool : "claude-code-control-r1";
  const plan = { [`${config}/1`]: native === null ? fixturePlan()[`${MODEL}/1`] : Object.fromEntries([...ctx.ids.keys()].map((c) => [c, { reviewer: "control", status: "complete", nativeBody: native }])) };
  if (empty) plan[`${config}/1`] = Object.fromEntries([...selected.ids.keys()].map((c, i) => [c, i === 0 ? { reviewer: "control", status: "failed", nativeBody: "", failure: "No saved native review" } : "unstarted"]));
  const saved = await savedRun(selected, { configs: [config], plan, settings: { path: "laptop", build: { commit: "a".repeat(40), short: "aaaaaaa", dirty: false }, reviewers: { claude: { version: "fixture", model: "fixture" } } } });
  const folder = join(dirname(saved), "2026-10-11-aaaaaaa");
  renameSync(saved, folder);
  for (const [name, id] of ctx.ids) write(join(folder, "cases", `${name}.json`), specCopy(readCase(id, { root: ctx.root }), truthOf(readCase(id, { root: ctx.root }), { cache: ctx.cache })));
  const { data } = await convertRun(folder, convertOpts(ctx));
  const r = (file) => JSON.parse(readFileSync(join(FIXTURES, "recorded", file), "utf8").replaceAll("openqodex-library-r1", name));
  const evaluations = empty ? Object.fromEntries(Object.entries(data).map(([url, e]) => [url, { [name]: { total_candidates: 0, total_golden: e.golden_comments.length, errors_count: 0, true_positives: [] } }])) : r("evaluations.json");
  const totals = r("totals.json");
  if (empty) for (const profile of ["strict", "core", "all"]) totals.profiles[profile][name] = { precision: 0, recall: 0, f1: 0, fbeta: 0, tp: 0, fp: 0, fn: profile === "strict" ? 4 : 5, prs: 3 };
  const result = martianEvaluations({ data, candidates: empty ? {} : r("candidates.json"), dedup: empty ? {} : r("dedup_groups.json"), evaluations, totals, judge: { model: judgeModel, served: judgeModel }, model: judgeModel });
  expect(result.problems).toEqual([]);
  expect(result.tools[0].problems).toEqual([]);
  const evaluation = result.tools[0].evaluation;
  write(boardPath(folder, "martian", `${name}/evaluation.json`), evaluation);
  write(boardPath(folder, "martian", "eval.json"), { version: 1, board: "martian", repo: pins.boards.martian.repo, commit: pins.boards.martian.commit, judge: { deployment: judgeModel }, tools: [{ tool: name, evaluation: `${name}/evaluation.json`, core: evaluation.totals.core, problems: [] }], problems: [] });
  const run = loadRun(folder);
  const scored = scoreRun(run);
  write(join(folder, "score.json"), { ...scored.score, outside: { martian: readMartianOutside(folder, scored.jobs, run.specs) } });
  return { folder, evaluation, data };
}

function greptileRun({ held = false, comments = true } = {}) {
  const folder = tempDir("oq-outside-greptile-");
  const suite = readSuite("greptile");
  const ids = suite.file.cases.map((c) => c.id);
  const manifest = { suite: "greptile", splitHash: suite.splitHash };
  write(join(folder, "manifest.json"), manifest);
  const manifestSha256 = sha256(readFileSync(join(folder, "manifest.json")));
  const hold = held ? [{ case: suite.file.cases[0].name, index: 0, lacking: ["fix"] }] : [];
  const cases = ids.map((id, i) => ({ id, caseId: id, tool, config: CLAUDE, boardConfig: "cli-claude", comments: i === 0 && comments ? ["The loop reads past the array."] : [], status: i === 0 ? "complete" : "not-run", truthSets: {} }));
  write(boardPath(folder, "greptile", "input.json"), { truthSet: "greptile", manifestSha256, splitHash: suite.splitHash, suite: { name: "greptile", cases: ids }, tools: [{ tool, config: CLAUDE, boardConfig: "cli-claude", held: hold }], cases });
  const pin = pins.boards.greptile;
  const judgeModel = pins.deployments[pin.judge.deployment].id;
  const perTool = { [tool]: { config: CLAUDE, boardConfig: "cli-claude", ...(held ? { held: hold } : {}), caught: held ? null : comments ? 1 : 0, missed: held ? null : ids.length - (comments ? 1 : 0), of: ids.length, planned: 1, notRun: ids.length - 1, rate: held ? null : comments ? 1 / ids.length : 0 } };
  write(boardPath(folder, "greptile", "eval.json"), { version: 1, board: { name: "greptile", repository: pin.repo, commit: pin.commit, judgeModel, promptHash: pin.judge.prompt.sha256 }, truthSet: "greptile", judgeModel: held || !comments ? null : judgeModel, promptHash: pin.judge.prompt.sha256, manifestSha256, splitHash: suite.splitHash, relay: null, perTool });
  if (!held) write(boardPath(folder, "greptile", `${tool}/verdicts.json`), ids.map((id, i) => ({ id, label: i === 0 && comments ? "caught" : "missed", reason: i === 0 ? comments ? "judge" : "empty" : "not-run" })));
  return folder;
}

it("a martian block edited by hand in score.json refuses the publish", async () => {
  const { folder } = await martianRun();
  const opts = options();
  const first = await publishRun(folder, opts);
  const before = readFileSync(first.written, "utf8");
  const score = read(join(folder, "score.json"));
  score.outside.martian.perTool[tool].official.core.f1 = 0.123;
  write(join(folder, "score.json"), score);
  await expect(publishRun(folder, opts)).rejects.toThrow(/board numbers in score.json are not the ones its board output gives/);
  expect(readFileSync(first.written, "utf8")).toBe(before);
});

it("a martian core F1 that does not follow from its matches is refused", async () => {
  const { folder, evaluation } = await martianRun();
  for (const [field, wrong] of [["f1", 0.123], ["tp", 4], ["fp", 2], ["fn", 1]]) {
    const edited = structuredClone(evaluation);
    edited.totals.core[field] = wrong;
    write(boardPath(folder, "martian", `${tool}/evaluation.json`), edited);
    expect(() => readBlock(folder, "martian"), field).toThrow(/core.*(matches|candidates)/);
  }
});

it("an entry with a board key the registry does not know is invalid", async () => {
  const { folder } = await martianRun();
  const { entry } = await publishRun(folder, options());
  expect(entryProblems(entry)).toEqual([]);
  expect(entryProblems({ ...entry, outside: { borrowed: entry.outside.martian } }).join("\n")).toMatch(/outside.borrowed.*registry/);
});

it("a board block without its evidence hash or tool identity is invalid", async () => {
  const { folder } = await martianRun();
  const { entry } = await publishRun(folder, options());
  for (const field of ["config", "boardConfig"]) {
    const edited = structuredClone(entry);
    delete edited.outside.martian.perTool[tool][field];
    expect(entryProblems(edited).join("\n")).toContain(field);
  }
  const edited = structuredClone(entry);
  delete edited.outside.martian.evidenceHash;
  expect(entryProblems(edited).join("\n")).toContain("evidenceHash");
});

it("a greptile eval.json whose summary differs from its verdicts is refused", () => {
  const folder = greptileRun();
  const block = readGreptileOutside(folder, [], {});
  expect(block.perTool[tool]).toMatchObject({ caught: 1, rate: 1 / readSuite("greptile").file.cases.length });
  const file = boardPath(folder, "greptile", "eval.json");
  const evaluation = read(file);
  evaluation.perTool[tool].caught++;
  write(file, evaluation);
  expect(() => readGreptileOutside(folder, [], {})).toThrow(/summary.*verdicts/);
});

it("board output of another run (manifest hash) is refused", async () => {
  for (const [board, folder] of [["martian", (await martianRun()).folder], ["greptile", greptileRun()]]) {
    const path = join(folder, "manifest.json");
    write(path, { ...read(path), runId: "another-run" });
    expect(() => BOARDS[board](folder, [], {})).toThrow(/manifest.*(hash|sha256)/);
  }
});

it("a control evaluation reads through the native source without four sentences", async () => {
  const caseId = "martian/native@aaaaaaaa";
  const config = "control-graph-off";
  const body = 'Native review: [{"summary":"The loop reads past the array."}]';
  const review = boardReview({ caseId, config, repeat: 1, first: { row: { reviewer: "control", status: "complete", nativeBody: body }, report: null } });
  const findings = [{ findingId: review.findingIds[0], caseId, config, repeat: 1, index: 0, severity: null, source: "native", text: body }];
  const totals = { precision: 1, recall: 1, f1: 1, fbeta: 1, tp: 1, fp: 0, fn: 0, prs: 1 };
  const evaluation = { version: 1, toolName: "claude-code-control-r1", judge: { model: judgeModel }, totals: { beta: 2, strict: totals, core: totals, all: totals }, candidates: [{ candidateId: "candidate", prUrl: "fixture", extractedText: body, sourceFindingIds: review.findingIds, extraction: {}, dedupGroup: 0 }], matches: [{ candidateId: "candidate", goldenId: `${caseId}#g1`, verdict: "match" }] };
  const golden = [{ goldenId: `${caseId}#g1`, caseId, rawCategory: "bug" }];
  expect(readMartianEvaluation(evaluation, { findings, golden }).ours.golden).toEqual({ found: 1, of: 1 });
  expect(() => readMartianEvaluation(evaluation, { findings: [{ ...findings[0], text: "Another body" }], golden })).toThrow(/native.*(id|source)/);
  expect(() => readMartianEvaluation(evaluation, { findings: [findings[0], findings[0]], golden })).toThrow(/one native source/);
  expect(() => readMartianEvaluation({ ...evaluation, toolName: tool }, { findings, golden })).toThrow(/without what it reads/);
  const { folder } = await martianRun({ native: body });
  expect(readBlock(folder, "martian").perTool["claude-code-control-r1"].ours.findings).toEqual({ sent: 3, matched: 3 });
});

it("Martian keeps the reasons every unreviewed case was sent empty", async () => {
  const { folder } = await martianRun({ native: "", empty: true });
  const t = readBlock(folder, "martian").perTool["claude-code-control-r1"];
  expect(t.official.core).toMatchObject({ tp: 0, fp: 0, fn: 5, prs: 3, f1: 0 });
  expect(t.ours.golden).toEqual({ found: 0, of: 5 });
  expect(t.empty.map((c) => c.reason).sort()).toEqual(["failed", "not-run", "unstarted"]);
  expect(t.empty.find((c) => c.reason === "failed").failure).toBe("No saved native review");
});

it("Martian core excludes style goldens from its true positive count", async () => {
  const { evaluation, data } = await martianRun();
  const findings = Object.values(data).flatMap((e) => martianFindings(e.openqodex.caseId, fixtureReport(e.openqodex.case)));
  const golden = Object.values(data).flatMap((e) => martianGolden(e.openqodex.caseId, martianTruth({ comments: e.golden_comments })));
  golden[0].rawCategory = "style";
  evaluation.totals.core = { ...evaluation.totals.core, tp: 4, precision: 4 / 5, f1: 8 / 9, fbeta: 20 / 21 };
  expect(readMartianEvaluation(evaluation, { findings, golden }).official.core).toMatchObject({ tp: 4, fp: 1, fn: 0, f1: 8 / 9 });
});

it("Martian counts duplicate unmatched candidate text as one false positive", async () => {
  const { evaluation, data } = await martianRun();
  const findings = Object.values(data).flatMap((e) => martianFindings(e.openqodex.caseId, fixtureReport(e.openqodex.case)));
  const golden = Object.values(data).flatMap((e) => martianGolden(e.openqodex.caseId, martianTruth({ comments: e.golden_comments })));
  const unmatched = evaluation.candidates.find((c) => c.extractedText.includes("Vague constant"));
  expect(unmatched).toBeDefined();
  evaluation.candidates.push({ ...unmatched, candidateId: `${unmatched.candidateId}-duplicate` });
  expect(readMartianEvaluation(evaluation, { findings, golden }).official.core.fp).toBe(1);
});

it("Martian refuses a candidate without the saved text its false positive count needs", async () => {
  const { evaluation, data } = await martianRun();
  const findings = Object.values(data).flatMap((e) => martianFindings(e.openqodex.caseId, fixtureReport(e.openqodex.case)));
  const golden = Object.values(data).flatMap((e) => martianGolden(e.openqodex.caseId, martianTruth({ comments: e.golden_comments })));
  delete evaluation.candidates[0].extractedText;
  expect(() => readMartianEvaluation(evaluation, { findings, golden })).toThrow(/candidate.*text/);
});

it("the published asset keeps the board files and leaves the Martian work folder out", async () => {
  const { folder } = await martianRun();
  const kept = ["outside/martian/convert.json", "outside/martian/eval.json", "outside/martian/benchmark_data.json", `outside/martian/${tool}/evaluation.json`, "outside/greptile/input.json", "outside/greptile/eval.json", `outside/greptile/${tool}/verdicts.json`];
  for (const path of kept.filter((p) => p.startsWith("outside/greptile/"))) write(join(folder, path), { saved: true });
  const left = ["outside/martian/work/results/evaluations.json", "outside/greptile.superseded-2026-10-24/input.json", "outside/greptile.superseded-2026-10-24/eval.json", `outside/greptile.superseded-2026-10-24/${tool}/verdicts.json`];
  for (const path of left) write(join(folder, path), { path: join(homedir(), "private") });
  const asset = await packageRun(folder, options());
  const back = extractAsset(asset.tarPath, asset, tempDir("oq-outside-back-"), asset.runId);
  for (const path of kept) expect(readFileSync(join(back, path))).toEqual(readFileSync(join(folder, path)));
  for (const path of left) expect(asset.left).toContain(path);
  expect(read(join(folder, "score.json")).outside.martian.evidenceHash).toBe(hashFolder(back, kept.filter((p) => p.startsWith("outside/martian/"))).listHash);
  expect(readBlock(back, "martian")).toEqual(read(join(folder, "score.json")).outside.martian);
});

it("the publisher still inspects packaged board input for private paths", async () => {
  const { folder } = await martianRun();
  write(boardPath(folder, "greptile", "input.json"), { path: join(homedir(), "private") });
  await expect(packageRun(folder, options())).rejects.toThrow(/hit.*files to publish/);
});

it("Greptile labels remain readable after packaging without the source run", async () => {
  const folder = greptileRun();
  const block = readGreptileOutside(folder, [], {});
  const asset = await packageRun(folder, options());
  const back = extractAsset(asset.tarPath, asset, tempDir("oq-outside-back-"), asset.runId);
  expect(readGreptileOutside(back, [], {})).toEqual(block);
  expect(block.evidenceHash).toBe(hashFolder(back, ["outside/greptile/input.json", "outside/greptile/eval.json", `outside/greptile/${tool}/verdicts.json`]).listHash);
});

it("Martian refuses a conversion commit or evaluation judge that differs from its pin", async () => {
  const { folder } = await martianRun();
  for (const [file, edit] of [["convert.json", (v) => { v.commit = "0".repeat(40); }], ["eval.json", (v) => { v.judge.deployment = "wrong"; }], [`${tool}/evaluation.json`, (v) => { v.judge.model = "wrong"; }]]) {
    const path = boardPath(folder, "martian", file);
    const original = read(path);
    const changed = structuredClone(original);
    edit(changed);
    write(path, changed);
    expect(() => readBlock(folder, "martian")).toThrow(/pins|boards.json/);
    write(path, original);
  }
});

it("a held Greptile tool keeps its hold without a verdict file", () => {
  const held = readGreptileOutside(greptileRun({ held: true }), [], {}).perTool[tool];
  expect(held).toMatchObject({ caught: null, missed: null, rate: null, held: [{ lacking: ["fix"] }] });
});

it("an empty Greptile tool needs no judge model", () => {
  const empty = readGreptileOutside(greptileRun({ comments: false }), [], {}).perTool[tool];
  expect(empty).toMatchObject({ caught: 0, rate: 0 });
});

it("a Greptile tool with comments cannot lose its judge model", () => {
  const folder = greptileRun();
  const file = boardPath(folder, "greptile", "eval.json");
  write(file, { ...read(file), judgeModel: null });
  expect(() => readGreptileOutside(folder, [], {})).toThrow(/judge model/);
});

it("Greptile refuses a shortened suite and changed board pins", () => {
  for (const field of ["commit", "promptHash", "judgeModel", "of"]) {
    const folder = greptileRun();
    const file = boardPath(folder, "greptile", "eval.json");
    const edited = read(file);
    if (field === "commit") edited.board.commit = "0".repeat(40);
    else if (field === "of") edited.perTool[tool].of--;
    else edited[field] = "wrong";
    write(file, edited);
    expect(() => readGreptileOutside(folder, [], {}), field).toThrow();
  }
});

it("repeated outside flags and all preserve every requested board during an in-place refresh", async () => {
  const { folder } = await martianRun();
  const before = read(join(folder, "score.json"));
  before.marker = "keep the reviewed score";
  write(join(folder, "score.json"), before);
  const script = join(benchRoot, "score.mjs");
  for (const flags of [["--outside", "martian,aacr", "--outside", "greptile"], ["--outside", "all"]]) {
    const result = spawnSync(process.execPath, [script, folder, ...flags], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr.trim().split("\n")).toHaveLength(2);
    const after = read(join(folder, "score.json"));
    expect(Object.keys(after.outside).sort()).toEqual(Object.keys(BOARDS).sort());
    expect(after.outside.martian).toEqual(before.outside.martian);
    expect(after.outside.aacr).toBeNull();
    expect(after.outside.greptile).toBeNull();
    delete after.outside;
    const { outside, ...rest } = before;
    expect(after).toEqual(rest);
    expect(result.stdout).toContain("Martian");
  }
});
