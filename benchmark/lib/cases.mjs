// The benchmark corpus: one folder per case under benchmark/cases/<id>/,
// built into a real two-state git repository in a temp folder.
//
//   case.json     the spec: language, framework, the planted bugs (file,
//                 lines, anchor, kind, severity, who should find each, the
//                 truth in one or two sentences), the graph gaps the brief
//                 must disclose, and accepted side issues
//   base/         the files of the base commit (or `base` in case.json names
//                 another folder, relative to the case folder)
//   change/       the files the change writes over the base, left uncommitted
//   delete.txt    optional: paths the change deletes, one per line
//
// The repository is the shape a developer has before a push: the base
// committed on main, the change in the working tree (new files untracked).
//
// Failure list, written before the code:
// 1. A spec names a line that no longer holds the planted code (an edit moved
//    it): every bug has an anchor, and the test checks the anchor text is on
//    the anchor line of the built repository.
// 2. A bug's range holds no changed line, so no finding can cite it (the
//    review accepts a finding only when it starts on a changed line or a line
//    next to a deletion): the test checks every range against the change.
// 3. The base or change folder, or a path in delete.txt, is missing: the
//    build throws and names the case.
// 4. The user's git setup changes the repository (hooks, signing, templates,
//    the default branch, line endings): git runs with no global or system
//    config, hooks off, a fixed author and fixed dates.
// 5. An inherited GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE sends the commit
//    into another repository: every GIT_ variable is dropped.
// 6. A placeholder is left in the built tree, or a generated secret lands in
//    the committed base: placeholders are replaced in the change only, and
//    the build throws when one is left anywhere.
// 7. Two builds of one case differ, so two runs review different code: the
//    generated values come from the case id, never from a random source.
// 8. A spec with a typo (a kind or severity the product does not have, a
//    reversed range, a duplicate bug id, an anchor outside its range) scores
//    wrongly without anyone noticing: readCase validates and throws.
// 9. A case edited after a run keeps its name, so an old run and a new one
//    compare across different code: every case has the id
//    planted/<name>@<first 8 hex of caseHash>, cases.lock.json freezes each
//    hash, and lockProblems (F1: every folder hashes to its entry) and
//    indexProblems (F2: every case id a run index entry names resolves to an
//    entry with that hash) fail the tests with "a spec edit after a run is a
//    new case". An edit goes into a new folder; the old entry is retired.
// 10. A planted bug without a class, or with a class outside the list, is
//    accepted, so the scanner tables group truth by labels nobody chose:
//    every bug must carry a class from lib/classes.mjs, its tags and its
//    evidence, and a label added later is an edit that makes a new case.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CLASSES } from "./classes.mjs";

export const benchRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const repoRoot = resolve(benchRoot, "..");
export const casesRoot = join(benchRoot, "cases");
export const lockPath = join(benchRoot, "cases.lock.json");
export const indexRunsRoot = join(benchRoot, "index", "runs");

// The words every freeze failure carries, so a person reading a red test
// knows the rule before the details.
export const NEW_CASE = "a spec edit after a run is a new case";

// The product's own vocabularies (packages/core/src/types.ts and severity.ts).
export const CATEGORIES = ["bug", "security", "performance", "maintainability", "style"];
export const SEVERITIES = ["info", "nitpick", "minor", "major", "critical"];
// Who is expected to find a bug: a scanner by name, the reviewer's reading
// of the diff, or the reviewer helped by the code graph's caller list.
export const FINDERS = ["gitleaks", "semgrep", "bandit", "ruff", "oxlint", "osv-scanner", "hadolint", "shellcheck", "actionlint", "brakeman", "rubocop", "golangci", "zizmor", "trivy", "squawk", "kube-linter", "tflint", "kubeconform", "cargo-deny", "checkov", "sqlfluff", "suppression", "reasoning", "graph"];
// Per bug, beside its class (lib/classes.mjs):
//   tags      needs-callers: the proof lives in a caller or a registration
//             outside the change (a call, an import, a route or URL entry);
//             deletion: the bug is code the change removed, with no line
//             left in its place.
//   evidence  [{ file, lines }]: the unchanged places, outside the bug's own
//             lines, that hold a fact the bug rests on and the changed
//             lines do not show; empty when the change alone proves it.
export const TAGS = ["needs-callers", "deletion"];

const FIXED_DATE = "2026-01-01T00:00:00Z";
const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

// A planted case's name, which is also its folder under benchmark/cases:
// lower case letters, digits and dashes. A name from a run's manifest is
// checked against it before any path is built from it, since a separator
// or a dot would reach outside the folder it is joined to.
export const CASE_NAME = /^[a-z0-9][a-z0-9-]*$/;

export function listCases(root = casesRoot) {
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, "case.json")))
    .map((e) => e.name)
    .sort();
}

const isWords = (w) => Array.isArray(w) && w.length > 0 && w.every((m) => typeof m === "string" && m.trim() !== "");
const isRange = (r) => Array.isArray(r) && r.length === 2 && r.every((n) => Number.isInteger(n) && n >= 1) && r[0] <= r[1];

// Every problem with a spec, one line each; empty when it is sound. The
// labels (class, tags, evidence) are required of the corpus; the scorer
// passes labels: false, because it reads none of them yet and the specs
// saved by runs made before the freeze have none.
export function specProblems(spec, id, { labels = true } = {}) {
  const p = [];
  const need = (cond, what) => {
    if (!cond) p.push(`${id}: ${what}`);
  };
  need(spec && typeof spec === "object", "case.json is not an object");
  if (!spec || typeof spec !== "object") return p;
  need(spec.id === id, `id must be "${id}", the folder name`);
  need(typeof spec.guards === "string" && spec.guards.length > 0, "guards: one line naming the real failure this case guards");
  need(typeof spec.language === "string", "language is missing");
  need(typeof spec.framework === "string", "framework is missing (use \"none\")");
  need(Array.isArray(spec.bugs), "bugs must be a list (empty for a clean case)");
  need(typeof spec.clean === "boolean", "clean must be true or false");
  if (!Array.isArray(spec.bugs)) return p;
  need(spec.clean === (spec.bugs.length === 0), "clean is true exactly when bugs is empty");
  const ids = new Set();
  for (const [i, b] of spec.bugs.entries()) {
    const at = `bugs[${i}]${b && b.id ? ` (${b.id})` : ""}`;
    need(typeof b.id === "string" && b.id !== "", `${at}: id is missing`);
    need(!ids.has(b.id), `${at}: id is used twice`);
    ids.add(b.id);
    need(typeof b.file === "string" && b.file !== "", `${at}: file is missing`);
    need(isRange(b.lines), `${at}: lines must be [first, last] with first <= last`);
    need(b.anchor && Number.isInteger(b.anchor.line) && typeof b.anchor.text === "string" && b.anchor.text !== "", `${at}: anchor must be { line, text }`);
    if (isRange(b.lines) && b.anchor && Number.isInteger(b.anchor.line)) need(b.anchor.line >= b.lines[0] && b.anchor.line <= b.lines[1], `${at}: the anchor line is outside lines`);
    need(Array.isArray(b.kind) && b.kind.length > 0 && b.kind.every((k) => CATEGORIES.includes(k)), `${at}: kind must be a non-empty list of ${CATEGORIES.join(", ")}`);
    need(SEVERITIES.includes(b.severity), `${at}: severity must be one of ${SEVERITIES.join(", ")}`);
    need(Array.isArray(b.found_by) && b.found_by.length > 0 && b.found_by.every((f) => FINDERS.includes(f)), `${at}: found_by must be a non-empty list of ${FINDERS.join(", ")}`);
    need(typeof b.truth === "string" && b.truth.length > 0, `${at}: truth is missing (what is wrong and the fix)`);
    // The words that name the issue: without them no finding can match it (lib/score.mjs).
    need(isWords(b.mentions), `${at}: mentions must be a non-empty list of words that name the issue`);
    need(b.also === undefined || (Array.isArray(b.also) && b.also.every((a) => typeof a.file === "string" && isRange(a.lines))), `${at}: also must be a list of { file, lines }`);
    // The labels the scanner and reviewer loops read; they are inside the hash, so they are frozen with the case.
    if (!labels) continue;
    need(CLASSES.includes(b.class), `${at}: class must be one of the ${CLASSES.length} classes in lib/classes.mjs`);
    need(Array.isArray(b.tags) && b.tags.every((t) => TAGS.includes(t)) && new Set(b.tags).size === b.tags.length, `${at}: tags must be a list of ${TAGS.join(", ")}, each at most once (empty when none applies)`);
    need(Array.isArray(b.evidence) && b.evidence.every((e) => e && typeof e.file === "string" && e.file !== "" && isRange(e.lines)), `${at}: evidence must be a list of { file, lines } (empty when the changed lines hold the proof)`);
    if (Array.isArray(b.tags) && b.tags.includes("needs-callers")) need(Array.isArray(b.evidence) && b.evidence.length > 0, `${at}: needs-callers needs the callers in evidence`);
    if (Array.isArray(b.evidence) && isRange(b.lines)) {
      const own = [{ file: b.file, lines: b.lines }, ...(Array.isArray(b.also) ? b.also : [])];
      for (const e of b.evidence) {
        if (!e || !isRange(e.lines)) continue;
        const hit = own.find((o) => o.file === e.file && isRange(o.lines) && e.lines[0] <= o.lines[1] && o.lines[0] <= e.lines[1]);
        need(!hit, `${at}: evidence ${e.file} lines ${e.lines.join("-")} overlaps the bug's own lines; evidence is proof outside them`);
      }
    }
  }
  for (const [i, x] of (spec.extras ?? []).entries()) {
    need(typeof x.file === "string" && isRange(x.lines) && typeof x.why === "string", `extras[${i}]: must be { file, lines, mentions, why }`);
    need(isWords(x.mentions), `extras[${i}]: mentions must be a non-empty list of words that name the side issue`);
    need(x.kind === undefined || (Array.isArray(x.kind) && x.kind.every((k) => CATEGORIES.includes(k))), `extras[${i}]: kind must be a list of ${CATEGORIES.join(", ")}`);
  }
  const g = spec.graph ?? {};
  for (const [i, u] of (g.gaps ?? []).entries()) need(typeof u.file === "string" && Number.isInteger(u.line) && typeof u.cause === "string", `graph.gaps[${i}]: must be { file, line, cause }`);
  for (const [i, f] of (g.floors ?? []).entries()) need(typeof f === "string" && f.includes("#"), `graph.floors[${i}]: must be "<file>#<name>"`);
  for (const [i, x] of (spec.generated ?? []).entries()) {
    need(typeof x.file === "string" && typeof x.placeholder === "string" && x.kind === "stripe-live-key", `generated[${i}]: must be { file, placeholder, kind: "stripe-live-key" }`);
  }
  return p;
}

export function readCase(id, root = casesRoot) {
  const path = join(root, id, "case.json");
  let spec;
  try {
    spec = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${id}: case.json cannot be read: ${error.message}`);
  }
  const problems = specProblems(spec, id);
  if (problems.length > 0) throw new Error(`case.json is not sound:\n${problems.join("\n")}`);
  return spec;
}

// A value of the shape the scanners look for, the same for every build of
// one case, so two runs review the same bytes. It is never committed.
export function generatedValue(caseId, file, kind) {
  if (kind !== "stripe-live-key") throw new Error(`unknown generated kind ${kind}`);
  const digest = createHash("sha256").update(`openqodex-benchmark\0${caseId}\0${file}`).digest();
  let out = "sk_live_";
  for (let i = 0; i < 24; i++) out += BASE62[digest[i] % BASE62.length];
  return out;
}

export function gitEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_") && v !== undefined) env[k] = v;
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE, GIT_TERMINAL_PROMPT: "0" };
}

export function git(dir, ...args) {
  return execFileSync(
    "git",
    ["-c", "user.name=OpenQodex benchmark", "-c", "user.email=benchmark@openqodex.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "core.autocrlf=false", "-c", "init.defaultBranch=main", ...args],
    { cwd: dir, env: gitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

// Every plain file under dir. A symbolic link is refused: the build would
// copy it and the hash would not read through it, so a link added or
// retargeted would change the code a case builds without changing its id.
function filesUnder(dir) {
  const out = [];
  const walk = (rel) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isSymbolicLink()) throw new Error(`${join(dir, path)} is a symbolic link; a case holds plain files only, so its hash covers everything it builds from`);
      if (e.isDirectory()) walk(path);
      else if (e.isFile()) out.push(path);
    }
  };
  walk("");
  return out.sort();
}

// Builds the case into `into` (a new or empty folder; a fresh temp folder
// when left out) and returns the repository folder and the spec.
export function buildCase(id, into, root = casesRoot) {
  const spec = readCase(id, root);
  const caseDir = join(root, id);
  const base = resolve(caseDir, spec.base ?? "base");
  const change = resolve(caseDir, spec.change ?? "change");
  if (!existsSync(base) || !statSync(base).isDirectory()) throw new Error(`${id}: the base folder ${relative(repoRoot, base)} is missing`);
  if (!existsSync(change) || !statSync(change).isDirectory()) throw new Error(`${id}: the change folder ${relative(repoRoot, change)} is missing`);
  const dir = into ?? join(mkdtempSync(join(tmpdir(), `oq-bench-${id}-`)), "repo");
  mkdirSync(dir, { recursive: true });
  if (readdirSync(dir).length > 0) throw new Error(`${id}: ${dir} is not empty`);

  cpSync(base, dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "Base");

  cpSync(change, dir, { recursive: true, force: true });
  const del = join(caseDir, "delete.txt");
  if (existsSync(del)) {
    for (const line of readFileSync(del, "utf8").split("\n")) {
      const path = line.trim();
      if (path === "") continue;
      if (!existsSync(join(dir, path))) throw new Error(`${id}: delete.txt names ${path}, which the base does not have`);
      rmSync(join(dir, path));
    }
  }
  const changed = new Set(filesUnder(change));
  for (const g of spec.generated ?? []) {
    if (!changed.has(g.file)) throw new Error(`${id}: generated value for ${g.file}, which the change does not write`);
    const full = join(dir, g.file);
    const text = readFileSync(full, "utf8");
    if (!text.includes(g.placeholder)) throw new Error(`${id}: ${g.file} has no ${g.placeholder}`);
    writeFileSync(full, text.split(g.placeholder).join(generatedValue(id, g.file, g.kind)));
  }
  for (const path of filesUnder(dir).filter((p) => !p.startsWith(".git/"))) {
    if (readFileSync(join(dir, path), "utf8").includes("{{GENERATED_")) throw new Error(`${id}: ${path} still holds a placeholder`);
  }
  return { dir, spec };
}

// One hash over everything a case builds from: its spec, the base and change
// folders it names (wherever they lie), each file's executable mode (the
// build copies it and git records it) and delete.txt. Two runs whose hashes
// differ for a case reviewed different code or scored it differently.
export function caseHash(id, root = casesRoot) {
  const spec = readCase(id, root);
  const caseDir = join(root, id);
  const h = createHash("sha256");
  h.update(readFileSync(join(caseDir, "case.json")));
  for (const [label, folder] of [["base", resolve(caseDir, spec.base ?? "base")], ["change", resolve(caseDir, spec.change ?? "change")]]) {
    let paths;
    try {
      paths = filesUnder(folder);
    } catch (error) {
      throw new Error(`${id}: ${error.message}`);
    }
    for (const path of paths) {
      const executable = (statSync(join(folder, path)).mode & 0o100) !== 0;
      h.update(`\0${label}/${path}\0${executable ? "755" : "644"}\0`);
      h.update(readFileSync(join(folder, path)));
    }
  }
  const del = join(caseDir, "delete.txt");
  if (existsSync(del)) h.update(readFileSync(del));
  return h.digest("hex");
}

// The id scores, the index and the review queue key a case by: its name and
// the first 8 hex of its hash, so an edited case is a different id.
export function caseIdFromHash(name, hash) {
  return `planted/${name}@${hash.slice(0, 8)}`;
}

export function caseId(name, root = casesRoot) {
  return caseIdFromHash(name, caseHash(name, root));
}

// Copies every folder the named cases build from into `into`, each at its
// place relative to `anchor` (the repository root), so a spec keeps its bytes
// and its relative base and change paths (the demo's lie outside its case
// folder). A run hashes, checks and builds every attempt from this copy, so
// an edit of the live folders while the run goes reaches none of it.
// Returns the cases root inside the copy.
export function snapshotCases(names, into, { root = casesRoot, anchor = repoRoot } = {}) {
  const under = (path) => {
    const rel = relative(anchor, path);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${path} lies outside ${anchor}, so a snapshot cannot keep its place`);
    return rel;
  };
  const copied = [];
  const copy = (path) => {
    const rel = under(path);
    if (copied.some((c) => rel === c || rel.startsWith(`${c}/`))) return;
    copied.push(rel);
    cpSync(path, join(into, rel), { recursive: true, verbatimSymlinks: true });
  };
  for (const name of names) {
    const spec = readCase(name, root);
    const caseDir = join(root, name);
    copy(caseDir);
    copy(resolve(caseDir, spec.base ?? "base"));
    copy(resolve(caseDir, spec.change ?? "change"));
  }
  return join(into, under(root));
}

// `<suite>/<name>@<8 hex>` into its parts; null when it is not a case id.
export function parseCaseId(id) {
  const m = typeof id === "string" ? /^([a-z][a-z0-9-]*)\/(.+)@([0-9a-f]{8})$/.exec(id) : null;
  return m ? { suite: m[1], name: m[2], hash8: m[3] } : null;
}

// cases.lock.json: { version: 1, historyFrom?, cases: { <name>: { hash,
// frozenAt, history, retired } } }. Written by benchmark/lock.mjs.
export function readLock(path = lockPath) {
  let lock;
  try {
    lock = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`the case lock ${relative(repoRoot, path) || path} cannot be read (${error.message}); write it with node benchmark/lock.mjs`);
  }
  const p = [];
  if (lock?.version !== 1) p.push("version must be 1");
  if (!lock?.cases || typeof lock.cases !== "object" || Array.isArray(lock.cases)) p.push("cases must be an object of case names");
  for (const [name, e] of Object.entries(lock?.cases ?? {})) {
    if (!/^[0-9a-f]{64}$/.test(e?.hash ?? "")) p.push(`${name}: hash must be 64 hex characters`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e?.frozenAt ?? "")) p.push(`${name}: frozenAt must be a date, YYYY-MM-DD`);
    if (e?.history !== null && typeof e?.history !== "string") p.push(`${name}: history must be a sentence or null`);
    if (typeof e?.retired !== "boolean") p.push(`${name}: retired must be true or false`);
  }
  if (p.length > 0) throw new Error(`the case lock ${relative(repoRoot, path) || path} is not sound:\n${p.join("\n")}`);
  return lock;
}

// The lock a run checks against. Only a missing lock may stand in as an
// empty one, and only for a draft run; a lock that is there but unsound is
// refused for every run, so a draft cannot skip a retirement it holds.
export function loadRunLock(path = lockPath, { draft = false } = {}) {
  if (existsSync(path)) return readLock(path);
  if (!draft) throw new Error(`the case lock ${relative(repoRoot, path) || path} is missing, so no case id is frozen; write it with node benchmark/lock.mjs, or run as a draft with --draft (never accepted)`);
  return { version: 1, cases: {} };
}

const editedMessage = (name, now, frozen) =>
  `${name}: its files hash to ${now.slice(0, 8)}, but the lock froze it at ${frozen.slice(0, 8)}, and ${NEW_CASE}. Put the edit in a new folder (${name}-v2) with its own lock entry and mark this entry retired. Only a case no run has named yet may be edited in place, with its entry rewritten by node benchmark/lock.mjs.`;

// Rule F1: every case folder hashes to its lock entry, and every entry has
// its folder (a retired case keeps its folder, so old runs can be rebuilt).
export function lockProblems(lock, root = casesRoot) {
  const names = listCases(root);
  const p = [];
  for (const name of names) {
    const entry = lock.cases[name];
    if (!entry) {
      p.push(`${name}: the case has no lock entry; add it with node benchmark/lock.mjs`);
      continue;
    }
    let hash;
    try {
      hash = caseHash(name, root);
    } catch (error) {
      p.push(`${name}: ${error.message}`);
      continue;
    }
    if (hash !== entry.hash) p.push(editedMessage(name, hash, entry.hash));
  }
  for (const name of Object.keys(lock.cases)) if (!names.includes(name)) p.push(`${name}: the lock holds a case with no folder; a retired case keeps its folder so old runs can be rebuilt`);
  return p;
}

// The run index entries, each with its file name; an unreadable one carries its error.
export function readIndexEntries(dir = indexRunsRoot) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => {
      try {
        return { file, entry: JSON.parse(readFileSync(join(dir, file), "utf8")) };
      } catch (error) {
        return { file, error: error.message };
      }
    });
}

// Rule F2: every case id a run index entry names resolves to a lock entry
// (current or retired) with that hash. Legacy entries, the runs made before
// the freeze, are kept with their own specs and are not held to the lock.
// Other suites pin their cases in their own files.
export function indexProblems(lock, dir = indexRunsRoot) {
  const p = [];
  for (const { file, entry, error } of readIndexEntries(dir)) {
    if (error) {
      p.push(`index ${file}: cannot be read: ${error}`);
      continue;
    }
    if (entry?.legacy === true) continue;
    if (!Array.isArray(entry?.caseIds)) {
      p.push(`index ${file}: caseIds is missing, so its cases cannot be checked against the lock`);
      continue;
    }
    for (const id of entry.caseIds) {
      const c = parseCaseId(id);
      if (c === null) p.push(`index ${file}: ${JSON.stringify(id)} is not a case id (<suite>/<name>@<8 hex>)`);
      else if (c.suite !== "planted") continue;
      else if (!lock.cases[c.name]) p.push(`index ${file}: ${id} names ${c.name}, which the lock does not hold`);
      else if (!lock.cases[c.name].hash.startsWith(c.hash8)) p.push(`index ${file}: ${id} was run, but the lock now holds ${c.name} at ${lock.cases[c.name].hash.slice(0, 8)}, and ${NEW_CASE}. Restore the lock entry and put the edit in a new folder (${c.name}-v2).`);
    }
  }
  return p;
}

// Why a run of these cases must not start: a case whose files differ from
// its lock entry, or that has none, runs only as a draft (never accepted);
// a retired case runs only when retired cases are allowed.
export function lockRefusals(names, lock, { draft = false, allowRetired = false } = {}, root = casesRoot) {
  const out = [];
  for (const name of names) {
    const entry = lock.cases[name];
    if (entry?.retired === true && !allowRetired) out.push(`${name}: the case is retired, so no new run uses it; pass --allow-retired to rebuild an old run with it`);
    if (draft) continue;
    if (!entry) out.push(`${name}: the case has no lock entry, so its id is not frozen; add it with node benchmark/lock.mjs, or run it as a draft with --draft`);
    else {
      const hash = caseHash(name, root);
      if (hash !== entry.hash) out.push(`${editedMessage(name, hash, entry.hash)} A draft run (--draft) may use it; a draft run is never accepted.`);
    }
  }
  return out;
}

// The lines a finding may start on, per file, as the review counts them:
// lines the change added or modified, and the lines on either side of a
// deletion. Computed with git from the built repository (untracked files
// are added with intent-to-add on a copy of the index, so the repository's
// own index is not touched).
export function changedLines(dir) {
  return diffOf(dir).changed;
}

// The change's shape, per file: `changed`, the lines a finding may start on
// (above), and `deletedAfter`, the new-side line after which the change
// removed lines and wrote nothing in their place (0 for the top of a file).
export function diffOf(dir) {
  const temp = mkdtempSync(join(tmpdir(), "oq-bench-index-"));
  const env = { ...gitEnv(), GIT_INDEX_FILE: join(temp, "index") };
  const run = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  let diff;
  try {
    run("read-tree", "HEAD");
    run("add", "-A", "-N");
    diff = run("diff", "-U0", "--no-color", "--no-renames", "HEAD");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  const out = new Map();
  const deletedAfter = new Map();
  let file = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      file = line === "+++ /dev/null" ? null : line.slice(6);
      if (file !== null && !out.has(file)) out.set(file, new Set());
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!h || file === null) continue;
    const start = Number(h[1]);
    const count = h[2] === undefined ? 1 : Number(h[2]);
    const set = out.get(file);
    if (count === 0) {
      // A pure deletion after line `start`: the lines on either side.
      if (start >= 1) set.add(start);
      set.add(start + 1);
      deletedAfter.set(file, [...(deletedAfter.get(file) ?? []), start]);
    } else {
      for (let n = start; n < start + count; n++) set.add(n);
    }
  }
  return { changed: out, deletedAfter };
}

// Where a bug's labels disagree with the diff (from diffOf): evidence must
// hold no changed line; needs-callers needs evidence in a file the change
// does not touch (the caller or the registration); deletion needs a place in
// the bug's lines where the change removed code and wrote nothing instead.
export function labelProblems(bug, { changed, deletedAfter }) {
  const p = [];
  const touched = (file) => (changed.get(file)?.size ?? 0) > 0;
  for (const e of bug.evidence) {
    const held = [...(changed.get(e.file) ?? [])].filter((n) => n >= e.lines[0] && n <= e.lines[1]);
    if (held.length > 0) p.push(`${bug.id}: evidence ${e.file} lines ${e.lines.join("-")} hold changed lines (${held.join(", ")}); evidence is proof outside them`);
  }
  if (bug.tags.includes("needs-callers") && !bug.evidence.some((e) => !touched(e.file))) {
    p.push(`${bug.id}: needs-callers needs evidence in a caller or registration outside the diff, in a file the change does not touch`);
  }
  if (bug.tags.includes("deletion")) {
    const own = [{ file: bug.file, lines: bug.lines }, ...(bug.also ?? [])];
    const removed = own.some((o) => (deletedAfter.get(o.file) ?? []).some((after) => (after >= o.lines[0] && after <= o.lines[1]) || (after + 1 >= o.lines[0] && after + 1 <= o.lines[1])));
    if (!removed) p.push(`${bug.id}: deletion needs a place in the bug's lines where the change removed code and wrote nothing in its place`);
  }
  return p;
}
