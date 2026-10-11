#!/usr/bin/env node
// Rescores a legacy run with the scorer that wrote each of its stored score
// files, and checks every number docs/benchmark.md quotes from it:
//
//   node benchmark/legacy/rescore.mjs <run-id>... [--results <folder>] [--no-docs]
//   node benchmark/legacy/rescore.mjs --all [--results <folder>]
//
// A legacy run is one of the 11 runs that were committed under
// benchmark/results/ before the results left the tree. Each is fetched with
// `node benchmark/fetch-run.mjs <run-id>`; its asset carries the scorer of
// every commit that wrote one of its score files, under
// _archive/<commit>/benchmark/ (score.mjs and lib/), taken with git from that
// commit when it was published. The recipe for each run is in
// benchmark/legacy/recipes.json: which commit's scorer wrote which file,
// against which specs, and the selections behind each number the docs quote.
//
// Exit codes: 0 every score file and every quoted number reproduces; 1 one
// does not (the difference is printed); 2 the rescore cannot run (a run or
// an archived scorer is missing, or the recipe is not sound).
//
// Failure list, written before the code:
// 1. An old run is scored with today's scorer, which reads other rules or
//    refuses the run's specs: the scorer is loaded only from the run's
//    _archive/<commit>/, its file list must hash to the recipe's sha256, and
//    a run without it is refused, never scored with today's code.
// 2. The rescore writes into the run, so the originals stop being the
//    published files: scorers are imported and called; nothing is written
//    into a results folder.
// 3. A stored score file is compared loosely and a changed number passes:
//    every key of the stored file is compared exactly with the rescored one,
//    except `run` and `specsFrom`, which name folders by where they lay; the
//    stored `specsFrom` must still name the specs the recipe says.
// 4. A number the docs quote is not the one the run gives: every table cell
//    of a results section and every quoted phrase in the recipe is computed
//    from the rescored samples, formatted the way the docs print it, and
//    compared with the docs' own text, which is read from the file each time.
// 5. A doc cell or table row escapes the check: every row and column of each
//    results table must be mapped in the recipe, or the rescore fails.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { benchRoot, repoRoot } from "../lib/cases.mjs";
import { fileList, listHash, resultsRoot, sha256 } from "../lib/index.mjs";

export const recipesPath = join(benchRoot, "legacy", "recipes.json");
export const readRecipes = () => JSON.parse(readFileSync(recipesPath, "utf8"));

const git = (...args) => execFileSync("git", args, { cwd: repoRoot, maxBuffer: 1 << 30 });

// The scorer of a commit as git holds it: benchmark/score.mjs and every file
// under benchmark/lib/, with their bytes.
export function scorerFiles(commit) {
  const listing = git("ls-tree", "-r", "-z", commit, "--", "benchmark/score.mjs", "benchmark/lib").toString("utf8").split("\0").filter(Boolean);
  if (listing.length === 0) throw new Error(`commit ${commit} holds no benchmark/score.mjs; is this a full clone?`);
  return listing
    .map((line) => {
      const [meta, path] = line.split("\t");
      const [, type, object] = meta.split(" ");
      if (type !== "blob") throw new Error(`${commit}:${path} is not a file`);
      return { path, bytes: git("cat-file", "blob", object) };
    })
    .sort((a, b) => (a.path < b.path ? -1 : 1));
}

export const scorerHash = (files) => listHash(files.map((f) => ({ path: f.path, sha256: sha256(f.bytes) })));
export const archiveDir = (commit) => `_archive/${commit}`;

// Writes the scorers of the given commits into a run folder's _archive/, as
// publish-run.mjs puts them into the asset. Used by the tests and for checks
// on a local copy; never on a published original.
export function archiveScorers(runFolder, commits) {
  for (const commit of commits) {
    for (const f of scorerFiles(commit)) {
      const to = join(runFolder, archiveDir(commit), f.path);
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, f.bytes);
    }
  }
}

// Every problem with the recipe file, one line each.
export function recipeProblems(recipes) {
  const p = [];
  const need = (cond, what) => {
    if (!cond) p.push(what);
  };
  need(recipes?.version === 1, "recipes.json: version must be 1");
  for (const [runId, r] of Object.entries(recipes?.runs ?? {})) {
    need(/^[0-9a-f]{40}$/.test(r.originals?.commit ?? "") && r.originals?.path === `benchmark/results/${runId}`, `${runId}: originals must name the commit and path that held the run`);
    need(Array.isArray(r.scores) && r.scores.some((s) => s.file === r.headline), `${runId}: headline must be one of its score files`);
    for (const s of r.scores ?? []) {
      need(typeof s.file === "string" && typeof s.scores === "string" && s.specs && typeof s.specs.run === "string" && typeof s.specs.folder === "string", `${runId}/${s.file}: file, scores and specs {run, folder} are required`);
      need(/^[0-9a-f]{40}$/.test(s.scorer?.commit ?? "") && /^[0-9a-f]{64}$/.test(s.scorer?.sha256 ?? ""), `${runId}/${s.file}: scorer must give the full commit and the sha256 of its file list`);
    }
    need(Array.isArray(r.notes), `${runId}: notes must list what the run did not record`);
  }
  for (const [id, src] of Object.entries(recipes?.sources ?? {})) {
    need(Array.isArray(src) && src.length > 0, `sources.${id}: must be a list of parts`);
    for (const part of src) need(recipes.runs?.[part.run]?.scores?.some((s) => s.file === part.score), `sources.${id}: ${part.run}/${part.score} is not a score file of a recipe`);
  }
  return p;
}

// --- loading a run with its own scorer ---

const scorerCache = new Map();
async function loadScorer(results, hostRun, scorer) {
  const folder = join(results, hostRun, archiveDir(scorer.commit));
  const entry = join(folder, "benchmark", "score.mjs");
  if (!existsSync(entry)) throw new Error(`${hostRun} has no archived scorer ${archiveDir(scorer.commit)}/benchmark/score.mjs; fetch the run with node benchmark/fetch-run.mjs ${hostRun}, whose asset carries it`);
  const files = fileList(folder).map((path) => ({ path, bytes: readFileSync(join(folder, path)) }));
  const got = scorerHash(files);
  if (got !== scorer.sha256) throw new Error(`${hostRun}: the archived scorer ${archiveDir(scorer.commit)} hashes to ${got}, not the recipe's ${scorer.sha256}`);
  const key = realpathSync(entry);
  if (!scorerCache.has(key)) {
    const cli = await import(pathToFileURL(key).href);
    const lib = await import(pathToFileURL(join(dirname(key), "lib", "score.mjs")).href);
    scorerCache.set(key, { cli, lib, path: `${archiveDir(scorer.commit)}/benchmark/score.mjs`, sha256: scorer.sha256 });
  }
  return scorerCache.get(key);
}

const ownSpecs = (s) => s.specs.run === s.scores && s.specs.folder === "cases";

// The folder name the stored score gives for its specs: absent from the
// first scorer, "the run's own cases/" for a run's own, else the folder.
const storedSpecsName = (s) => (ownSpecs(s) ? ["the run's own cases/", undefined] : [`benchmark/results/${s.specs.run}/${s.specs.folder}`]);

async function loadScored(results, hostRun, s) {
  const scorer = await loadScorer(results, hostRun, s.scorer);
  const runFolder = join(results, s.scores);
  if (!existsSync(join(runFolder, "manifest.json"))) throw new Error(`${hostRun}/${s.file} scores ${s.scores}, which is not in ${results}; fetch it with node benchmark/fetch-run.mjs ${s.scores}`);
  const specsDir = ownSpecs(s) ? null : join(results, s.specs.run, s.specs.folder);
  if (specsDir && !existsSync(specsDir)) throw new Error(`${hostRun}/${s.file} reads the specs in ${s.specs.run}/${s.specs.folder}, which is not in ${results}; fetch it with node benchmark/fetch-run.mjs ${s.specs.run}`);
  const run = scorer.cli.loadRun(runFolder, { specsDir });
  return { scorer, run };
}

// The paths at which two values differ, for the report.
function differences(a, b, at = "", out = []) {
  if (out.length >= 20) return out;
  if (isDeepStrictEqual(a, b)) return out;
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) differences(a[k], b[k], at === "" ? k : `${at}.${k}`, out);
    return out;
  }
  out.push(`${at}: stored ${JSON.stringify(a)}, rescored ${JSON.stringify(b)}`);
  return out;
}

async function rescoreFile(results, runId, s) {
  const stored = JSON.parse(readFileSync(join(results, runId, s.file), "utf8"));
  const { scorer, run } = await loadScored(results, runId, s);
  const doc = { ...scorer.cli.summary(run), comparedWith: null };
  const keys = [...new Set([...Object.keys(stored), ...Object.keys(doc)])].filter((k) => k !== "run" && k !== "specsFrom");
  const differs = keys.filter((k) => !isDeepStrictEqual(stored[k], doc[k]));
  const specsOk = storedSpecsName(s).includes(stored.specsFrom);
  return {
    file: s.file,
    scorer: scorer.path,
    byConfig: isDeepStrictEqual(stored.byConfig, doc.byConfig) ? "equal" : "different",
    differs,
    detail: differs.flatMap((k) => differences(stored[k], doc[k], k)),
    specs: specsOk ? "as the recipe says" : `the stored file names ${JSON.stringify(stored.specsFrom)}, the recipe ${storedSpecsName(s)[0]}`,
    ok: differs.length === 0 && specsOk,
  };
}

// --- the numbers the docs quote ---

// One selection of samples: parts from one or more score files, each loaded
// with its own scorer, filtered by configuration and case.
async function select(results, recipes, sourceId, cache) {
  const parts = recipes.sources[sourceId];
  if (!parts) throw new Error(`no source ${sourceId} in recipes.json`);
  const samples = [];
  const runs = [];
  let lib = null;
  let sha = null;
  for (const part of parts) {
    // The part's score file, and the scorer from the asset of the run that holds it.
    const s = recipes.runs[part.run].scores.find((x) => x.file === part.score);
    const key = `${part.run}\0${part.score}`;
    if (!cache.has(key)) cache.set(key, await loadScored(results, part.run, s));
    const { scorer, run } = cache.get(key);
    if (sha !== null && sha !== scorer.sha256) throw new Error(`source ${sourceId} mixes samples scored by different scorers`);
    sha = scorer.sha256;
    lib = scorer.lib;
    runs.push({ part, run, folder: join(results, s.scores) });
    samples.push(...run.samples.filter((x) => (!part.configs || part.configs.includes(x.config)) && (!part.cases || part.cases.includes(x.case)) && !(part.exceptCases ?? []).includes(x.case)));
  }
  return { samples, runs, lib };
}

const pct = (hit, of) => `${Math.round((hit / of) * 100)}%`;
const FORMATS = {
  ratioPct: (r) => `${r.hit}/${r.of} (${pct(r.hit, r.of)})`,
  ratio: (r) => `${r.hit}/${r.of}`,
  of: (r) => `${r.hit} of ${r.of}`,
  pct: (r) => pct(r.hit, r.of),
  noneOrRatio: (r) => (r.hit === 0 ? "none" : `${r.hit}/${r.of}`),
  int: (n) => String(n),
  secs: (ms) => `${(ms / 1000).toFixed(0)} s`,
  secsComma: (ms) => `${Math.round(ms / 1000).toLocaleString("en-US")} s`,
  usd: (x) => `$${x.toFixed(2)}`,
  fixed1: (x) => x.toFixed(1),
  fixed2: (x) => x.toFixed(2),
  string: (x) => String(x),
};

const sumRatios = (rs) => rs.reduce((a, r) => ({ hit: a.hit + r.hit, of: a.of + r.of }), { hit: 0, of: 0 });
const getPath = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

// The value of one measure over one selection. Measures read only what the
// archived scorer computed, except `briefsWith` and `judge`, which read
// files of the run and say so in the recipe.
async function measure(results, recipes, spec, cache) {
  if (spec.measure === "judge") {
    const judge = JSON.parse(readFileSync(join(results, spec.run, "judge.json"), "utf8"));
    return judgeTotals(judge, spec);
  }
  const sel = await select(results, recipes, spec.source, cache);
  const samples = sel.samples.filter((x) => (!spec.cases || spec.cases.includes(x.case)) && !(spec.exceptCases ?? []).includes(x.case));
  if (spec.cases && samples.length === 0) return "not in the run";
  const S = sel.lib.summarize(samples);
  switch (spec.measure) {
    case "manifest":
      return getPath(sel.runs[0].run.manifest, spec.path);
    case "count":
      return getPath(sel.runs[0].run.manifest, spec.path).length;
    case "specsDiffer":
      return sel.runs[0].run.specsDiffer.length;
    case "gapsAndCallers":
      return sumRatios([S.gaps, S.callers]);
    case "reviewsMissingGaps":
      return { hit: samples.filter((x) => x.gaps.hit < x.gaps.of).length, of: samples.length };
    case "gapsPerReview":
      return [...new Set(samples.map((x) => `${x.gaps.hit}/${x.gaps.of}`))].sort();
    case "rounds":
      return sel.lib.stats(samples.map((x) => x.rounds)).mean;
    case "bug": {
      const b = sel.lib.bugStability(samples).find((x) => x.case === spec.case && x.bug === spec.bug);
      if (!b) throw new Error(`${spec.source}: no bug ${spec.case}/${spec.bug}`);
      return { hit: b.found, of: b.of };
    }
    case "missed":
      return sel.lib
        .bugStability(samples)
        .filter((b) => b.found < b.of)
        .map((b) => `${b.case}/${b.bug}`)
        .sort();
    case "sampleField":
      return samples.map((x) => getPath(x, spec.field));
    case "briefsWith": {
      const hit = samples.filter((x) => {
        const attempt = x.attempt > 1 ? `${x.repeat}-attempt${x.attempt}` : String(x.repeat);
        const owner = sel.runs.find((r) => r.run.samples.includes(x));
        const path = join(owner.folder, "samples", x.case, x.config, attempt, "report", "brief.md");
        return existsSync(path) && readFileSync(path, "utf8").includes(spec.text);
      }).length;
      return { hit, of: samples.length };
    }
    default: {
      const v = getPath(S, spec.measure);
      if (v === undefined) throw new Error(`no measure ${spec.measure}`);
      return v;
    }
  }
}

// The wording judge's totals, counted again from its saved verdicts.
function judgeTotals(judge, spec) {
  const out = { findings: 0, unparsed: 0, problem: {}, consequence: {}, fix: {} };
  for (const s of judge.samples) {
    if (spec.configs && !spec.configs.includes(s.config)) continue;
    for (const f of s.findings ?? []) {
      out.findings++;
      if (!f.verdict) {
        out.unparsed++;
        continue;
      }
      for (const part of ["problem", "consequence", "fix"]) {
        for (const q of ["plain", "correct"]) {
          out[part][q] ??= { hit: 0, of: 0 };
          out[part][q].of++;
          if (f.verdict[part]?.[q] === true) out[part][q].hit++;
        }
      }
    }
  }
  return getPath(out, spec.path);
}

// The text of one section of the docs: from its heading to the next heading.
function section(doc, heading) {
  const lines = doc.split("\n");
  const at = lines.findIndex((l) => /^#{2,4} /.test(l) && l.replace(/^#+ /, "") === heading);
  if (at === -1) throw new Error(`docs: no section "${heading}"`);
  const end = lines.findIndex((l, i) => i > at && /^#{1,4} /.test(l));
  return lines.slice(at + 1, end === -1 ? undefined : end).join("\n");
}

const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
function table(text) {
  const rows = text.split("\n").filter((l) => l.trim().startsWith("|"));
  if (rows.length < 3) throw new Error("docs: the section has no table");
  return { head: cells(rows[0]), body: rows.slice(2).map(cells) };
}

const show = (v) => (typeof v === "string" ? v : JSON.stringify(v));

async function checkDocs(results, recipes, runIds, cache) {
  const docs = recipes.docs;
  const text = readFileSync(join(repoRoot, docs.file), "utf8");
  const out = [];
  // A number involves a run when it is read from one of the run's score
  // files, or from a score file that scores the run's samples.
  const touches = (spec) => (spec.measure === "judge" ? runIds.includes(spec.run) : (recipes.sources[spec.source] ?? []).some((p) => runIds.includes(p.run) || runIds.includes(recipes.runs[p.run].scores.find((s) => s.file === p.score).scores)));
  const compute = async (spec) => {
    const v = await measure(results, recipes, spec, cache);
    if (v === "not in the run") return v;
    const f = FORMATS[spec.format ?? "string"];
    if (!f) throw new Error(`no format ${spec.format}`);
    return Array.isArray(v) ? v.map(f) : f(v);
  };
  for (const t of docs.tables) {
    const { head, body } = table(section(text, t.section));
    const columns = head.slice(1);
    for (const c of columns) if (!(c in t.columns)) out.push({ what: `${t.section}: column "${c}"`, ok: false, detail: "the recipe does not map this column" });
    for (const row of body) {
      const label = row[0];
      const rowSpec = t.rows[label];
      if (!rowSpec) {
        out.push({ what: `${t.section}: row "${label}"`, ok: false, detail: "the recipe does not map this row" });
        continue;
      }
      for (const [i, c] of columns.entries()) {
        const source = t.columns[c];
        if (source === undefined) continue;
        const override = t.cells?.[`${label}|${c}`];
        const spec = { ...rowSpec, source, ...override };
        if (!touches(spec)) continue;
        const what = `${t.section}: ${label} | ${c}`;
        if (override?.given) {
          out.push({ what, ok: row[i + 1] === override.given, detail: `the docs give "${row[i + 1]}"; the recipe says "${override.given}" (${override.why})` });
          continue;
        }
        const got = await compute(spec);
        out.push({ what, ok: got === row[i + 1], detail: `docs "${row[i + 1]}", rescored "${show(got)}"` });
      }
    }
  }
  for (const q of docs.quotes) {
    const body = section(text, q.section);
    const present = body.includes(q.text);
    for (const check of q.checks) {
      if (!touches(check)) continue;
      const got = await compute(check);
      const ok = present && isDeepStrictEqual(got, check.expect);
      out.push({ what: `${q.section}: "${q.text}"`, ok, detail: present ? `expected ${show(check.expect)}, rescored ${show(got)}` : "the docs no longer hold this text" });
    }
  }
  return out;
}

// Rescores one run: each of its score files with its own scorer, then the
// docs numbers that involve it. Nothing is written.
export async function rescoreRun(runId, { results = resultsRoot, files = null, docs = true, recipes = readRecipes() } = {}) {
  const problems = recipeProblems(recipes);
  if (problems.length > 0) throw new Error(`recipes.json is not sound:\n${problems.join("\n")}`);
  const r = recipes.runs[runId];
  if (!r) throw new Error(`${runId} is not a legacy run; recipes.json has no recipe for it`);
  if (!existsSync(join(results, runId, "manifest.json"))) throw new Error(`${runId} is not in ${results}; fetch it with node benchmark/fetch-run.mjs ${runId}`);
  const out = { runId, files: [], quotes: [] };
  for (const s of r.scores.filter((x) => files === null || files.includes(x.file))) out.files.push(await rescoreFile(results, runId, s));
  if (docs) out.quotes = await checkDocs(results, recipes, [runId], new Map());
  out.ok = out.files.every((f) => f.ok) && out.quotes.every((q) => q.ok);
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  let results = resultsRoot;
  let docs = true;
  let all = false;
  const ids = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--results") results = args[++i];
    else if (args[i] === "--no-docs") docs = false;
    else if (args[i] === "--all") all = true;
    else ids.push(args[i]);
  }
  const recipes = readRecipes();
  const runIds = all ? Object.keys(recipes.runs) : ids;
  if (runIds.length === 0 || results === undefined) {
    console.error("usage: node benchmark/legacy/rescore.mjs <run-id>... | --all [--results <folder>] [--no-docs]");
    process.exit(2);
  }
  let failed = 0;
  // One number can involve several runs; counted once across them.
  const distinct = new Map();
  try {
    for (const id of runIds) {
      const r = await rescoreRun(id, { results, docs, recipes });
      for (const f of r.files) {
        console.log(`${id}/${f.file}: ${f.ok ? "reproduces" : "DIFFERS"} with ${f.scorer} (byConfig ${f.byConfig}; specs ${f.specs})`);
        for (const d of f.detail) console.log(`  ${d}`);
      }
      const bad = r.quotes.filter((q) => !q.ok);
      console.log(`${id}: ${r.quotes.length - bad.length} of ${r.quotes.length} quoted numbers reproduce`);
      for (const q of bad) console.log(`  DIFFERS ${q.what}: ${q.detail}`);
      for (const q of r.quotes) distinct.set(`${q.what}\0${q.detail}`, q.ok);
      if (!r.ok) failed++;
    }
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  if (runIds.length > 1 && docs) {
    const bad = [...distinct.values()].filter((ok) => !ok).length;
    console.log(`Across these runs: ${distinct.size - bad} of ${distinct.size} distinct numbers in ${recipes.docs.file} reproduce; ${recipes.docs.unchecked.length} statements there cannot be read from the run files (recipes.json docs.unchecked says why).`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
