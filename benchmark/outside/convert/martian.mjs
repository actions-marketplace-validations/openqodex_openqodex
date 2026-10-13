#!/usr/bin/env node
// A saved release run's samples on Martian's cases, as the entries Martian's
// offline pipeline reads (its results/benchmark_data.json): one entry per
// pull request, keyed by its golden URL, holding the pinned golden comments
// verbatim and one review per tool name, `openqodex-<config>-r<repeat>`
// (library for a model reviewer, cli-claude for Claude Code, cli-codex for
// Codex; lib/martian-board.mjs), with one comment per finding shown to the
// developer: { path, line, body, created_at }, the body one paragraph
// "{title}. {problem} {consequence} Fix: {fix}". Martian's code ignores the
// rest, so each entry and review also says which of our cases and reviews it
// is (`openqodex`). Files go only under <run>/outside/martian/:
// benchmark_data.json and convert.json (what was written, held or refused).
//
//   node benchmark/outside/convert/martian.mjs convert <run>
//   node benchmark/outside/convert/martian.mjs pin     (the board's repository and commit)
//   node benchmark/outside/convert/martian.mjs cache   (the bench cache, refused inside the repository)
//   node benchmark/outside/convert/martian.mjs paths   (their checkout and its venv in the cache, each
//                                                       refused when its real path is in the repository)
//
// The access log is benchmark/index/heldout-access.jsonl, or the file
// OPENQODEX_BENCH_ACCESS_LOG names (for tests; a release run uses the
// committed log, and martian-judge.mjs looks for the line in the same file).
//
// Every Martian case is held out (its golden comments are public), so this
// converter is the one path that reads them, and only for a release run: a
// run whose manifest names its release (the `release` field of
// PLAN-benchmark 4.3, a version, which lib/index.mjs already requires of a
// held-out entry), that reviewed the published package of that release, as
// the npm registry confirms (lib/martian-board.mjs releaseGate). run.mjs
// writes no release run yet; the field and the package record are the gate.
//
// Failure list, written before the code:
// 1. A run that is not a release run reads Martian's cases: a manifest with
//    no release, or a smoke run, is refused before anything is read or
//    written; so is one whose release is not the published package it
//    reviewed (failure 6 of lib/martian-board.mjs).
// 2. A held-out access goes unlogged: one line per conversion ({ at, suite,
//    caseCount, purpose: "release-run", runId, release, by }) is appended to
//    benchmark/index/heldout-access.jsonl before any golden comment is
//    read, and a line that cannot be written refuses the conversion.
// 3. A finding without a title, problem, consequence or fix is dropped, so
//    the judge judges less than the review wrote: the finding is held,
//    recorded in convert.json with what it lacks, and none of its tool
//    name's reviews is written, since judging that tool name without one
//    of its pull requests would shrink Martian's denominators.
// 4. A failed or never-started review vanishes from Martian's denominators:
//    every planned review's first attempt is a review, with no comment when
//    it failed or never started; a retry never replaces it.
// 5. A case whose licence nobody verified, a sample of a case the run did
//    not plan, a case outside Martian, or a changed case is converted: each
//    refuses the whole run, named, before anything is written.
// 6. Two configurations go by one tool name, or one with the graph off goes
//    by the name of the product as it ships: refused (lib/martian-board.mjs
//    boardConfigOf).
// 7. Board files leave the run through a symbolic link, or a second
//    conversion mixes with the first: everything is written in
//    lib/board-files.mjs boardFolder(run, "martian"), which must not exist.
// 8. The bench cache lies in the repository, or a link under it leads there:
//    `cache` and `paths` refuse it.
// From the review of PR 161:
// 9. A conversion made outside the gate, or of another manifest, is judged:
//    convert.json records the sha256 of the manifest it converted and the
//    access line it wrote, which martian-judge.mjs checks before it judges.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { benchCache, boardFolder, outsideRepo } from "../../lib/board-files.mjs";
import { benchRoot, parseCaseId, repoRoot } from "../../lib/cases.mjs";
import { heldOutAccessPath } from "../../lib/index.mjs";
import * as licence from "../../lib/licence.mjs";
import { boardConfigOf, MARTIAN_BOARD, martianBody, martianToolName, npmRegistryAnswer, REGISTRY, releaseGate } from "../../lib/martian-board.mjs";
import { attemptOf, findingId, judgeFieldsMissing, normPath, population, shownFindings } from "../../lib/score.mjs";
import { readCase, readPinned, truthOf } from "../../lib/suites.mjs";

const readJsonOr = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null);
const dirs = (path) => (existsSync(path) ? readdirSync(path, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : []);
const firstLine = (error) => String(error?.message ?? error).split("\n")[0];
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Every saved attempt of the run, as lib/score.mjs population reads them.
function readAttempts(folder) {
  const out = [];
  for (const c of dirs(join(folder, "samples"))) {
    for (const config of dirs(join(folder, "samples", c))) {
      for (const n of dirs(join(folder, "samples", c, config))) {
        const dir = join(folder, "samples", c, config, n);
        const which = attemptOf(n);
        if (which === null) throw new Error(`${dir} is not an attempt folder (<repeat> or <repeat>-attempt<n>)`);
        out.push({ case: c, config, ...which, row: readJsonOr(join(dir, "sample.json")), report: readJsonOr(join(dir, "report", "report.json")) });
      }
    }
  }
  return out;
}

// What happened to a planned review's first attempt, as our scorer reads it.
const statusOf = (first) => (first === null ? "unstarted" : first.report === null ? "failed" : first.report.completion?.status === "complete" ? "complete" : "incomplete");

/**
 * Converts the release run in `folder`: writes <folder>/outside/martian/
 * and returns { out, record, data } (record is convert.json, data
 * benchmark_data.json). Throws, writing and logging nothing, on a run that
 * is not a release run, a run of another suite, a case whose licence a
 * board refuses, a sample the run did not plan, a configuration the board
 * cannot name, or a run converted before. `root` and `cache` are the suite
 * root and the bench cache the cases and golden files are read from;
 * `accessLog` the held-out access log; `by` who converts; `registry`
 * answers as the npm registry does (lib/martian-board.mjs releaseGate).
 */
export async function convertRun(folder, { root = benchRoot, cache = licence.cacheRoot(), accessLog = accessLogPath(), by = null, now = () => new Date().toISOString(), registry = npmRegistryAnswer } = {}) {
  folder = resolve(folder);
  if (!existsSync(join(folder, "manifest.json"))) throw new Error(`${folder} has no manifest.json; it is not a benchmark run`);
  const manifestBytes = readFileSync(join(folder, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const suite = manifest.suite ?? "planted";
  if (suite !== "martian") throw new Error(`${folder}: the run is of suite ${suite}, not martian; only a run on Martian's cases is converted for its board`);
  if (manifest.mode === "scan") throw new Error(`${folder}: a scanner-only run shows the developer no finding, so it has nothing to convert for the board`);
  const gate = await releaseGate(manifest, { registry });
  const out = boardFolder(folder, "martian");
  if (existsSync(out)) throw new Error(`${out} exists already: the run was converted before (and maybe judged). Move that folder to the Trash to convert it again.`);

  // Everything that refuses the run, before anything is read of the truth.
  const attempts = readAttempts(folder);
  const pop = population(manifest, attempts);
  const problems = [...pop.problems];
  if (pop.jobs.length === 0) problems.push("the run plans no review");
  const planned = new Set(pop.jobs.map((j) => j.case));
  for (const j of pop.jobs) if (parseCaseId(j.caseId)?.suite !== "martian") problems.push(`${j.caseId}: not a Martian case`);
  for (const a of attempts) if (!planned.has(a.case)) problems.push(`samples/${a.case}/${a.config}: a sample of ${a.case}, which the run did not plan`);
  for (const a of pop.unplanned) if (planned.has(a.case)) problems.push(`samples/${a.case}/${a.config}/${a.repeat}: a review the run did not plan`);
  const tools = new Map();
  for (const j of pop.jobs) {
    let tool;
    try {
      tool = martianToolName(j.config, j.repeat);
    } catch (error) {
      problems.push(error.message);
      continue;
    }
    const was = tools.get(tool);
    if (was !== undefined && was !== j.config) problems.push(`${was} and ${j.config} would both go by the tool name ${tool}`);
    else tools.set(tool, j.config);
  }
  const cases = new Map();
  for (const id of [...new Set(pop.jobs.map((j) => j.caseId))].sort(byName)) {
    if (parseCaseId(id)?.suite !== "martian") continue;
    let c;
    try {
      c = readCase(id, { root });
    } catch (error) {
      problems.push(firstLine(error));
      continue;
    }
    const record = c.source?.licence ?? null;
    const why = record === null ? "its suite entry holds no licence record" : (licence.licenceExclusion(record) ?? licence.publishRefusal([{ name: c.name, licence: record.class }]));
    if (why !== null) problems.push(`${c.name}: ${why}; a case whose licence is not verified is never converted for a board`);
    cases.set(id, c);
  }
  if (problems.length > 0) throw new Error(`${folder} is not converted for Martian's board:\n${[...new Set(problems)].join("\n")}`);

  // The access to the held-out cases, logged before any golden comment is read.
  const access = { at: now(), suite: "martian", caseCount: cases.size, purpose: "release-run", runId: manifest.runId ?? basename(folder), release: manifest.release, by };
  try {
    mkdirSync(dirname(accessLog), { recursive: true });
    appendFileSync(accessLog, `${JSON.stringify(access)}\n`);
  } catch (error) {
    throw new Error(`the held-out access log ${accessLog} cannot be written (${firstLine(error)}), so no Martian case is read`);
  }

  // Each pull request's golden comments, from the pinned file, checked against the frozen truth.
  const data = {};
  const caseRows = [];
  for (const c of [...cases.values()].sort((a, b) => byName(a.name, b.name))) {
    const truth = truthOf(c, { cache });
    const row = readPinned(cache, "martian", { path: c.source.dataset.file, sha256: c.source.dataset.sha256 }).find((r) => r.url === c.source.prUrl);
    data[c.source.prUrl] = { pr_title: row.pr_title ?? null, original_url: row.original_url ?? null, source_repo: basename(c.source.dataset.file, ".json"), golden_comments: row.comments, golden_source_file: basename(c.source.dataset.file), openqodex: { caseId: c.id, case: c.name }, reviews: [] };
    caseRows.push({ caseId: c.id, case: c.name, goldenUrl: c.source.prUrl, golden: truth.items.length, licence: c.source.licence.class });
  }

  // One review per planned review's first attempt, by tool name and case.
  const jobs = pop.jobs.map((j) => ({ ...j, tool: martianToolName(j.config, j.repeat) })).sort((a, b) => byName(a.tool, b.tool) || byName(a.case, b.case));
  const held = [];
  const reviews = [];
  for (const job of jobs) {
    const url = cases.get(job.caseId).source.prUrl;
    const first = job.first;
    const shown = shownFindings(first?.report ?? null);
    const ids = shown.map((f) => findingId(job.caseId, f));
    shown.forEach((f, index) => {
      const lacking = judgeFieldsMissing(f);
      if (lacking.length > 0) held.push({ tool: job.tool, caseId: job.caseId, case: job.case, goldenUrl: url, index, findingId: ids[index], lacking });
    });
    const comments = shown.map((f) => ({ path: normPath(f.file_path) || null, line: Number.isInteger(f.line_number) ? f.line_number : null, body: martianBody(f), created_at: first?.row?.started_at ?? null }));
    reviews.push({ url, review: { tool: job.tool, repo_name: null, pr_url: url, review_comments: comments, openqodex: { caseId: job.caseId, case: job.case, config: job.config, repeat: job.repeat, attempt: 1, status: statusOf(first), findingIds: ids } } });
  }
  const heldTools = new Set(held.map((h) => h.tool));
  for (const { url, review } of reviews) if (!heldTools.has(review.tool)) data[url].reviews.push(review);

  const toolRows = [...tools.entries()]
    .sort((a, b) => byName(a[0], b[0]))
    .map(([tool, config]) => {
      const mine = jobs.filter((j) => j.tool === tool);
      const statuses = {};
      for (const j of mine) statuses[statusOf(j.first)] = (statuses[statusOf(j.first)] ?? 0) + 1;
      const lack = held.filter((h) => h.tool === tool);
      const why = lack.length === 0 ? null : `${lack.length} finding${lack.length === 1 ? " lacks" : "s lack"} what Martian's judge reads (${lack.map((h) => `${h.case} index ${h.index}: ${h.lacking.join(", ")}`).join("; ")}); none of this tool name's reviews is sent, since judging it without one of its pull requests would shrink Martian's denominators`;
      return { tool, config, boardConfig: boardConfigOf(config), repeat: mine[0].repeat, reviews: mine.length, findings: mine.reduce((n, j) => n + shownFindings(j.first?.report ?? null).length, 0), statuses, held: lack.length > 0, why };
    });
  const dataset = [...cases.values()][0].source.dataset;
  const record = {
    version: 1,
    board: "martian",
    repo: MARTIAN_BOARD.repo,
    commit: MARTIAN_BOARD.commit,
    golden: { repo: dataset.repo, revision: dataset.revision, files: [...new Set([...cases.values()].map((c) => `${c.source.dataset.file} ${c.source.dataset.sha256}`))].sort() },
    run: manifest.runId ?? null,
    release: manifest.release,
    suite,
    split: manifest.split ?? null,
    splitHash: manifest.splitHash ?? null,
    // What a judging checks before it judges (failure 9): the manifest converted, by its bytes.
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    package: { spec: gate.package.spec, version: gate.package.version, sha256: gate.package.sha256, integrity: gate.package.integrity },
    registry: REGISTRY,
    tool: "openqodex-<config>-r<repeat>",
    access,
    cases: caseRows,
    tools: toolRows,
    held,
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "benchmark_data.json"), `${JSON.stringify(data, null, 2)}\n`);
  writeFileSync(join(out, "convert.json"), `${JSON.stringify(record, null, 2)}\n`);
  return { out, record, data };
}

/** The held-out access log: OPENQODEX_BENCH_ACCESS_LOG (tests), else benchmark/index/heldout-access.jsonl. */
export const accessLogPath = (env = process.env) => env.OPENQODEX_BENCH_ACCESS_LOG || heldOutAccessPath();

/**
 * Where Martian's pinned checkout and its venv live in the bench cache:
 * { checkout, offline, venv, python }, each refused when its real path is in
 * the repository (a link under the cache can lead there).
 */
export function boardPaths(env = process.env) {
  const cache = benchCache(env);
  const upstream = outsideRepo(join(cache, "upstream"), "the cache folder of pinned checkouts");
  const checkout = outsideRepo(join(upstream, `code-review-benchmark@${MARTIAN_BOARD.commit}`), "Martian's checkout");
  const venv = outsideRepo(`${checkout}.venv`, "the venv of Martian's pipeline");
  return { checkout, offline: join(checkout, "offline"), venv, python: join(venv, "bin", "python") };
}

// Who converts, for the access line: this repository's git user, or null.
function gitUserName() {
  const r = spawnSync("git", ["config", "user.name"], { cwd: repoRoot, encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() !== "" ? r.stdout.trim() : null;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "pin" && args.length === 0) {
      console.log(`${MARTIAN_BOARD.repo} ${MARTIAN_BOARD.commit}`);
    } else if (command === "cache" && args.length === 0) {
      console.log(benchCache());
    } else if (command === "paths" && args.length === 0) {
      const p = boardPaths();
      console.log(`${p.checkout}\n${p.venv}`);
    } else if (command === "convert" && args.length === 1) {
      const { out, record } = await convertRun(args[0], { by: gitUserName() });
      const sent = record.tools.filter((t) => !t.held);
      console.log(`Converted ${record.cases.length} pull requests for ${sent.length} tool names (${sent.map((t) => t.tool).join(", ") || "none"}) under ${out}; the access is logged in ${accessLogPath()}.`);
      console.log(`Failed or never-started reviews written as empty: ${record.tools.reduce((n, t) => n + (t.statuses.failed ?? 0) + (t.statuses.unstarted ?? 0), 0)}.`);
      for (const t of record.tools.filter((x) => x.held)) console.log(`Held, not sent: ${t.tool}: ${t.why}`);
    } else {
      console.error("usage: node benchmark/outside/convert/martian.mjs convert <run> | pin | cache | paths");
      process.exit(2);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
