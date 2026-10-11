#!/usr/bin/env node
// Writes benchmark/cases.lock.json, the frozen hash of every planted case:
//
//   node benchmark/lock.mjs           add new cases, rewrite the entry of a
//                                     case no run has named, refuse the rest
//   node benchmark/lock.mjs --check   change nothing; print every case that
//                                     breaks F1 or F2 and exit 1 when one does
//
// Each entry is { hash, frozenAt, history, retired }. `history` says whether
// the case was edited after runs made before the freeze (2026-10-10): it is
// "edited after runs before 2026-10-10" when a run manifest under
// benchmark/results/ that started before that day recorded another hash for
// the case, or saved a copy of its spec that differs from today's. The
// first run recorded no hashes; `historyFrom` names the runs read and the
// ones without hashes, so its gap is stated, not hidden. Retiring a case is
// a person's edit: `retired: true` on its entry, with the folder kept.
//
// Failure list, written before the code:
// 1. A case a run has named is edited and its entry rewritten to match, so
//    the id stays while the code changed: an entry is rewritten only when no
//    run index entry (legacy aside) names the case at its frozen hash;
//    otherwise nothing is written and the run says a spec edit after a run
//    is a new case.
// 2. The history is lost, or rewritten from runs made after the freeze: an
//    entry keeps the history it was first written with, and a new entry's
//    history reads only runs that started before the freeze day.
// 3. The lock keeps an entry whose folder is gone, so old runs cannot be
//    rebuilt: nothing is written and the case is named.
// 4. The file is written in another order each time, so its diffs are
//    noise: names sorted, two-space JSON, one trailing newline.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { benchRoot, caseHash, caseIdFromHash, casesRoot, indexProblems, listCases, lockPath, lockProblems, readIndexEntries, readLock } from "./lib/cases.mjs";

const FREEZE_DAY = "2026-10-10";
const EDITED = `edited after runs before ${FREEZE_DAY}`;

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

// The run manifests that started before the freeze, oldest first.
function runsBeforeFreeze(resultsDir) {
  if (!existsSync(resultsDir)) return [];
  const runs = [];
  for (const name of readdirSync(resultsDir).sort()) {
    const manifest = readJson(join(resultsDir, name, "manifest.json"));
    if (manifest && typeof manifest.started_at === "string" && manifest.started_at < FREEZE_DAY) runs.push({ name, dir: join(resultsDir, name), manifest });
  }
  return runs.sort((a, b) => a.manifest.started_at.localeCompare(b.manifest.started_at));
}

// Whether any pre-freeze run reviewed the case with other files or another spec.
function historyOf(name, hash, runs, root = casesRoot) {
  const spec = readFileSync(join(root, name, "case.json"), "utf8");
  for (const { dir, manifest } of runs) {
    const ran = (manifest.cases ?? []).includes(name) || Object.hasOwn(manifest.caseHashes ?? {}, name);
    if (!ran) continue;
    const recorded = manifest.caseHashes?.[name];
    if (typeof recorded === "string" && recorded !== hash) return EDITED;
    const copy = join(dir, "cases", `${name}.json`);
    if (existsSync(copy) && readFileSync(copy, "utf8") !== spec) return EDITED;
  }
  return null;
}

function main() {
  const check = process.argv.includes("--check");
  const unknown = process.argv.slice(2).filter((a) => a !== "--check");
  if (unknown.length > 0) {
    console.error(`unknown argument ${unknown[0]}\nusage: node benchmark/lock.mjs [--check]`);
    process.exit(2);
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

  const names = listCases();
  const refusals = [];
  for (const name of Object.keys(lock.cases)) if (!names.includes(name)) refusals.push(`${name}: the lock holds a case with no folder; a retired case keeps its folder so old runs can be rebuilt`);
  const named = new Set(readIndexEntries().filter((x) => x.entry && x.entry.legacy !== true).flatMap((x) => x.entry.caseIds ?? []));
  const runs = runsBeforeFreeze(join(benchRoot, "results"));
  const today = new Date().toISOString().slice(0, 10);
  const changes = [];
  for (const name of names) {
    const hash = caseHash(name);
    const entry = lock.cases[name];
    if (!entry) {
      lock.cases[name] = { hash, frozenAt: today, history: historyOf(name, hash, runs), retired: false };
      changes.push(`added ${caseIdFromHash(name, hash)}${lock.cases[name].history ? ` (${lock.cases[name].history})` : ""}`);
    } else if (entry.hash !== hash) {
      const frozen = caseIdFromHash(name, entry.hash);
      if (named.has(frozen)) refusals.push(`${name}: ${frozen} was run, and a spec edit after a run is a new case. Put the edit in a new folder (${name}-v2) and mark this entry retired.`);
      else {
        changes.push(`rewrote ${frozen} as ${caseIdFromHash(name, hash)} (no run names it)`);
        entry.hash = hash;
        entry.frozenAt = today;
      }
    }
  }
  if (refusals.length > 0) {
    for (const r of refusals) console.error(r);
    console.error("Nothing was written.");
    process.exit(2);
  }
  if (!lock.historyFrom && Object.values(lock.cases).length > 0) {
    lock.historyFrom = { before: FREEZE_DAY, runs: runs.map((r) => r.name), withoutCaseHashes: runs.filter((r) => !r.manifest.caseHashes).map((r) => r.name) };
  }
  const ordered = { version: 1, ...(lock.historyFrom ? { historyFrom: lock.historyFrom } : {}), cases: Object.fromEntries(Object.keys(lock.cases).sort().map((n) => [n, lock.cases[n]])) };
  writeFileSync(lockPath, `${JSON.stringify(ordered, null, 2)}\n`);
  for (const c of changes) console.log(c);
  console.log(changes.length === 0 ? "The lock already matches every case." : `Wrote benchmark/cases.lock.json (${changes.length} change(s)).`);
}

main();
