#!/usr/bin/env node
// Judge a saved run, with the frozen suite as its denominator. Empty
// reviews miss by script. Only a scripted model provider stands in for the
// judge in test/greptile-run.test.mjs, whose failure list precedes this code.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { boardFolder } from "../../lib/board-files.mjs";
import { readBoardReviews } from "../../lib/board-reviews.mjs";
import { benchRoot } from "../../lib/cases.mjs";
import { relayClient } from "../../lib/calibration-relay.mjs";
import { validateComparison } from "../../lib/comparison.mjs";
import { value } from "../../lib/score.mjs";
import { realSpecProblems, truthOf } from "../../lib/suites.mjs";
import { GREPTILE_PROMPT, GREPTILE_PROMPT_HASH, judgeGreptile } from "./greptile-judge.mjs";

const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const write = (file, data) => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`); };

function options(argv) {
  const [folder, ...args] = argv;
  const opts = { folder, dryRun: false, force: false, maxUsd: null, truthSet: null };
  if (!folder || folder.startsWith("--")) throw new Error("usage: greptile-run.mjs <run> [--dry-run] [--max-usd <n>] [--force]");
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--dry-run") opts.dryRun = true;
    else if (flag === "--force") opts.force = true;
    else if (flag === "--truth-set" && args[i + 1]) opts.truthSet = args[++i];
    else if (flag === "--max-usd" && args[i + 1]) {
      opts.maxUsd = Number(args[++i]);
      if (!Number.isFinite(opts.maxUsd) || opts.maxUsd < 0) throw new Error("--max-usd must be a nonnegative dollar amount");
    } else throw new Error(`unknown or incomplete option ${flag}`);
  }
  return opts;
}

/** Convert and, unless dry, judge a run through the uncached relay. */
export async function main(argv = process.argv.slice(2)) {
  const opts = options(argv);
  // Greptile runs use the development split and need no release field.
  const record = read(join(benchRoot, "index/comparisons/compare-2026-10.json"));
  const pin = record.boards.greptile;
  const truthSet = opts.truthSet ?? pin.profile;
  if (truthSet !== pin.profile) throw new Error(`truth set ${truthSet} differs from the record's profile ${pin.profile}`);
  if (GREPTILE_PROMPT_HASH !== pin.promptHash) throw new Error("Greptile prompts differ from the board pin");
  if (!validateComparison(record, { build: record.build }).accepted) throw new Error("the comparison record is not accepted");
  const folder = resolve(opts.folder);
  const out = boardFolder(folder, "greptile");
  if (existsSync(join(out, "eval.json")) && !opts.force) throw new Error(`${join(out, "eval.json")} exists already; use --force to overwrite it`);
  const manifest = read(join(folder, "manifest.json"));
  if (manifest.suite !== "greptile") throw new Error(`the run is of suite ${manifest.suite}, not greptile`);
  if (manifest.mode === "scan") throw new Error("a scanner-only run shows no review for the board to judge");
  const run = readBoardReviews(folder);
  if (run.manifest.splitHash !== record.suites.greptile.splitHash) throw new Error("the run's split hash differs from the accepted Greptile suite");
  const savedTruth = new Map();
  const cachedTruth = new Map();
  const byId = new Map(run.cases.map((c) => [c.id, c]));
  const truthSets = (review) => {
    const c = byId.get(review.caseId);
    if (review.status === "not-run") {
      if (!cachedTruth.has(c.id)) cachedTruth.set(c.id, truthOf(c).sets);
      return cachedTruth.get(c.id);
    }
    if (!savedTruth.has(c.id)) {
      const spec = read(join(folder, "cases", `${c.name}.json`));
      if (spec.id !== c.id || spec.hash !== c.hash) throw new Error(`${c.id}: saved case differs from the frozen suite`);
      const problems = realSpecProblems(spec, c.name, { suite: "greptile" });
      if (problems.length > 0) throw new Error(problems.join("; "));
      savedTruth.set(c.id, spec.truthSets);
    }
    return savedTruth.get(c.id);
  };
  const input = {
    truthSet, manifestSha256: run.manifestSha256, splitHash: run.manifest.splitHash, suite: run.suite,
    cases: run.reviews.map((r) => ({
      id: r.caseId, caseId: r.caseId, tool: r.tool, config: r.config,
      boardConfig: run.tools.find((t) => t.tool === r.tool).boardConfig,
      comments: r.comments.map((c) => r.native !== null ? c.body : `${c.path ?? ""}${c.line === null ? "" : `:${c.line}`}: ${c.body}`),
      status: r.status, truthSets: truthSets(r),
    })),
  };
  write(join(out, "input.json"), input);
  const held = new Set(run.tools.filter((t) => t.held).map((t) => t.tool));
  for (const t of run.tools) {
    const mine = input.cases.filter((c) => c.tool === t.tool);
    const withComments = mine.filter((c) => c.comments.length > 0).length;
    const notRun = mine.filter((c) => c.status === "not-run").length;
    console.log(`${t.tool}: ${mine.length} cases, ${mine.length - notRun} planned, ${notRun} not-run; ${withComments} with comments, ${mine.length - withComments} without, ${t.held ? mine.length : 0} held.`);
    if (t.held) console.log(`Held, not sent: ${t.tool}: ${run.held.filter((h) => h.tool === t.tool).map((h) => `${h.case} index ${h.index}: lacks ${h.lacking.join(", ")}`).join("; ")}`);
  }
  const calibration = read(join(benchRoot, "index/calibration/greptile-2026-10-23.json"));
  const unitUsd = calibration.costUsd / calibration.counts.total;
  const comments = input.cases.filter((c) => !held.has(c.tool)).reduce((n, c) => n + c.comments.length, 0);
  const forecast = comments * unitUsd;
  console.log(`Forecast: USD ${forecast.toFixed(6)} for ${comments} comments at USD ${unitUsd.toFixed(8)} per comment from calibration.`);
  if (opts.dryRun) return 0;
  if (opts.maxUsd === null) throw new Error("--max-usd is required for a priced run");
  if (forecast > opts.maxUsd) throw new Error(`forecast USD ${forecast.toFixed(6)} exceeds --max-usd ${opts.maxUsd}`);

  let relay;
  try {
    if (comments > 0) relay = await relayClient({});
    const perTool = {};
    for (const t of run.tools.filter((t) => !t.held)) {
      // Keep suite order in the file, including misses which use no model.
      const mine = input.cases.filter((c) => c.tool === t.tool);
      const reasons = [];
      const judged = await judgeGreptile(mine.filter((c) => c.comments.length > 0), { truthSet, complete: async (request) => {
        const answer = await relay.complete(GREPTILE_PROMPT, request);
        reasons.push(typeof answer.reasoning === "string" ? answer.reasoning : "judge");
        return answer;
      } });
      const labels = new Map(judged.map((v, i) => [v.id, { ...v, reason: reasons[i] }]));
      const verdicts = mine.map((c) => labels.get(c.id) ?? { id: c.id, label: "missed", reason: ["not-run", "failed", "unstarted"].includes(c.status) ? c.status : "empty" });
      const caught = verdicts.filter((v) => v.label === "caught").length;
      const of = run.suite.cases.length;
      const notRun = mine.filter((c) => c.status === "not-run").length;
      perTool[t.tool] = { config: t.config, boardConfig: t.boardConfig, caught, missed: of - caught, of, planned: of - notRun, notRun, rate: value({ hit: caught, of }) };
      write(join(out, t.tool, "verdicts.json"), verdicts);
    }
    const counts = relay ? await relay.counts() : { relay: true, requests: 0, stripped: 0, parameterChanges: {}, upstreamStatuses: {}, usage: { responses: 0, missing: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 } };
    write(join(out, "eval.json"), {
      version: 1, board: { name: pin.name, repository: pin.repository, commit: pin.commit, judgeModel: pin.judgeModel, promptHash: pin.promptHash },
      truthSet, judgeModel: relay?.model ?? pin.judgeModel, promptHash: GREPTILE_PROMPT_HASH,
      manifestSha256: run.manifestSha256, splitHash: run.manifest.splitHash, relay: counts, perTool,
    });
  } finally { if (relay) await relay.close(); }
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main().then((code) => { process.exitCode = code; }, (error) => { console.error(error.message.split("\n")[0]); process.exitCode = 2; });
