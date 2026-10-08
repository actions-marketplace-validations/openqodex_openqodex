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
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const benchRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const repoRoot = resolve(benchRoot, "..");
export const casesRoot = join(benchRoot, "cases");

// The product's own vocabularies (packages/core/src/types.ts and severity.ts).
export const CATEGORIES = ["bug", "security", "performance", "maintainability", "style"];
export const SEVERITIES = ["info", "nitpick", "minor", "major", "critical"];
// Who is expected to find a bug: a scanner by name, the reviewer's reading
// of the diff, or the reviewer helped by the code graph's caller list.
export const FINDERS = ["gitleaks", "semgrep", "bandit", "ruff", "oxlint", "osv-scanner", "hadolint", "shellcheck", "actionlint", "brakeman", "rubocop", "golangci", "suppression", "reasoning", "graph"];

const FIXED_DATE = "2026-01-01T00:00:00Z";
const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function listCases(root = casesRoot) {
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, "case.json")))
    .map((e) => e.name)
    .sort();
}

const isRange = (r) => Array.isArray(r) && r.length === 2 && r.every((n) => Number.isInteger(n) && n >= 1) && r[0] <= r[1];

// Every problem with a spec, one line each; empty when it is sound.
export function specProblems(spec, id) {
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
    need(b.mentions === undefined || (Array.isArray(b.mentions) && b.mentions.length > 0 && b.mentions.every((m) => typeof m === "string" && m !== "")), `${at}: mentions must be a non-empty list of words`);
    need(b.also === undefined || (Array.isArray(b.also) && b.also.every((a) => typeof a.file === "string" && isRange(a.lines))), `${at}: also must be a list of { file, lines }`);
  }
  for (const [i, x] of (spec.extras ?? []).entries()) {
    need(typeof x.file === "string" && isRange(x.lines) && typeof x.why === "string", `extras[${i}]: must be { file, lines, why }`);
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

function gitEnv() {
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

function filesUnder(dir) {
  const out = [];
  const walk = (rel) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = rel === "" ? e.name : `${rel}/${e.name}`;
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

// The lines a finding may start on, per file, as the review counts them:
// lines the change added or modified, and the lines on either side of a
// deletion. Computed with git from the built repository (untracked files
// are added with intent-to-add on a copy of the index, so the repository's
// own index is not touched).
export function changedLines(dir) {
  const index = join(mkdtempSync(join(tmpdir(), "oq-bench-index-")), "index");
  const env = { ...gitEnv(), GIT_INDEX_FILE: index };
  const run = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  run("read-tree", "HEAD");
  run("add", "-A", "-N");
  const diff = run("diff", "-U0", "--no-color", "--no-renames", "HEAD");
  const out = new Map();
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
    } else {
      for (let n = start; n < start + count; n++) set.add(n);
    }
  }
  return out;
}
