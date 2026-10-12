#!/usr/bin/env node
// The proof that every case of the outside suites builds, before any model
// is spent on them (PLAN-benchmark P4-03):
//
//   node benchmark/proof.mjs [--suite martian|aacr] [--split test|dev]
//                            [--shape server|laptop] [--from <folder>]
//
// For each suite (both when --suite is left out) and each side of its split
// (the held-out test side first; every Martian case is held out, so its
// test side only), it runs
//   node benchmark/run.mjs --materialise-only --suite <suite> --split <side>
// into benchmark/results/proof-<time>/<suite>-<side>/proof.json, in the
// shape a model review reads (server: the base and the head as two
// commits), or with --shape laptop the shape Claude Code, Codex and scans
// read (the change uncommitted). run.mjs logs each suite's held-out cases in
// benchmark/index/heldout-access.jsonl before it builds any. The proof
// folder's proof-run.json records the commit the proofs ran on. --from
// <folder> reads the proof.json files of an earlier proof folder instead of
// running again, and refuses a folder whose proof-run.json records no
// commit. --split proves one side only.
//
// It then writes one summary per suite, which is committed:
// benchmark/index/proof/<suite>-<date>.json, or <suite>-<side>-<date>.json
// for one side, so a summary of one side never takes a whole suite's name.
// Per case: its licence class,
// upstream's base, head and merge base (where it came from, git or frozen
// in the entry, every merge base git found in the order of the rule named
// beside them), the merge base's and the head's tree
// ids beside the built ones, whether the merge base is an ancestor of the
// head (with the deepening of the commits cache that answer took, if any),
// and the reason when the case did not build or prove. `commit` is the
// commit the proofs ran on; `summarisedAt` is the commit of the checkout
// that wrote the summary, which differs only after --from.
// Exit codes: 0 every case proved, 1 a case failed (the summary is still
// written, with the case and its reason), 2 the proof could not run.
//
// Failure list, written before the code:
// 1. A case that failed is summarised as proved, or left out: a case is
//    proved only when its proof is ok, it has a licence class, its built
//    trees are upstream's and its merge base is proved an ancestor of its
//    head. Every usable case on each side of the suite's split is in the
//    summary, and one with no proof is a failure.
// 2. A summary holds a machine path: the clone cache, this checkout, the
//    temp folder and the home folder become <cache>, <checkout>, <tmp> and
//    <home>, a file URL becomes file://<path>, and any other absolute path
//    <path>, this machine's or another's, a drive letter path included and
//    one right after a colon. A summary that still holds one is never
//    written.
// 3. A proof's flags say its trees match while the tree ids it records
//    differ: the summary compares the ids itself, and such a case fails
//    with both ids.
// 4. A summary of a saved proof folder names the summariser's checkout as
//    the commit the proofs ran on: --from reads that commit from the
//    folder's proof-run.json and refuses a folder that records none.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { benchRoot, git, repoRoot } from "./lib/cases.mjs";
import { indexRoot, resultsRoot } from "./lib/index.mjs";
import { cacheRoot } from "./lib/licence.mjs";
import { SUITES, listCases } from "./lib/suites.mjs";

const USAGE = "usage: node benchmark/proof.mjs [--suite martian|aacr] [--split test|dev] [--shape server|laptop] [--from <folder>]";
const RUN = join(benchRoot, "run.mjs");

// ---------- machine paths ----------

// A file URL, and any absolute path: a "/" or a drive letter ("C:\" or
// "C:/") that does not continue a word, a path or a URL, after any other
// character, a colon included (cwd:/a/b). So never a URL's path
// (https://host/a), a path inside a repository (refs/pull/1/head), or the
// rest of a path the summary already names by its placeholder
// (<cache>/cases/...).
const FILE_URL = /file:\/\/[^\s"'`)\]>,;]*/g;
const ABSOLUTE = /(?<![\w.~/\\-])(?<!<(?:cache|checkout|tmp|home|path)>)(?:\/(?![/\s])|[A-Za-z]:[\\/])[^\s"'`)\],;]+/g;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

// This machine's folders a proof may name, each with the placeholder a
// summary names it by, longest first, real paths included.
function machineRoots(cache) {
  const roots = [];
  for (const [path, label] of [[cache, "<cache>"], [repoRoot, "<checkout>"], [tmpdir(), "<tmp>"], [homedir(), "<home>"]]) {
    for (const p of new Set([path, existsSync(path) ? realpathSync(path) : path])) if (p && p !== "/") roots.push({ path: p.replace(/\/+$/, ""), label });
  }
  return roots.sort((a, b) => b.path.length - a.path.length);
}

function scrub(value, roots) {
  if (typeof value === "string") {
    let s = value.replace(FILE_URL, "file://<path>");
    for (const { path, label } of roots) s = s.split(path).join(label);
    return s.replace(ABSOLUTE, "<path>");
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, roots));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, roots)]));
  return value;
}

/** Every machine path `text` still holds: one of this machine's folders, a file URL with its path, or another absolute path. */
export function machinePathsIn(text, { cache = cacheRoot() } = {}) {
  const hits = machineRoots(cache).filter(({ path }) => text.includes(path)).map(({ path }) => path);
  for (const m of text.matchAll(/file:\/\/(?!<path>)[^\s"'`)\],;]*/g)) hits.push(m[0]);
  for (const m of text.matchAll(ABSOLUTE)) hits.push(m[0]);
  return [...new Set(hits)];
}

// ---------- the summary ----------

const nameOf = (id) => id.slice(id.indexOf("/") + 1, id.lastIndexOf("@"));

// One case of the summary from its proof (lib/materialise-only.mjs), or a
// failure when there is none (failure 1).
function caseSummary(id, split, p) {
  if (!p) return { caseId: id, name: nameOf(id), split, ok: false, licence: null, baseSha: null, headSha: null, mergeBaseSha: null, mergeBaseFrom: null, mergeBases: null, mergeBaseRule: null, ancestorOfHead: null, deepening: null, trees: null, fsck: null, error: "no proof was written for this case" };
  const u = p.upstream ?? null;
  const ancestorOfHead = p.ancestor?.isAncestor ?? null;
  const reasons = [];
  if (p.ok !== true || p.error) reasons.push(p.error ?? "its proof says it is not proved");
  else {
    if (!u || p.trees?.base !== true || p.trees?.head !== true) reasons.push("its proof does not show that the built trees are upstream's");
    // The flags are checked against the tree ids they stand for (failure 3).
    if (u && (!COMMIT.test(u.mergeBaseTree ?? "") || u.mergeBaseTree !== p.built?.baseTree)) reasons.push(`the built base tree ${p.built?.baseTree ?? "none"} is not upstream's merge base tree ${u.mergeBaseTree ?? "none"}`);
    if (u && (!COMMIT.test(u.headTree ?? "") || u.headTree !== p.built?.headTree)) reasons.push(`the built head tree ${p.built?.headTree ?? "none"} is not upstream's head tree ${u.headTree ?? "none"}`);
    if (ancestorOfHead !== true) reasons.push(`its merge base is not proved an ancestor of its head: ${p.ancestor?.why ?? "no answer is recorded"}`);
  }
  if (!p.licence?.class) reasons.push("it has no licence class");
  return {
    caseId: id,
    name: p.name ?? nameOf(id),
    split,
    ok: reasons.length === 0,
    licence: p.licence ? { class: p.licence.class ?? null, spdx: p.licence.spdx ?? null } : null,
    baseSha: u?.baseSha ?? null,
    headSha: u?.headSha ?? null,
    mergeBaseSha: u?.mergeBaseSha ?? null,
    mergeBaseFrom: u?.mergeBaseFrom ?? null,
    mergeBases: u?.mergeBases ?? null,
    mergeBaseRule: u?.mergeBaseRule ?? null,
    ancestorOfHead,
    deepening: p.ancestor?.deepening ?? null,
    trees: u ? { mergeBase: u.mergeBaseTree ?? null, head: u.headTree ?? null, builtBase: p.built?.baseTree ?? null, builtHead: p.built?.headTree ?? null } : null,
    fsck: p.built?.fsck ?? null,
    error: reasons.length === 0 ? null : reasons.join("; "),
  };
}

const tally = (values) => values.reduce((n, v) => ({ ...n, [v]: (n[v] ?? 0) + 1 }), {});

/**
 * One suite's summary from the proof.json documents run.mjs --materialise-only
 * wrote, one per side of the split. `expected` lists every case the suite
 * selects ({ id, split }); a proof of a case it does not list is kept too.
 * Machine paths are replaced by placeholders (failure 2).
 */
export function summariseProofs({ suite, date, shape, proofs, expected, cache = cacheRoot(), commit = null, summarisedAt = null, sources = null, excluded = null }) {
  const byId = new Map();
  for (const doc of proofs) for (const p of doc.cases ?? []) byId.set(p.caseId, { p, split: doc.split ?? p.split ?? null });
  const listed = new Set(expected.map((e) => e.id));
  const cases = [...expected.map(({ id, split }) => caseSummary(id, split, byId.get(id)?.p)), ...[...byId].filter(([id]) => !listed.has(id)).map(([id, { p, split }]) => ({ ...caseSummary(id, split, p), ok: false, error: `${p.error ? `${p.error}; ` : ""}it is not a usable case of the ${suite} suite's split` }))];
  const failures = cases.filter((c) => !c.ok).map((c) => ({ caseId: c.caseId, split: c.split, error: c.error }));
  const deepened = cases.filter((c) => c.deepening);
  const doc = {
    version: 1,
    purpose: "materialise-only proof",
    suite,
    date,
    shape,
    commit,
    summarisedAt,
    sources,
    runs: proofs.map((d) => ({ split: d.split ?? null, startedAt: d.startedAt ?? null, proved: d.proved ?? null, failed: d.failed ?? null, heldOut: d.heldOut ?? null, access: d.access ?? [] })),
    counts: {
      cases: cases.length,
      proved: cases.length - failures.length,
      failed: failures.length,
      excluded,
      licence: tally(cases.map((c) => c.licence?.class ?? "none")),
      ancestorOfHead: { yes: cases.filter((c) => c.ancestorOfHead === true).length, no: cases.filter((c) => c.ancestorOfHead === false).length, unknown: cases.filter((c) => c.ancestorOfHead === null).length },
      deepened: deepened.length,
      commitsAdded: deepened.reduce((n, c) => n + (c.deepening.commitsAdded ?? 0), 0),
    },
    failures,
    cases,
  };
  return scrub(doc, machineRoots(cache));
}

/** Writes a summary, refused (nothing written) when it holds a machine path. */
export function writeSummary(path, doc, { cache = cacheRoot() } = {}) {
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  const hits = machinePathsIn(text, { cache });
  if (hits.length > 0) throw new Error(`the summary holds a machine path (${hits.slice(0, 3).join(", ")}${hits.length > 3 ? ", ..." : ""}), so ${path} is not written`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

// ---------- the command ----------

/**
 * The record a proof folder keeps of its run: { version, commit, startedAt,
 * shape }, commit being the commit the proofs ran on. Throws when the folder
 * has none, or it names no full commit id (failure 4).
 */
export function readProofRun(folder) {
  const file = join(folder, "proof-run.json");
  if (!existsSync(file)) throw new Error(`${folder} carries no proof-run.json, so it records no commit its proofs ran on; --from summarises only a folder that records one`);
  let record;
  try {
    record = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} cannot be read (${error.message})`);
  }
  if (!COMMIT.test(record?.commit ?? "")) throw new Error(`${file} records no commit its proofs ran on: ${JSON.stringify(record?.commit ?? null)} is not a full commit id`);
  return record;
}

function parseArgs(argv) {
  const o = { suites: [], split: null, shape: "server", from: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--suite") o.suites.push(...next().split(",").filter(Boolean));
    else if (a === "--split") o.split = next();
    else if (a === "--shape") o.shape = next();
    else if (a === "--from") o.from = resolve(next());
    else throw new Error(`unknown flag ${a}`);
  }
  if (o.suites.length === 0) o.suites = Object.keys(SUITES);
  for (const s of o.suites) if (!SUITES[s]) throw new Error(`--suite takes ${Object.keys(SUITES).join(" or ")}, not ${s}`);
  if (o.split !== null && o.split !== "test" && o.split !== "dev") throw new Error(`--split takes test or dev, not ${o.split}`);
  for (const s of o.suites) if (o.split === "dev" && SUITES[s].heldOutOnly) throw new Error(`--split dev: every ${s} case is held out, so ${s} has no development side`);
  if (o.shape !== "server" && o.shape !== "laptop") throw new Error(`--shape takes server or laptop, not ${o.shape}`);
  if (o.from !== null && !existsSync(o.from)) throw new Error(`--from: there is no folder ${o.from}`);
  return o;
}

const fileSha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function main(argv) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    return 2;
  }
  const stamp = new Date().toISOString();
  const runRoot = o.from ?? join(resultsRoot, `proof-${stamp.replace(/[:.]/g, "-")}`);
  const head = git(repoRoot, "rev-parse", "HEAD").trim();
  // The commit the proofs ran on: read from a saved folder, recorded in a new one (failure 4).
  let commit = head;
  if (o.from !== null) commit = readProofRun(o.from).commit;
  else {
    mkdirSync(runRoot, { recursive: true });
    writeFileSync(join(runRoot, "proof-run.json"), `${JSON.stringify({ version: 1, commit, startedAt: stamp, shape: o.shape }, null, 2)}\n`);
  }
  let failed = 0;
  for (const suite of o.suites) {
    const def = SUITES[suite];
    // The held-out side first: it is the side a release run needs proved.
    const sides = (def.heldOutOnly ? ["test"] : ["test", "dev"]).filter((side) => o.split === null || side === o.split);
    const proofs = [];
    for (const side of sides) {
      const folder = join(runRoot, `${suite}-${side}`);
      if (o.from === null) {
        console.log(`Proving the ${suite} ${side} split into ${folder}`);
        const shapeArgs = o.shape === "server" ? ["--reviewers", "model:scripted"] : ["--mode", "scan"];
        const r = spawnSync(process.execPath, [RUN, "--materialise-only", "--suite", suite, "--split", side, ...shapeArgs, "--out", folder], { cwd: repoRoot, stdio: "inherit" });
        if (r.error || (r.status !== 0 && r.status !== 1)) {
          console.error(`run.mjs --materialise-only on the ${suite} ${side} split could not run (${r.error?.message ?? `exit ${r.status}`}); no summary is written for ${suite}`);
          return 2;
        }
      }
      const file = join(folder, "proof.json");
      if (!existsSync(file)) {
        console.error(`${file} is missing; no summary is written for ${suite}`);
        return 2;
      }
      try {
        proofs.push(JSON.parse(readFileSync(file, "utf8")));
      } catch (error) {
        throw new Error(`${file} cannot be read (${error.message}); no summary is written for ${suite}`);
      }
    }
    const shapes = [...new Set(proofs.map((p) => p.shape))];
    if (shapes.length !== 1 || (o.from === null && shapes[0] !== o.shape)) {
      console.error(`the ${suite} proofs were built in the ${shapes.join(" and ")} shape${shapes.length === 1 ? "" : "s"}, not the one shape asked for (${o.shape}); no summary is written`);
      return 2;
    }
    const expected = sides.flatMap((side) => listCases({ suite, split: side }).map((id) => ({ id, split: side })));
    const suiteFile = join(benchRoot, def.cases);
    const splitFile = join(benchRoot, def.split);
    const excluded = JSON.parse(readFileSync(suiteFile, "utf8")).cases.filter((c) => c.status !== "usable").length;
    const sources = { cases: `benchmark/${def.cases}`, casesSha256: fileSha(suiteFile), split: `benchmark/${def.split}`, splitSha256: fileSha(splitFile) };
    const date = (proofs.map((p) => p.startedAt).filter(Boolean).sort()[0] ?? stamp).slice(0, 10);
    const summary = summariseProofs({ suite, date, shape: shapes[0], proofs, expected, commit, summarisedAt: head, sources, excluded });
    const out = join(indexRoot, "proof", `${suite}-${o.split === null || def.heldOutOnly ? "" : `${o.split}-`}${date}.json`);
    try {
      writeSummary(out, summary);
    } catch (error) {
      console.error(error.message);
      return 2;
    }
    const c = summary.counts;
    console.log(`${suite}: ${c.proved} of ${c.cases} cases proved, ${c.failed} failed; merge base an ancestor of the head in ${c.ancestorOfHead.yes}; ${c.deepened} commits caches deepened. Summary: ${relative(repoRoot, out)}`);
    for (const f of summary.failures) console.log(`  ${f.caseId} (${f.split}): ${f.error}`);
    failed += c.failed;
  }
  if (o.from === null) console.log(`The proof files are in ${runRoot}; node benchmark/proof.mjs --from ${relative(process.cwd(), runRoot) || "."} summarises them again.`);
  return failed === 0 ? 0 : 1;
}

// Anything thrown (an unreadable proof.json, a suite file that cannot be
// read) is the proof failing to run, exit 2, never exit 1, which says a case
// failed.
function run(argv) {
  try {
    return main(argv);
  } catch (error) {
    console.error(`the proof could not run: ${error.message}`);
    return 2;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = run(process.argv.slice(2));
