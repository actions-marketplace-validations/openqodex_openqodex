#!/usr/bin/env node
// Classes every scanner candidate the reviewer dropped in a saved run, from
// its files only, and draws a blind sample for a person to rule on:
//
//   node benchmark/drops.mjs <run>... [--audit N] [--seed S] [--json]
//
// <run> is a run folder, or a run id under benchmark/results (fetch a
// published one with fetch-run.mjs). Prints, per run, the drops by class
// with what each class points at, the tags, and the rule false positives by
// rule. With --audit N it prints instead N drops drawn at random (seed S,
// 1 by default) from every run given, as a sheet that names no run, build,
// configuration or case, so the person rules on what they read. --json
// prints the same as JSON. The classes and their order are in
// lib/drops.mjs.
//
// Exit codes: 0 printed; 2 a run cannot be read.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resultsRoot } from "./lib/index.mjs";
import { DROPS_VERSION, DROP_CLASSES, POINTS_AT, TAG_POINTS_AT, auditItems, auditSheet, classifyReportDrops, countDrops, drawAudit, redactor } from "./lib/drops.mjs";

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};
const dirs = (path) => (existsSync(path) ? readdirSync(path, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : []);

// Every saved review of a run, in a fixed order, with its drops classed.
// A sample with no report.json dropped nothing; one with no scan.json is
// classed without the raised candidates' own lines or the frameworks.
// `known` lists the run's own identifiers (its id and folder, its build,
// configurations and cases) for the audit's redactor.
export function loadRunDrops(folder) {
  const manifest = readJson(join(folder, "manifest.json"));
  if (!manifest) throw new Error(`${folder} has no manifest.json; it is not a benchmark run`);
  const samples = join(folder, "samples");
  const drops = [];
  let reviews = 0;
  const known = [
    { kind: "run", value: basename(folder) },
    { kind: "run", value: folder },
    { kind: "build", value: manifest.build?.commit },
    { kind: "build", value: manifest.build?.short },
    ...(manifest.configs ?? []).map((value) => ({ kind: "configuration", value })),
    ...(manifest.cases ?? []).map((value) => ({ kind: "case", value })),
  ];
  for (const c of dirs(samples)) {
    known.push({ kind: "case", value: c });
    for (const config of dirs(join(samples, c))) {
      known.push({ kind: "configuration", value: config });
      for (const n of dirs(join(samples, c, config))) {
        const dir = join(samples, c, config, n, "report");
        const report = readJson(join(dir, "report.json"));
        if (!report) continue;
        reviews++;
        const scan = readJson(join(dir, "scan.json"));
        for (const d of classifyReportDrops(report, scan)) drops.push({ sample: { case: c, config, attempt: n }, ...d });
      }
    }
  }
  return { run: basename(folder), reviews, drops, known };
}

function parseArgs(argv) {
  const o = { runs: [], audit: null, seed: 1, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const num = (name) => {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 0) throw new Error(`${name} needs a whole number`);
      return v;
    };
    if (a === "--audit") o.audit = num("--audit");
    else if (a === "--seed") o.seed = num("--seed");
    else if (a === "--json") o.json = true;
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else o.runs.push(a);
  }
  if (o.runs.length === 0) throw new Error("name at least one run: a folder or a run id under benchmark/results");
  return o;
}

const folderOf = (run) => (existsSync(run) ? resolve(run) : join(resultsRoot, run));
const pct = (n, of) => (of === 0 ? "0%" : `${Math.round((100 * n) / of)}%`);

function table(r) {
  const k = countDrops(r.drops);
  const out = [`## ${r.run}: ${k.total} drops in ${r.reviews} reviews`, "", "| class | drops | share | points at |", "| --- | --- | --- | --- |"];
  for (const cls of DROP_CLASSES) out.push(`| ${cls} | ${k.byClass[cls]} | ${pct(k.byClass[cls], k.total)} | ${POINTS_AT[cls]} |`);
  out.push("");
  const tags = Object.entries(k.byTag);
  out.push(`Tags: ${tags.length === 0 ? "none" : tags.map(([t, n]) => `${t} ${n} (points at ${TAG_POINTS_AT[t] ?? "nothing named"})`).join(", ")}.`);
  if (k.ruleFpByRule.length > 0) {
    out.push("", "Rule false positives by rule:");
    for (const x of k.ruleFpByRule) out.push(`- ${x.token}: ${x.drops}`);
  }
  out.push("");
  return { text: out.join("\n"), counts: k };
}

function main() {
  let o;
  let runs;
  try {
    o = parseArgs(process.argv.slice(2));
    runs = o.runs.map((r) => loadRunDrops(folderOf(r)));
  } catch (e) {
    process.stderr.write(`drops: ${e.message}\n`);
    return 2;
  }
  if (o.audit !== null) {
    const pool = runs.flatMap((r) => r.drops);
    // Both formats print the same items, each text through one redactor.
    const items = auditItems(drawAudit(pool, o.audit, o.seed), redactor(runs.flatMap((r) => r.known)));
    if (o.json) process.stdout.write(`${JSON.stringify({ version: DROPS_VERSION, seed: o.seed, of: pool.length, items }, null, 2)}\n`);
    else process.stdout.write(`${auditSheet(items, { seed: o.seed, of: pool.length })}\n`);
    return 0;
  }
  const tables = runs.map(table);
  if (o.json) process.stdout.write(`${JSON.stringify({ version: DROPS_VERSION, runs: runs.map((r, i) => ({ run: r.run, reviews: r.reviews, ...tables[i].counts })) }, null, 2)}\n`);
  else process.stdout.write(tables.map((t) => t.text).join("\n"));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
