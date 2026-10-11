// Writing the case lock (benchmark/cases.lock.json); benchmark/lock.mjs is
// the command. Reading and checking it live in lib/cases.mjs.
//
// Failure list, written before the code:
// 1. A case a run has named is edited and its entry rewritten to match, so
//    the id stays while the code changed. An entry is never rewritten when a
//    run index entry (legacy aside) names the case at its frozen hash, and
//    not when a run manifest in a local results folder names that hash,
//    unless the person forces it with a reason, which goes into the entry's
//    history.
// 2. The history is lost, or rewritten from runs made after the freeze: an
//    entry keeps the history it was first written with, and a new entry's
//    history reads only runs that started before the freeze day.
// 3. The lock keeps an entry whose folder is gone, so old runs cannot be
//    rebuilt: nothing is written and the case is named.
// 4. Results stored in more than one place (benchmark/results today, the
//    results store's local folder later) are read by different code, so one
//    place is missed: every reader goes through readRunManifests(dirs).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NEW_CASE, caseHash, caseIdFromHash, casesRoot, indexRunsRoot, listCases, readIndexEntries } from "./cases.mjs";

export const FREEZE_DAY = "2026-10-10";
export const EDITED = `edited after runs before ${FREEZE_DAY}`;

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

// Every run folder with a manifest in any of these results folders, oldest first.
export function readRunManifests(dirs) {
  const runs = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      const manifest = readJson(join(dir, name, "manifest.json"));
      if (manifest && typeof manifest === "object") runs.push({ run: name, dir: join(dir, name), manifest });
    }
  }
  return runs.sort((a, b) => String(a.manifest.started_at ?? "").localeCompare(String(b.manifest.started_at ?? "")) || a.run.localeCompare(b.run));
}

const ran = (manifest, name) => (manifest.cases ?? []).includes(name) || Object.hasOwn(manifest.caseHashes ?? {}, name);

// Whether a run before the freeze reviewed the case with other files or another spec.
export function historyOf(name, hash, runs, root = casesRoot) {
  const spec = readFileSync(join(root, name, "case.json"), "utf8");
  for (const { dir, manifest } of runs) {
    if (typeof manifest.started_at !== "string" || manifest.started_at >= FREEZE_DAY || !ran(manifest, name)) continue;
    const recorded = manifest.caseHashes?.[name];
    if (typeof recorded === "string" && recorded !== hash) return EDITED;
    const copy = join(dir, "cases", `${name}.json`);
    if (existsSync(copy) && readFileSync(copy, "utf8") !== spec) return EDITED;
  }
  return null;
}

// The runs whose manifest names this case at this hash.
const usedBy = (runs, name, hash) => runs.filter(({ manifest }) => manifest.caseHashes?.[name] === hash || (manifest.caseIds ?? []).includes(caseIdFromHash(name, hash)));

// The lock brought up to date with the case folders: new cases added,
// entries of cases no run used rewritten, the rest refused. `runs` comes
// from readRunManifests; `force` is a person's reason for rewriting entries
// a local run used. Returns the lock, what changed and what was refused.
export function updateLock(lock, { root = casesRoot, runs = [], indexDir = indexRunsRoot, force = null, today = new Date().toISOString().slice(0, 10) } = {}) {
  const names = listCases(root);
  const refusals = [];
  const changes = [];
  for (const name of Object.keys(lock.cases)) if (!names.includes(name)) refusals.push(`${name}: the lock holds a case with no folder; a retired case keeps its folder so old runs can be rebuilt`);
  const indexed = new Set(readIndexEntries(indexDir).filter((x) => x.entry && x.entry.legacy !== true).flatMap((x) => x.entry.caseIds ?? []));
  for (const name of names) {
    const hash = caseHash(name, root);
    const entry = lock.cases[name];
    if (!entry) {
      lock.cases[name] = { hash, frozenAt: today, history: historyOf(name, hash, runs, root), retired: false };
      changes.push(`added ${caseIdFromHash(name, hash)}${lock.cases[name].history ? ` (${lock.cases[name].history})` : ""}`);
      continue;
    }
    if (entry.hash === hash) continue;
    const frozen = caseIdFromHash(name, entry.hash);
    if (indexed.has(frozen)) {
      refusals.push(`${name}: the run index names ${frozen}, and ${NEW_CASE}. Put the edit in a new folder (${name}-v2) and mark this entry retired.`);
      continue;
    }
    const used = usedBy(runs, name, entry.hash);
    if (used.length > 0 && !force) {
      refusals.push(`${name}: the local run${used.length > 1 ? "s" : ""} ${used.map((r) => r.run).join(", ")} used ${frozen}, and ${NEW_CASE}. Put the edit in a new folder (${name}-v2) and mark this entry retired, or rewrite it with --force "<reason>", which goes into its history.`);
      continue;
    }
    if (used.length > 0) {
      const note = `lock entry rewritten on ${today} although ${used.length} local run(s) used ${entry.hash.slice(0, 8)}: ${force}`;
      entry.history = entry.history ? `${entry.history}; ${note}` : note;
    }
    changes.push(`rewrote ${frozen} as ${caseIdFromHash(name, hash)}${used.length > 0 ? " (forced)" : " (no run names it)"}`);
    entry.hash = hash;
    entry.frozenAt = today;
  }
  if (!lock.historyFrom && names.length > 0) {
    const before = runs.filter((r) => typeof r.manifest.started_at === "string" && r.manifest.started_at < FREEZE_DAY);
    lock.historyFrom = { before: FREEZE_DAY, runs: before.map((r) => r.run), withoutCaseHashes: before.filter((r) => !r.manifest.caseHashes).map((r) => r.run) };
  }
  const ordered = { version: 1, ...(lock.historyFrom ? { historyFrom: lock.historyFrom } : {}), cases: Object.fromEntries(Object.keys(lock.cases).sort().map((n) => [n, lock.cases[n]])) };
  return { lock: ordered, changes, refusals };
}
