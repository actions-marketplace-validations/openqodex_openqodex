#!/usr/bin/env node
// Martian's offline results tree: benchmark_data.json at the root, and
// candidates.json, evaluations.json and dedup_groups.json in the judge
// model's folder.
// Saved board method, data, evaluations and README read on 2026-10-12.
// Failure list and tests were written first in benchmark/test/board-submit.test.mjs.
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { publishRefusal, PUBLISHABLE } from "../../lib/licence.mjs";
const modelDir = (model) => model.trim().replace(/\//g, "_");
import { array, inside, integer, main, need, newOutput, number, object, read, string, write } from "./files.mjs";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/martian");
function validate(data, candidates, evaluations, dedup) {
  need(object(dedup), "dedup groups must be an object");
  for (const [label, value] of Object.entries({ data, candidates, evaluations })) need(object(value) && Object.keys(value).length > 0, `${label} must be a nonempty object`);
  const planned = new Set();
  for (const [url, pr] of Object.entries(data)) {
    need(object(pr), `${url}: input must be an object`);
    for (const key of ["pr_title", "original_url", "source_repo", "golden_source_file"]) need(pr[key] === null || typeof pr[key] === "string", `${url}: ${key} must be a string or null`);
    for (const g of array(pr.golden_comments, `${url}: golden_comments`)) {
      need(object(g) && string(g.comment) && string(g.severity) && string(g.category), `${url}: invalid golden comment`);
    }
    for (const review of array(pr.reviews, `${url}: reviews`)) {
      need(object(review) && string(review.tool) && review.pr_url === url, `${url}: invalid review`);
      need(review.repo_name === null || typeof review.repo_name === "string", `${url}: invalid repo_name`);
      const key = `${url}\0${review.tool}`;
      need(!planned.has(key), `${url}: duplicate tool review`);
      planned.add(key);
      for (const c of array(review.review_comments, `${url}: review_comments`)) {
        need(object(c) && typeof c.body === "string" && (c.path === null || typeof c.path === "string") && (c.line === null || Number.isInteger(c.line)) && (c.created_at === null || typeof c.created_at === "string"), `${url}: invalid review comment`);
      }
      const cs = candidates[url]?.[review.tool];
      for (const c of array(cs, `${url}/${review.tool}: candidates`)) {
        need(object(c) && string(c.text) && (c.path === null || typeof c.path === "string") && (c.line === null || Number.isInteger(c.line)) && string(c.source), `${url}: invalid candidate`);
      }
      const ev = evaluations[url]?.[review.tool];
      need(object(ev) && typeof ev.skipped === "boolean" && ev.tool === review.tool && ev.pr_url === url, `${url}: invalid evaluation`);
      need(ev.repo_name === null || typeof ev.repo_name === "string", `${url}: invalid evaluation repo_name`);
      for (const field of ["true_positives", "false_positives", "false_negatives", "errors"]) array(ev[field], `${url}: ${field}`);
      for (const field of ["total_candidates", "total_golden", "tp", "fp", "fn", "errors_count"]) need(integer(ev[field]), `${url}: ${field} must be a nonnegative integer`);
      for (const field of ["precision", "recall"]) need(number(ev[field]), `${url}: ${field} must be a nonnegative number`);
      for (const match of ev.true_positives) need(object(match) && string(match.golden_comment) && string(match.severity) && string(match.matched_candidate) && number(match.confidence) && typeof match.reasoning === "string", `${url}: invalid match`);
      for (const miss of ev.false_negatives) need(object(miss) && string(miss.golden_comment) && string(miss.severity), `${url}: invalid false negative`);
      for (const extra of ev.false_positives) need(object(extra) && string(extra.candidate), `${url}: invalid false positive`);
    }
  }
  need(planned.size > 0, "no reviews");
  for (const value of [candidates, evaluations, dedup]) for (const [url, tools] of Object.entries(value)) {
    need(object(tools), `${url}: tools must be an object`);
    for (const tool of Object.keys(tools)) need(planned.has(`${url}\0${tool}`), `${url}/${tool}: absent from benchmark_data.json`);
  }
  for (const [url, tools] of Object.entries(dedup)) for (const groups of Object.values(tools)) {
    for (const group of array(groups, `${url}: dedup groups`)) need(Array.isArray(group) && group.length > 0 && group.every(integer), `${url}: a dedup group must list candidate indices`);
  }
  return planned.size;
}
export function check(folder) {
  const meta = read(folder, "submission.json");
  need(meta.name === "OpenQodex" && ["fixtures", "run"].includes(meta.source) && string(meta.judge_model), "invalid submission metadata");
  need(meta.judge_dir === modelDir(meta.judge_model), "judge folder differs from judge model");
  need(meta.source === "fixtures" ? meta.judge_mode === "stand-in" : meta.judge_mode === "llm" && string(meta.run) && string(meta.version), "invalid source or judge mode");
  const data = read(folder, "benchmark_data.json");
  const candidates = read(folder, `${meta.judge_dir}/candidates.json`);
  const evaluations = read(folder, `${meta.judge_dir}/evaluations.json`);
  const dedup = read(folder, `${meta.judge_dir}/dedup_groups.json`);
  const count = validate(data, candidates, evaluations, dedup);
  need(count === meta.reviews && Object.keys(data).length === meta.pull_requests, "input counts differ from submission metadata");
  return `Martian check passed: ${Object.keys(data).length} pull requests, ${count} reviews, source ${meta.source}.`;
}
export function build(run, out) {
  const fixture = realpathSync(run) === realpathSync(fixtures);
  let data, candidates, evaluations, dedup, meta;
  if (fixture) {
    data = read(run, "benchmark_data.json");
    candidates = read(run, "recorded/candidates.json");
    evaluations = read(run, "recorded/evaluations.json");
    dedup = read(run, "recorded/dedup_groups.json");
    meta = { name: "OpenQodex", source: "fixtures", run: null, commit: null, version: null, judge_mode: "stand-in", judge_model: "gpt-5.2", note: "Synthetic converter fixtures with a stand-in judge. No accepted Martian run and no leaderboard score." };
  } else {
    const manifest = read(run, "manifest.json");
    need(manifest.suite === "martian" && string(manifest.release) && manifest.package?.spec === `npm:${manifest.release}` && !manifest.smoke, "only an already converted Martian release run is exported");
    const record = read(run, "outside/martian/convert.json");
    const hash = createHash("sha256").update(readFileSync(inside(run, "manifest.json"))).digest("hex");
    need(record.manifestSha256 === hash && record.run === manifest.runId, "conversion does not match this manifest");
    const refusal = publishRefusal(record.cases.map((c) => ({ name: c.case, licence: c.licence })));
    need(refusal === null, refusal);
    need(record.cases.length > 0 && record.cases.every((c) => PUBLISHABLE.includes(c.licence)), "conversion holds no publishable cases");
    need(record.held.length === 0, "conversion has held findings");
    const ev = read(run, "outside/martian/eval.json");
    need(ev.problems?.length === 0 && ev.dedup?.fallbacks === 0 && ev.judging?.errorsCount === 0 && ev.steps?.length > 0 && ev.steps.every((s) => s.exit === 0), "requires a complete successful Martian evaluation");
    const model = ev.judge?.deployment;
    need(string(model), "evaluation lacks judge model");
    const dir = `outside/martian/work/results/${modelDir(model)}`;
    data = read(run, "outside/martian/benchmark_data.json");
    candidates = read(run, `${dir}/candidates.json`);
    evaluations = read(run, `${dir}/evaluations.json`);
    dedup = read(run, `${dir}/dedup_groups.json`);
    meta = { name: "OpenQodex", source: "run", run: manifest.runId, commit: manifest.build?.commit ?? manifest.package?.commit ?? null, version: manifest.build?.cliVersion ?? manifest.release, judge_mode: "llm", judge_model: model };
  }
  const count = validate(data, candidates, evaluations, dedup);
  meta = { ...meta, judge_dir: modelDir(meta.judge_model), pull_requests: Object.keys(data).length, reviews: count };
  out = newOutput(out, run);
  write(out, "benchmark_data.json", data);
  write(out, `${meta.judge_dir}/candidates.json`, candidates);
  write(out, `${meta.judge_dir}/evaluations.json`, evaluations);
  write(out, `${meta.judge_dir}/dedup_groups.json`, dedup);
  write(out, "submission.json", meta);
  return `Prepared Martian offline results from ${meta.source} under ${out}. Nothing sent.`;
}
main(import.meta.url, build, check);
