#!/usr/bin/env node
// Writes benchmark/cases.lock.json, the frozen hash of every planted case:
//
//   node benchmark/lock.mjs                    add new cases, rewrite the entry
//                                              of a case no run has used, refuse
//                                              the rest and write nothing
//   node benchmark/lock.mjs --force "<reason>" also rewrite entries a local run
//                                              used, with the reason in history
//   node benchmark/lock.mjs --check            change nothing; print every case
//                                              that breaks F1 or F2, exit 1 on one
//
// Each entry is { hash, frozenAt, history, retired }. `history` says whether
// the case was edited after runs made before the freeze (2026-10-10): it is
// "edited after runs before 2026-10-10" when a run manifest that started
// before that day recorded another hash for the case, or saved a copy of
// its spec that differs from today's. The first run recorded no hashes;
// `historyFrom` names the runs read and the ones without hashes. Retiring a
// case is a person's edit: `retired: true` on its entry, with the folder
// kept. The rules and their failure list are in lib/lock.mjs.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { benchRoot, indexProblems, lockPath, lockProblems, readLock } from "./lib/cases.mjs";
import { readRunManifests, updateLock } from "./lib/lock.mjs";

// Every local folder that holds run folders. P1-T4 adds the results store's
// local folder here if it is not benchmark/results.
const RESULTS_DIRS = [join(benchRoot, "results")];

const USAGE = 'usage: node benchmark/lock.mjs [--check] [--force "<reason>"]';

function main() {
  const args = process.argv.slice(2);
  let check = false;
  let force = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--check") check = true;
    else if (args[i] === "--force" && typeof args[i + 1] === "string" && args[i + 1].trim() !== "" && !args[i + 1].startsWith("--")) force = args[++i].trim();
    else {
      console.error(`${args[i] === "--force" ? "--force needs a reason" : `unknown argument ${args[i]}`}\n${USAGE}`);
      process.exit(2);
    }
  }
  let lock = { version: 1, cases: {} };
  if (existsSync(lockPath)) {
    try {
      lock = readLock();
    } catch (error) {
      console.error(error.message);
      process.exit(2);
    }
  }
  if (check) {
    const problems = [...lockProblems(lock), ...indexProblems(lock)];
    for (const p of problems) console.error(p);
    console.log(problems.length === 0 ? `Every case matches the lock (${Object.keys(lock.cases).length} entries).` : `${problems.length} problem(s).`);
    process.exit(problems.length === 0 ? 0 : 1);
  }
  const { lock: next, changes, refusals } = updateLock(lock, { runs: readRunManifests(RESULTS_DIRS), force });
  if (refusals.length > 0) {
    for (const r of refusals) console.error(r);
    console.error("Nothing was written.");
    process.exit(2);
  }
  writeFileSync(lockPath, `${JSON.stringify(next, null, 2)}\n`);
  for (const c of changes) console.log(c);
  console.log(changes.length === 0 ? "The lock already matches every case." : `Wrote benchmark/cases.lock.json (${changes.length} change(s)).`);
}

main();
