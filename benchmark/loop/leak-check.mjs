// The leak check of a reviewer change: what in a branch's diff could let the
// loop tune the product on its own truth. propose.mjs runs it before a
// change record is written; nothing here uses a model.
//
// Failure list, written before the code:
// 1. A change edits the truth the loop scores against (a planted case, a
//    real suite's entries, a split, the review queue, the case lock, or a
//    folder outside benchmark/cases that a planted case builds from, such as
//    the demo's): every changed path, old and new side of a rename, is
//    checked against those folders as they stand at the parent.
// 2. An added line names a case: a name of 6 or more characters found in a
//    suite's case files and nowhere in packages/ at the parent commit is a
//    case identifier, and any added line holding one is refused. Names are
//    compared without case, so a changed spelling does not pass.
// 3. A real suite's truth lives outside git (the pinned raw files in the
//    cache) and is silently skipped, so its names pass unchecked: every
//    suite present at the parent is read through its own reader, and a suite
//    without a reader, or a raw file that is missing or differs from its
//    pin, stops the check with exit 2.
// 4. A variant keys on a model id or a provider instead of the profile or
//    the reviewer kind: an added code line that holds a model or provider
//    name in a string or regular expression literal and compares it (an
//    equality, a case label, a string or set method, or a lookup key) is
//    refused. Tests never decide a review, so test files are not read for
//    this.
// 5. A diff is read wrong: paths and modes come from `git diff -z --raw
//    --no-renames`, added lines from a per-file `git diff --text -U0` parsed
//    by hunk header, never from a model and never from the working tree.
// 6. A changed path is a symbolic link or a submodule: the check reads the
//    link's target string while the lens loader follows the link, so any
//    changed entry with mode 120000 or 160000, on either side, is refused
//    before its content is read.
// 7. A changed file git calls binary (a NUL byte in a lens body) shows no
//    hunks, so its added lines read as none and a case identifier passes:
//    the diff is taken with --text, and a file whose new content holds a NUL
//    byte or bytes that are not UTF-8 is refused as not text.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix } from "node:path";

// A failure of the check itself (exit 2), as opposed to a refusal (exit 1).
export class ToolError extends Error {}

// The loop's truth: no reviewer change may touch these.
export const TRUTH_FOLDERS = ["benchmark/cases/", "benchmark/suites/", "benchmark/splits/", "benchmark/review-queue/"];
export const TRUTH_FILES = ["benchmark/cases.lock.json"];

export const MIN_NAME = 6;

function gitEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_") && v !== undefined) env[k] = v;
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
}

// One git command in `repo`; stdout as text, or as bytes with `buffer`.
// `ok` lists exit codes that are answers rather than failures.
export function git(repo, args, { input, buffer = false, ok = [0] } = {}) {
  const r = spawnSync("git", ["-c", "core.quotePath=false", ...args], { cwd: repo, env: gitEnv(), input, maxBuffer: 1 << 30, ...(buffer ? {} : { encoding: "utf8" }) });
  if (r.error) throw new ToolError(`git ${args[0]} could not start: ${r.error.message}`);
  if (!ok.includes(r.status)) throw new ToolError(`git ${args.join(" ")} failed in ${repo}: ${String(r.stderr).trim()}`);
  return { out: r.stdout, status: r.status };
}

export const revParse = (repo, rev) => git(repo, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { ok: [0, 1] }).out.trim() || null;

// Every text file under the given paths at a commit, as a Map of path to
// text. Binary files, links and submodules are left out.
export function blobsAt(repo, rev, paths) {
  const listing = git(repo, ["ls-tree", "-r", "-z", "--full-tree", rev, "--", ...paths]).out;
  const entries = [];
  for (const record of listing.split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    const [mode, type, sha] = record.slice(0, tab).split(" ");
    if (type === "blob" && mode !== "120000") entries.push({ path: record.slice(tab + 1), sha });
  }
  const files = new Map();
  if (entries.length === 0) return files;
  const out = git(repo, ["cat-file", "--batch"], { input: `${entries.map((e) => e.sha).join("\n")}\n`, buffer: true }).out;
  let at = 0;
  for (const { path, sha } of entries) {
    const end = out.indexOf(10, at);
    const [got, type, size] = out.subarray(at, end).toString("utf8").split(" ");
    if (got !== sha || type !== "blob") throw new ToolError(`git cat-file answered ${got} ${type} for ${path} (${sha})`);
    const bytes = out.subarray(end + 1, end + 1 + Number(size));
    at = end + 1 + Number(size) + 1;
    if (!bytes.subarray(0, 8000).includes(0)) files.set(path, bytes.toString("utf8"));
  }
  return files;
}

// The names in a text, lower case: every word ([A-Za-z_$] then word
// characters) and every run of two or more words joined by "." or "-"
// (os.path.join, flask-path-traversal), each 6 or more characters long.
export function names(text, into = new Set()) {
  for (const m of text.matchAll(/[A-Za-z_$][\w$]*(?:[.-][A-Za-z_$][\w$]*)*/g)) {
    const parts = [];
    const seps = [];
    const re = /([A-Za-z_$][\w$]*)([.-]?)/g;
    for (const p of m[0].matchAll(re)) {
      parts.push(p[1]);
      seps.push(p[2]);
    }
    for (let i = 0; i < parts.length; i++) {
      let name = "";
      for (let j = i; j < parts.length; j++) {
        name += (j > i ? seps[j - 1] : "") + parts[j];
        if (name.length >= MIN_NAME) into.add(name.toLowerCase());
      }
    }
  }
  return into;
}

// ---------- the case files of each suite ----------

const cacheRoot = (env = process.env) => env.OPENQODEX_BENCH_CACHE || join(homedir(), ".cache", "openqodex-bench");

// The folders each planted case builds from, relative to the repository
// root: its own folder and the base and change folders its spec names.
export function plantedFolders(repo, rev) {
  const specs = [...blobsAt(repo, rev, ["benchmark/cases"])].filter(([path]) => /^benchmark\/cases\/[^/]+\/case\.json$/.test(path));
  return specs.map(([path, text]) => {
    const dir = posix.dirname(path);
    let spec;
    try {
      spec = JSON.parse(text);
    } catch (error) {
      throw new ToolError(`${path} at ${rev.slice(0, 8)} is not JSON (${error.message})`);
    }
    const folders = [dir, posix.normalize(posix.join(dir, spec.base ?? "base")), posix.normalize(posix.join(dir, spec.change ?? "change"))];
    return { name: posix.basename(dir), folders: [...new Set(folders)].map((f) => `${f}/`) };
  });
}

// planted: every file each planted case builds from, at the parent.
function plantedTexts(repo, rev) {
  const out = [];
  for (const { name, folders } of plantedFolders(repo, rev)) {
    for (const text of blobsAt(repo, rev, folders).values()) out.push({ source: `planted/${name}`, text });
  }
  return out;
}

// A real suite: its committed entries, and the pinned raw files of its board
// from the cache ($OPENQODEX_BENCH_CACHE/raw/<board>/<path>), each checked
// against its sha256 in benchmark/outside/boards.json at the parent. P1-T9
// owns the raw layout; this reader follows it.
const boardTexts = (board) => (repo, rev, suite, env) => {
  const out = [...blobsAt(repo, rev, [`benchmark/suites/${suite}`])].map(([path, text]) => ({ source: `${suite}/${posix.basename(path)}`, text }));
  const boards = blobsAt(repo, rev, ["benchmark/outside/boards.json"]).get("benchmark/outside/boards.json");
  const pins = boards ? JSON.parse(boards).boards?.[board]?.data : null;
  if (!Array.isArray(pins) || pins.length === 0) throw new ToolError(`the ${suite} suite has no pinned raw files for board ${board} in benchmark/outside/boards.json, so its truth cannot be read`);
  for (const pin of pins) {
    const file = join(cacheRoot(env), "raw", board, pin.path);
    if (!existsSync(file)) throw new ToolError(`the ${suite} suite's raw file ${pin.path} is missing from the cache (${file}); fetch it before proposing, or its truth names go unchecked`);
    const bytes = readFileSync(file);
    const sha = createHash("sha256").update(bytes).digest("hex");
    if (sha !== pin.sha256) throw new ToolError(`the ${suite} suite's raw file ${file} has sha256 ${sha}, not the pinned ${pin.sha256}`);
    out.push({ source: `${suite}/${pin.path}`, text: bytes.toString("utf8") });
  }
  return out;
};

// One reader per suite. A suite under benchmark/suites/ with no reader here
// stops the check until one is written.
export const SUITE_READERS = {
  planted: plantedTexts,
  aacr: boardTexts("aacr"),
  martian: boardTexts("martian"),
};

// The suites present at a commit: planted, and every benchmark/suites/<s>/
// that holds a cases.json.
export function suitesAt(repo, rev) {
  const listing = git(repo, ["ls-tree", "-r", "-z", "--name-only", "--full-tree", rev, "--", "benchmark/suites"]).out.split("\0");
  const real = listing.map((p) => /^benchmark\/suites\/([^/]+)\/cases\.json$/.exec(p)?.[1]).filter(Boolean);
  return ["planted", ...new Set(real)];
}

const known = new Map();

// The names packages/ holds at a commit (memoised per repository and commit).
export function packageNames(repo, rev) {
  const key = `${repo}\0${rev}`;
  if (!known.has(key)) {
    const set = new Set();
    for (const text of blobsAt(repo, rev, ["packages"]).values()) names(text, set);
    known.set(key, set);
  }
  return known.get(key);
}

// The case identifiers at a commit: Map of name to the first source that
// holds it, for every name in a suite's case files that packages/ lacks.
export function caseIdentifiers(repo, rev, env = process.env) {
  const inPackages = packageNames(repo, rev);
  const ids = new Map();
  for (const suite of suitesAt(repo, rev)) {
    const read = SUITE_READERS[suite];
    if (!read) throw new ToolError(`no identifier reader for suite ${suite}; add one to benchmark/loop/leak-check.mjs before a change can be checked against its truth`);
    for (const { source, text } of read(repo, rev, suite, env)) {
      for (const name of names(text)) if (!inPackages.has(name) && !ids.has(name)) ids.set(name, source);
    }
  }
  return ids;
}

// ---------- the diff ----------

// Every changed path between two commits, both sides of a rename, with its
// old and new mode and its new blob.
export function changedPaths(repo, parent, commit) {
  const fields = git(repo, ["diff", "--no-ext-diff", "--no-renames", "--no-abbrev", "-z", "--raw", parent, commit]).out.split("\0");
  const out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [oldMode, newMode, , newSha, status] = fields[i].replace(/^:/, "").split(" ");
    out.push({ status, path: fields[i + 1], oldMode, newMode, newSha });
  }
  return out;
}

const LINK_MODES = ["120000", "160000"];
const utf8 = new TextDecoder("utf-8", { fatal: true });

// Whether a blob reads as text: no NUL byte and valid UTF-8.
export function isText(bytes) {
  if (bytes.includes(0)) return false;
  try {
    utf8.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

// The added lines of one file, with their line numbers in the commit.
export function addedLines(repo, parent, commit, path) {
  const text = git(repo, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--text", "-U0", parent, commit, "--", path]).out;
  const out = [];
  let line = null;
  for (const row of text.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (line === null) continue;
    if (row.startsWith("+")) out.push({ line: line++, text: row.slice(1) });
    else if (row.startsWith(" ")) line++;
  }
  return out;
}

// ---------- model and provider comparisons ----------

// The string, template and regular expression literals of one line of code,
// with where each starts and ends. A line comment ends the scan.
export function literals(line) {
  const out = [];
  let prev = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "/" && line[i + 1] === "/") break;
    const regex = c === "/" && (prev === "" || "(,=:[!&|?{};".includes(prev));
    if (c === '"' || c === "'" || c === "`" || regex) {
      let j = i + 1;
      let inClass = false;
      let text = "";
      for (; j < line.length; j++) {
        if (line[j] === "\\") {
          text += line[j + 1] ?? "";
          j++;
        } else if (regex && line[j] === "[") {
          inClass = true;
          text += "[";
        } else if (regex && line[j] === "]") {
          inClass = false;
          text += "]";
        } else if (line[j] === c && !inClass) break;
        else text += line[j];
      }
      out.push({ text, start: i, end: j });
      i = j;
      prev = c;
      continue;
    }
    if (!/\s/.test(c)) prev = c;
  }
  return out;
}

const COMPARES = /===|!==|==|!=|\bcase\b|\.(?:startsWith|endsWith|includes|indexOf|lastIndexOf|test|exec|match|matchAll|search|localeCompare|has|get)\s*\(/;
const CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const TEST = /(?:^|\/)test\/|\.test\.[cm]?[jt]sx?$/;

// The model or provider name a line compares, or null.
export function comparedModel(line, modelNames) {
  for (const lit of literals(line)) {
    const word = lit.text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((t) => modelNames.find((m) => t === m || (t.startsWith(m) && /^\d/.test(t.slice(m.length)))))
      .find(Boolean);
    if (!word) continue;
    const keyed = line.slice(0, lit.start).trimEnd().endsWith("[") || line.slice(lit.end + 1).trimStart().startsWith(":");
    if (keyed || COMPARES.test(line)) return word;
  }
  return null;
}

// ---------- the check ----------

export const inTruth = (path, plantedPrefixes) => TRUTH_FILES.includes(path) || [...TRUTH_FOLDERS, ...plantedPrefixes].some((f) => path.startsWith(f));

// What the diff from parent to commit does that the loop must refuse.
// Returns { changed, refusals }; throws ToolError when the check cannot run.
export function leakRefusals(repo, parent, commit, { modelNames, env = process.env }) {
  const refusals = [];
  const changed = changedPaths(repo, parent, commit);
  const plantedPrefixes = plantedFolders(repo, parent).flatMap((c) => c.folders);
  const ids = caseIdentifiers(repo, parent, env);
  for (const { status, path, oldMode, newMode, newSha } of changed) {
    if (inTruth(path, plantedPrefixes)) {
      refusals.push(`${path}: a change to the loop's truth (planted cases and the folders they build from, real suites, splits, the review queue or the case lock) never enters the loop`);
      continue;
    }
    const link = [oldMode, newMode].find((m) => LINK_MODES.includes(m));
    if (link) {
      refusals.push(`${path} is a symbolic link or a submodule (mode ${link}); a reviewer change holds plain files only, so what the product reads is what this check read`);
      continue;
    }
    if (status === "D") continue;
    if (!isText(git(repo, ["cat-file", "blob", newSha], { buffer: true }).out)) refusals.push(`${path} is not text (it holds a NUL byte or bytes that are not UTF-8); a reviewer change holds text files only`);
    const checkModels = CODE.test(path) && !TEST.test(path);
    for (const { line, text } of addedLines(repo, parent, commit, path)) {
      // One refusal per line, naming the longest names only (flask-path-traversal, not also flask-path).
      const hits = [...names(text)].filter((n) => ids.has(n));
      const longest = hits.filter((n) => !hits.some((m) => m !== n && m.includes(n)));
      if (longest.length > 0) refusals.push(`${path}:${line} names case identifiers that packages/ did not hold at the parent: ${longest.map((n) => `${n} (${ids.get(n)})`).join(", ")}`);
      const model = checkModels ? comparedModel(text, modelNames) : null;
      if (model) refusals.push(`${path}:${line} compares a model id or a provider name (${model}); a variant keys only on the profile or the reviewer kind`);
    }
  }
  return { changed, refusals };
}
