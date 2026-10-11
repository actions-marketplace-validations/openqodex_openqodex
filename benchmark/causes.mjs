#!/usr/bin/env node
// Why each truth item was missed and each counted finding is not a hit, in
// saved runs, from their files only:
//
//   node benchmark/causes.mjs <run> [--specs <folder>] [<run> [--specs <folder>]]...
//                             [--decisions <file>] [--json]
//
// <run> is a run folder, or a run id under benchmark/results (fetch a
// published one with fetch-run.mjs). --specs scores the run named before it
// against other specs, such as an amended copy; a folder name that is not a
// path is looked up inside that run (cases-v2). The rulings are those of the
// adjudication file, benchmark/review-queue/decisions.jsonl unless
// --decisions names another, read as score.mjs reads them. Prints, per run
// and configuration, the misses and the counted non-hits by cause, then one
// table across the runs with the reviews each cause holds, and the dropped
// candidates by their class from drops.mjs. --json prints every row with
// its reason. The causes and their order are in lib/causes.mjs. Nothing is
// written: score.mjs writes the same causes into score.json and
// outcomes.jsonl.
//
// Exit codes: 0 printed; 2 a run cannot be read or scored.
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CAUSE_TEXT, CAUSES_VERSION, MISS_CAUSES, NON_HIT_CAUSES, countCauses } from "./lib/causes.mjs";
import { DROP_CLASSES } from "./lib/drops.mjs";
import { resultsRoot } from "./lib/index.mjs";
import { readDecisions } from "./lib/rulings.mjs";
import { decisionsPath, loadRun, scoreRun } from "./score.mjs";

function parseArgs(argv) {
  const o = { runs: [], decisions: decisionsPath, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") o.json = true;
    else if (a === "--decisions") o.decisions = argv[++i];
    else if (a === "--specs") {
      if (o.runs.length === 0) throw new Error("--specs follows the run it applies to");
      o.runs.at(-1).specs = argv[++i];
    } else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else o.runs.push({ run: a, specs: null });
  }
  if (o.runs.length === 0) throw new Error("name at least one run: a folder or a run id under benchmark/results");
  if (o.decisions === undefined || o.runs.some((r) => r.specs === undefined)) throw new Error("--decisions and --specs each take a value");
  return o;
}

const folderOf = (run) => (existsSync(run) ? resolve(run) : join(resultsRoot, run));
const specsOf = (folder, specs) => (specs === null ? null : existsSync(specs) ? resolve(specs) : join(folder, specs));

// One run scored under the rulings, with its causes.
function runCausesOf({ run, specs }, d) {
  const folder = folderOf(run);
  const loaded = loadRun(folder, { specsDir: specsOf(folder, specs) });
  const { score, causes } = scoreRun(loaded, { decisionsHash: d.hash, decisions: d.lines, people: d.people });
  if (causes === null) throw new Error(`${basename(folder)} is a scanner-only run: no reviewer ran, so its misses have no reviewer cause`);
  return { run: basename(folder), specsFrom: score.specsFrom, decisionsHash: d.hash, rulings: score.rulings, configs: Object.keys(score.byConfig), misses: causes.misses, nonHits: causes.nonHits };
}

const table = (head, rows) => [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
const sampleOf = (r) => `${r.case}/${r.config}/${r.repeat}`;

function perRun(r) {
  const out = [`## ${r.run}`, "", `Specs: ${r.specsFrom}. Rulings: ${r.rulings.read} lines read${r.decisionsHash ? ` (sha256 ${r.decisionsHash.slice(0, 12)})` : ""}, ${r.rulings.ignored.length} ignored.`, ""];
  for (const [label, rows, list] of [["Misses", r.misses, MISS_CAUSES], ["Counted non-hits", r.nonHits, NON_HIT_CAUSES]]) {
    const counts = Object.fromEntries(r.configs.map((c) => [c, countCauses(rows.filter((x) => x.config === c), list)]));
    out.push(`${label}, ${rows.length}:`, "", table(["Cause", ...r.configs], list.map((cause) => [cause, ...r.configs.map((c) => String(counts[c][cause]))])), "");
  }
  return out.join("\n");
}

// The table across runs: each cause, its count per run, and the reviews it holds.
function across(runs) {
  const names = runs.map((r) => r.run);
  const out = [`## Across ${runs.length === 1 ? "the run" : `${runs.length} runs`}`, ""];
  for (const [label, key, list, what] of [["Misses", "misses", MISS_CAUSES, (x) => `${sampleOf(x)} ${x.bug}`], ["Counted non-hits", "nonHits", NON_HIT_CAUSES, (x) => `${sampleOf(x)} "${x.title}"`]]) {
    const total = runs.reduce((a, r) => a + r[key].length, 0);
    out.push(`${label}, ${total} (${runs.map((r) => `${r.run} ${r[key].length}`).join(", ")}):`, "");
    const rows = list.map((cause) => {
      const cells = runs.map((r) => r[key].filter((x) => x.cause === cause));
      const samples = runs.flatMap((r, i) => cells[i].map((x) => `${runs.length > 1 ? `${r.run} ` : ""}${what(x)}`));
      return [`${cause} (${CAUSE_TEXT[cause]})`, ...cells.map((c) => String(c.length)), samples.join("; ") || "none"];
    });
    out.push(table(["Cause", ...names, "Reviews"], rows), "");
  }
  const drops = runs.flatMap((r) => r.misses.filter((x) => x.cause === "candidate-dropped").flatMap((x) => x.drops));
  if (drops.length > 0) out.push(`Dropped candidates on missed items, by their class (drops.mjs): ${DROP_CLASSES.map((c) => [c, drops.filter((d) => d.class === c).length]).filter(([, n]) => n > 0).map(([c, n]) => `${c} ${n}`).join(", ")}.`, "");
  return out.join("\n");
}

function main() {
  let o;
  let runs;
  try {
    o = parseArgs(process.argv.slice(2));
    const d = readDecisions(resolve(o.decisions));
    runs = o.runs.map((r) => runCausesOf(r, d));
  } catch (e) {
    process.stderr.write(`causes: ${e.message}\n`);
    return 2;
  }
  if (o.json) process.stdout.write(`${JSON.stringify({ version: CAUSES_VERSION, runs }, null, 2)}\n`);
  else process.stdout.write(`${[...runs.map(perRun), across(runs)].join("\n")}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
