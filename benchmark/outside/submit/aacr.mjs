#!/usr/bin/env node
// AACR leaderboard layout, read from its README, submissions/README.md and
// schema/submission.schema.json on 2026-10-12. Each repeat is a separate
// submission. Never combine repeated reviews into one sample or select by score.
// Our own judge is named local_judge_* in meta.yaml: the board shows its own
// judge_mode, and the two must not share a name.
// Failure list and tests were written first in benchmark/test/board-submit.test.mjs.
import { readFileSync, readdirSync } from "node:fs";
import { licenceExclusion, publishRefusal } from "../../lib/licence.mjs";
import { array, inside, integer, main, need, newOutput, number, object, read, string, write } from "./files.mjs";

export function validateSample(row, id) {
  need(object(row), `${id}: result must be an object`);
  for (const key of ["instance_id", "repo", "base_commit", "head_commit", "started_at"]) need(string(row[key]), `${id}: ${key} must be a nonempty string`);
  need(row.instance_id === id, `${id}: filename and instance_id differ`);
  need(number(row.duration_seconds), `${id}: duration_seconds must be a nonnegative number`);
  need(object(row.review) && object(row.review.summary), `${id}: review and summary must be objects`);
  for (const key of ["total_tokens", "input_tokens", "output_tokens"]) need(integer(row.review.summary[key]), `${id}: ${key} must be a nonnegative integer`);
  need(typeof row.review.stderr === "string", `${id}: stderr must be a string`);
  for (const c of array(row.review.comments, `${id}: comments`)) {
    need(object(c), `${id}: comment must be an object`);
    for (const key of ["path", "content"]) need(typeof c[key] === "string", `${id}: comment ${key} must be a string`);
    for (const key of ["start_line", "end_line"]) need(c[key] === null || Number.isInteger(c[key]), `${id}: ${key} must be an integer or null`);
    need(["left", "right"].includes(c.side), `${id}: side must be left or right`);
  }
}

export function check(folder) {
  const index = read(folder, "submission.json");
  need(index.name === "OpenQodex" && string(index.commit) && string(index.version) && string(index.run), "submission metadata lacks name, run, commit or version");
  const submissions = array(index.submissions, "submissions");
  need(submissions.length > 0, "no submissions");
  let samples = 0;
  const dirs = new Set();
  for (const entry of submissions) {
    need(string(entry.dir) && !dirs.has(entry.dir), "submission directories must be unique");
    dirs.add(entry.dir);
    const base = inside(folder, entry.dir);
    // The writer uses JSON-quoted YAML scalars, so values have no implicit YAML types.
    const meta = Object.fromEntries(readFileSync(inside(base, "meta.yaml"), "utf8").trim().split("\n").map((line) => {
      const colon = line.indexOf(":");
      need(colon > 0, "invalid metadata line");
      return [line.slice(0, colon), JSON.parse(line.slice(colon + 1))];
    }));
    for (const key of ["submission_name", "reviewer", "model", "configuration", "commit", "version", "local_judge_mode"]) need(string(meta[key]), `meta.yaml lacks ${key}`);
    need(meta.submission_name === index.name && meta.commit === index.commit && meta.version === index.version && meta.configuration === entry.config && meta.repeat === entry.repeat && meta.local_judge_mode === "llm", "metadata does not match the submission record");
    need(meta.reviewer === "custom", "reviewer must be custom");
    const ids = array(entry.instances, "instances");
    need(ids.length > 0 && new Set(ids).size === ids.length, "instance list is empty or duplicated");
    const files = readdirSync(inside(base, "results")).sort();
    need(JSON.stringify(files) === JSON.stringify(ids.map((id) => `${id}.json`).sort()), "results files differ from the recorded instance list");
    for (const id of ids) { validateSample(read(base, `results/${id}.json`), id); samples++; }
  }
  return `AACR check passed: ${submissions.length} submissions, ${samples} sample files.`;
}

export function build(run, out) {
  const manifest = read(run, "manifest.json");
  need(manifest.suite === "aacr" && manifest.split === "dev", "only an AACR development run is exported");
  const record = read(run, "outside/aacr/convert.json");
  const evaluation = read(run, "outside/aacr/eval.json");
  need(record.run === manifest.runId && record.board === "aacr", "conversion does not name this run");
  const commit = manifest.build?.commit;
  const version = manifest.build?.cliVersion;
  const model = manifest.reviewer?.model;
  need(string(commit) && string(version) && string(model), "manifest lacks build commit, CLI version or served model");
  const dataset = new Map();
  for (const line of readFileSync(inside(run, "outside/aacr/dataset.jsonl"), "utf8").split("\n").filter((s) => s.trim())) {
    const row = JSON.parse(line);
    need(!dataset.has(row.instance_id), "duplicate dataset instance");
    dataset.set(row.instance_id, row);
  }
  const index = { name: "OpenQodex", run: manifest.runId, commit, version, submissions: [] };
  const files = [];
  for (const f of array(record.folders, "converted folders")) {
    need(manifest.configs.includes(f.config), "conversion names an unplanned configuration");
    const judged = evaluation.folders?.find((e) => e.config === f.config && e.repeat === f.repeat);
    need(judged?.mode === "llm" && judged.exit === 0 && judged.judgeErrors === 0, `${f.config}/r${f.repeat}: requires a successful model judge with no errors`);
    const dir = `submissions/openqodex-${f.config}-r${f.repeat}`;
    const instances = [];
    for (const instance of array(record.instances, "converted instances")) {
      need(manifest.cases.includes(instance.case), "conversion names an unplanned case");
      const spec = read(run, `cases/${instance.case}.json`);
      const licence = spec.source?.licence;
      need(licence && licenceExclusion(licence) === null, `${instance.case}: no usable licence`);
      const refusal = publishRefusal([{ name: instance.case, licence: licence.class }]);
      need(refusal === null, refusal);
      need(spec.split !== "test", `${instance.case}: held out`);
      const row = dataset.get(instance.instanceId);
      need(row, `${instance.instanceId}: missing from converted dataset`);
      const source = read(run, `outside/aacr/${f.dir}/${instance.instanceId}.json`);
      need(source.openqodex?.caseId === instance.caseId && source.openqodex?.config === f.config && source.openqodex?.repeat === f.repeat, "converted sample provenance differs");
      const sample = read(run, `samples/${instance.case}/${f.config}/${f.repeat}/sample.json`);
      const summary = source.review.summary;
      const body = {
        instance_id: row.instance_id, repo: row.repo, base_commit: row.base_commit, head_commit: row.head_commit,
        started_at: sample.started_at,
        duration_seconds: source.duration_seconds,
        review: { summary: { ...summary, total_tokens: summary.input_tokens + summary.output_tokens }, comments: source.review.comments.map((c) => ({ ...c, side: "right" })), stderr: typeof source.review.stderr === "string" ? source.review.stderr : "" },
      };
      validateSample(body, instance.instanceId);
      instances.push(instance.instanceId);
      files.push([`${dir}/results/${instance.instanceId}.json`, body]);
    }
    need(instances.length === f.files, "converted file count differs");
    const meta = { submission_name: "OpenQodex", reviewer: "custom", model, org: "Qodex", url: "https://github.com/openqodex/openqodex", date: manifest.started_at.slice(0, 10), configuration: f.config, repeat: f.repeat, commit, version, local_judge_mode: judged.mode, local_judge_model: evaluation.judge?.servedAtProbe ?? evaluation.judge?.deployment };
    files.push([`${dir}/meta.yaml`, Object.entries(meta).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n") + "\n"]);
    index.submissions.push({ dir, config: f.config, repeat: f.repeat, instances });
  }
  need(files.length > 0, "no converted submissions");
  out = newOutput(out, run);
  for (const [path, body] of files) write(out, path, body);
  write(out, "submission.json", index);
  return `Prepared AACR leaderboard folders under ${out}. Nothing sent.`;
}
main(import.meta.url, build, check);
