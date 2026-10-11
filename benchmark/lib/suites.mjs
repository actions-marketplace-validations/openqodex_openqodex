// One case interface over every suite (PLAN-benchmark 4.2): listCases,
// readCase and truthOf return the same shape for planted cases and for real
// pull requests. A real suite commits only references in
// benchmark/suites/<suite>/cases.json; its truth text stays in the pinned raw
// file in the cache ($OPENQODEX_BENCH_CACHE/raw/<board>/<path>) and is read
// from there, checked by sha256, every time. The split side and the subsets
// come from the suite's split file under benchmark/splits/.
//
// Failure list, written before the code:
// 1. An upstream edit to the dataset changes the truth under a frozen id:
//    the raw file must hash to its pin, the truth built from it must hash to
//    the entry's truthHash, and the id carries the first 8 hex of a hash that
//    covers truthHash. A mismatch anywhere refuses the read.
// 2. An id names a case whose entry has since changed (new truth, a new
//    merge base): readCase refuses, because a changed case is a new case.
// 3. A case with no licence, or one the split leaves out, is listed for a
//    run: listCases returns usable cases that the split file places only.
// 4. Third-party comment text reaches a committed file: entries hold counts
//    and hashes, never a comment.
// 5. A truth item is read with a severity, a class or matching words nobody
//    froze: real truth has severity, class and mentions null; matchSignatures
//    come only from the committed entry.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { benchRoot, buildCase, caseIdFromHash, casesRoot, git, parseCaseId, readCase as readPlantedSpec, readLock } from "./cases.mjs";
import { cacheRoot } from "./licence.mjs";
import { materialisePr } from "./materialise.mjs";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// JSON with object keys sorted at every level: the form every hash here is over.
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
  return JSON.stringify(v === undefined ? null : v);
}

// The real suites: where each keeps its entries and its split, and the
// board in benchmark/outside/boards.json that pins its raw files.
export const SUITES = {
  aacr: { board: "aacr", cases: "suites/aacr/cases.json", split: "splits/aacr-v1.json" },
};

// ---------- AACR truth ----------

// AACR-Bench's comment categories to the product's (PLAN-benchmark 4.2).
export const AACR_CATEGORIES = { "Code Defect": "bug", "Security Vulnerability": "security", Performance: "performance", "Maintainability and Readability": "maintainability" };

function lineTruth(c, id, valid) {
  const [a, b] = [c.from_line, c.to_line];
  return {
    id,
    file: c.path,
    lines: [Math.min(a, b), Math.max(a, b)],
    also: [],
    side: c.side,
    text: c.note,
    categories: AACR_CATEGORIES[c.category] ? [AACR_CATEGORIES[c.category]] : [],
    class: null,
    severity: null,
    expectedFinder: null,
    mentions: null,
    matchSignatures: null,
    tags: c.side === "left" ? ["deletion"] : [],
    evidence: [],
    valid,
    meta: { rawCategory: c.category ?? null, context: c.context ?? null, isAi: c.is_ai_comment === true, sourceModel: c.source_model || null, ...(a > b ? { reversedLines: [a, b] } : {}) },
  };
}

// The truth of one pull request: its accepted comments (c1, c2, ...) then
// its rejected ones (r1, r2, ...), in the dataset's order.
export function aacrTruth(positiveRow, negativeRow) {
  const items = positiveRow.comments.map((c, i) => lineTruth(c, `c${i + 1}`, true));
  if (negativeRow) items.push(...negativeRow.comments.map((c, i) => lineTruth(c, `r${i + 1}`, false)));
  return { kind: "lines", items };
}

export const truthHashOf = (items) => sha256(canonicalJson(items));

// The fields a real case's hash covers: what is reviewed and what it is
// scored against. Licence, group, split and status are bookkeeping that
// never changes a review or a score, so a new licence reading keeps the id.
export const HASHED = ["name", "prUrl", "repo", "cloneUrl", "prRef", "baseSha", "headSha", "mergeBaseSha", "language", "changeLines", "truthHash", "matchSignatures"];
export const entryHash = (entry) => sha256(canonicalJson(Object.fromEntries(HASHED.map((k) => [k, entry[k] ?? null]))));
export const realCaseId = (suite, name, hash) => `${suite}/${name}@${hash.slice(0, 8)}`;

// ---------- pinned raw files ----------

export const rawPath = (cache, board, pin) => join(cache, "raw", board, pin.path);

// Throws unless `bytes` hash to the pin.
export function checkPinned(bytes, pin, where) {
  const got = sha256(bytes);
  if (got !== pin.sha256) throw new Error(`${pin.path} (${where}) has sha256 ${got}, not the pinned ${pin.sha256}. An upstream edit never changes the truth behind a frozen id: move the file to the Trash and fetch it again, or pin the new revision in benchmark/outside/boards.json, which makes new case ids.`);
  return bytes;
}

const parsed = new Map();

// A pinned raw file from the cache, checked, parsed once per process.
export function readPinned(cache, board, pin) {
  const path = rawPath(cache, board, pin);
  if (!existsSync(path)) throw new Error(`${pin.path} of board ${board} is not in the cache (${path}); run node benchmark/ingest/${board}.mjs to fetch it`);
  const bytes = checkPinned(readFileSync(path), pin, path);
  const key = `${path}\0${pin.sha256}`;
  if (!parsed.has(key)) parsed.set(key, JSON.parse(bytes.toString("utf8")));
  return parsed.get(key);
}

// ---------- reading a suite ----------

export function readSuite(suite, { root = benchRoot } = {}) {
  const def = SUITES[suite];
  if (!def) throw new Error(`no real suite named ${suite}; the real suites are ${Object.keys(SUITES).join(", ")}`);
  const path = join(root, def.cases);
  if (!existsSync(path)) throw new Error(`${path} is missing; run node benchmark/ingest/${suite}.mjs`);
  const file = JSON.parse(readFileSync(path, "utf8"));
  const split = existsSync(join(root, def.split)) ? JSON.parse(readFileSync(join(root, def.split), "utf8")) : null;
  const splitBytes = split ? readFileSync(join(root, def.split)) : null;
  return { def, file, split, splitHash: splitBytes ? sha256(splitBytes) : null, byName: new Map(file.cases.map((e) => [e.name, e])) };
}

const sideIn = (split, name) => (split?.cases?.dev?.includes(name) ? "dev" : split?.cases?.test?.includes(name) ? "test" : null);
const subsetsOf = (split, name) => Object.entries(split?.subsets ?? {}).filter(([, names]) => names.includes(name)).map(([s]) => s).sort();

function realCase(suite, s, entry) {
  return {
    id: realCaseId(suite, entry.name, entry.hash),
    suite,
    name: entry.name,
    hash: entry.hash,
    split: entry.status === "usable" ? sideIn(s.split, entry.name) : null,
    splitHash: s.splitHash,
    subsets: subsetsOf(s.split, entry.name),
    origin: "real",
    repoGroup: entry.repoGroup,
    language: entry.language,
    framework: null,
    clean: false,
    changeLines: entry.changeLines,
    status: entry.status,
    excludedWhy: entry.excludedWhy,
    source: { dataset: s.file.dataset, repo: entry.repo, prUrl: entry.prUrl, cloneUrl: entry.cloneUrl, licence: entry.licence },
    materialise: { kind: "pr", cloneUrl: entry.cloneUrl, prRef: entry.prRef, baseSha: entry.baseSha, headSha: entry.headSha, mergeBaseSha: entry.mergeBaseSha },
    prCreatedAt: null,
    headCommittedAt: null,
    truthHash: entry.truthHash,
    matchSignatures: entry.matchSignatures,
    truthCount: entry.truth,
  };
}

// ---------- planted ----------

function plantedCase(name, lockEntry) {
  const spec = readPlantedSpec(name);
  return {
    id: caseIdFromHash(name, lockEntry.hash),
    suite: "planted",
    name,
    hash: lockEntry.hash,
    split: "dev",
    splitHash: null,
    subsets: [],
    origin: "planted",
    repoGroup: `planted/${name}`,
    language: spec.language,
    framework: spec.framework === "none" ? null : spec.framework,
    clean: spec.clean,
    changeLines: null,
    status: lockEntry.retired ? "excluded" : "usable",
    excludedWhy: lockEntry.retired ? "retired in benchmark/cases.lock.json" : null,
    source: { kind: "authored" },
    materialise: { kind: "folders", base: spec.base ?? "base", change: spec.change ?? "change", delete: "delete.txt" },
    prCreatedAt: null,
    headCommittedAt: null,
    spec,
  };
}

function plantedTruth(spec) {
  return {
    kind: "lines",
    items: spec.bugs.map((b) => ({
      id: b.id,
      file: b.file,
      lines: b.lines,
      also: b.also ?? [],
      side: "right",
      text: b.truth,
      categories: b.kind,
      class: b.class ?? null,
      severity: b.severity,
      expectedFinder: b.found_by,
      mentions: b.mentions,
      matchSignatures: null,
      tags: b.tags ?? [],
      evidence: b.evidence ?? [],
      valid: true,
      onChangedLines: null,
      meta: { anchor: b.anchor },
    })),
  };
}

// ---------- the interface ----------

// The ids of the usable cases of a suite, sorted; split "dev" or "test" and
// a subset narrow the list. A real case is listed only when its split file
// places it.
export function listCases({ suite, split = null, subset = null, root = benchRoot } = {}) {
  if (suite === "planted") {
    if (subset !== null && subset !== "all") throw new Error(`the planted suite lists no subsets (asked for ${subset})`);
    if (split === "test") return [];
    const lock = readLock(join(root, "cases.lock.json"));
    return Object.entries(lock.cases)
      .filter(([, e]) => !e.retired)
      .map(([name, e]) => caseIdFromHash(name, e.hash))
      .sort();
  }
  const s = readSuite(suite, { root });
  const out = [];
  for (const entry of s.file.cases) {
    if (entry.status !== "usable") continue;
    const side = sideIn(s.split, entry.name);
    if (side === null || (split !== null && side !== split)) continue;
    if (subset !== null && subset !== "all" && !(s.split?.subsets?.[subset] ?? []).includes(entry.name)) continue;
    out.push(realCaseId(suite, entry.name, entry.hash));
  }
  return out.sort();
}

// The case an id names, refused when the suite now holds that name under
// another hash (a changed case is a new case).
export function readCase(id, { root = benchRoot } = {}) {
  const p = parseCaseId(id);
  if (!p) throw new Error(`${JSON.stringify(id)} is not a case id (<suite>/<name>@<8 hex>)`);
  if (p.suite === "planted") {
    const lock = readLock(join(root, "cases.lock.json"));
    const entry = lock.cases[p.name];
    if (!entry) throw new Error(`${id}: the case lock holds no ${p.name}`);
    if (!entry.hash.startsWith(p.hash8)) throw new Error(`${id}: the lock holds ${p.name} at ${entry.hash.slice(0, 8)}, and a spec edit after a run is a new case`);
    return plantedCase(p.name, entry);
  }
  const s = readSuite(p.suite, { root });
  const entry = s.byName.get(p.name);
  if (!entry) throw new Error(`${id}: suite ${p.suite} holds no case named ${p.name}`);
  if (entryHash(entry) !== entry.hash) throw new Error(`${id}: the entry for ${p.name} in ${s.def.cases} does not hash to its own hash; an entry is written by the ingest, never by hand`);
  if (!entry.hash.startsWith(p.hash8)) throw new Error(`${id}: suite ${p.suite} now holds ${p.name} at ${entry.hash.slice(0, 8)}, and a changed case is a new case; runs of the old id compare with nothing new`);
  return realCase(p.suite, s, entry);
}

// The truth a case is scored against. A real case's truth is rebuilt from
// the pinned raw files and must hash to the entry's truthHash.
export function truthOf(c, { cache = cacheRoot() } = {}) {
  if (c.suite === "planted") return plantedTruth(c.spec ?? readPlantedSpec(c.name));
  const def = SUITES[c.suite];
  if (!def) throw new Error(`no real suite named ${c.suite}`);
  const files = c.source.dataset.files;
  const positive = readPinned(cache, def.board, files.positive);
  const negative = readPinned(cache, def.board, files.negative);
  const at = (rows) => rows.find((r) => r.githubPrUrl === c.source.prUrl && r.target_commit === c.materialise.headSha) ?? null;
  const row = at(positive);
  if (!row) throw new Error(`${c.id}: ${files.positive.path} holds no row for ${c.source.prUrl} at ${c.materialise.headSha}`);
  const truth = aacrTruth(row, at(negative));
  const hash = truthHashOf(truth.items);
  if (hash !== c.truthHash) throw new Error(`${c.id}: its truth now hashes to ${hash.slice(0, 8)}, not the frozen ${c.truthHash.slice(0, 8)}; an upstream edit never changes the truth behind a frozen id`);
  for (const item of truth.items) {
    item.matchSignatures = c.matchSignatures?.[item.id] ?? null;
    item.onChangedLines = null;
  }
  return truth;
}

// The repository a review of the case reads, built into `into` (a new or
// empty folder) in the shape asked: laptop, the base committed and the
// change uncommitted; server, the base and the change as two commits.
// Returns { dir, shape, base, head }, the commits a server review names
// (head is null in the laptop shape of a planted case, whose change is
// never committed). A pull request case goes through the clone cache
// (lib/materialise.mjs), and its result also names upstream's commits.
export function materialise(c, into, { shape = "laptop", cache = cacheRoot(), heldOut = false, casesDir = casesRoot } = {}) {
  if (c.materialise?.kind === "pr") return materialisePr(c, into, { shape, cache, heldOut });
  if (shape !== "laptop" && shape !== "server") throw new Error(`the shape is laptop or server, not ${JSON.stringify(shape)}`);
  const { dir } = buildCase(c.name, into, casesDir);
  if (shape === "server") {
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "Change");
  }
  const at = (rev) => git(dir, "rev-parse", rev).trim();
  return shape === "server" ? { dir, shape, base: at("HEAD~1"), head: at("HEAD") } : { dir, shape, base: at("HEAD"), head: null };
}
