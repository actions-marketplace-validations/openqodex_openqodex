#!/usr/bin/env node
// Publishes one results folder as one asset, <run-id>.tar.gz, on the
// benchmark-data pre-release, and writes its index entry:
//
//   node benchmark/publish-run.mjs <results folder> [--dry-run] [--write-index] [--out <dir>]
//
// Steps: score the run when it has no score.json; for a legacy run (one with
// a recipe in benchmark/legacy/recipes.json) check that the folder is the one
// the recipe's commit holds, and add the scorer of every commit that wrote
// one of its score files under _archive/<commit>/benchmark/ with the recipe
// as _archive/recipe.json; keep only the files on the allowlist; inspect
// every kept file; package; unpack the package again and compare its file
// list; then, without --dry-run, upload it with gh (creating the pre-release
// on first use, never marked latest) and write benchmark/index/runs/<run-id>.json.
// --dry-run uploads nothing and prints the entry; --write-index writes the
// entry even so. The package is deterministic, so an entry written by a dry
// run names the very asset a later upload sends. Only the session uploads;
// a builder runs --dry-run.
//
// Exit codes: 0 published (or, with --dry-run, ready); 1 refused (a hit in
// the inspection, a folder that is not the recipe's, an asset that differs
// from the committed entry, an asset already uploaded); 2 the tool failed.
//
// Failure list, written before the code:
// 1. A file nobody meant to publish leaves (a rendering, the judge's raw
//    answers, a new file kind): only the allowlist below is packaged; every
//    other file is named as left out.
// 2. A secret leaves: every packaged file, briefs, traces, transcripts,
//    submissions and rounds included, is searched for each case's generated
//    secret value, this machine's home folder path, a home folder path of any
//    platform (/Users/<name>/, /home/<name>/, C:\Users\<name>\), every value
//    of the model settings file (~/.config/openqodex-bench/azure.env, or
//    OPENQODEX_BENCH_MODEL_ENV) and its base URL's host, and the scrub
//    patterns (scripts/scrub-patterns.txt and the private list); one hit
//    refuses the publish and nothing is written. The values themselves are
//    never printed.
// 3. A run with a model reviewer is published from a machine without the
//    model settings file, so its key and base URL are never looked for: such
//    a run is refused unless the file can be read and holds a value.
// 4. A reviewed repository's code leaves when its licence does not allow it:
//    a case whose licence class is not permissive has its brief and trace
//    left out (they carry the code by design), and every other packaged file
//    is searched for the lines of the head and merge base trees the review
//    read, the two commits materialised.json names in the cache
//    ($OPENQODEX_BENCH_CACHE/cases/<case hash>.git). The search is for each
//    line anywhere in the decoded text, whitespace normalised, so a line
//    behind a file name and line number, after a diff marker or inside a
//    sentence is found, and no line is too short to count (a line under 24
//    characters, or one bare name, counts as a whole decoded line only,
//    with a search, line-number or diff prefix removed, since inside other
//    text it would match unrelated words). A hit, or a missing repository,
//    record or commit, refuses the publish.
// 5. A legacy run is published from a folder that is not the committed one:
//    every file must match the blob the recipe's commit holds.
// 6. A legacy run is published without the scorer that wrote its numbers:
//    the scorer files come from git at each recipe commit and must hash to
//    the recipe's sha256.
// 7. The uploaded asset is not the one the committed entry names: the same
//    folder packages to the same bytes with the same Node (a tar written
//    here: sorted, fixed times, owners and modes; gzip with no name or
//    time), an existing entry whose file list differs refuses the publish,
//    and one whose bytes alone differ is rewritten and said so.
// 8. An asset is uploaded twice under one name: an existing asset of that
//    name refuses the upload.
// 9. A run that holds a case whose licence nobody verified leaves the
//    machine: such a case is for private runs only (lib/licence.mjs
//    publishRefusal), and the run is refused before anything is packaged,
//    with every such case named.
// 10. A large repository exhausts memory (issue 186): the run is indexed
//    once, the two trees stream one blob at a time, and a tree line is kept
//    only when the run holds it.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { benchRoot, generatedValue, repoRoot } from "./lib/cases.mjs";
import { publishRefusal } from "./lib/licence.mjs";
import { RELEASE, REPOSITORY, assetUrl, buildEntry, byBytes, entryProblems, fileList, listHash, readEntry, runsRoot, sha256, writeEntry } from "./lib/index.mjs";
import { archiveDir, readRecipes, scorerFiles, scorerHash } from "./legacy/rescore.mjs";
import { extractAsset } from "./fetch-run.mjs";

// The files a run may publish, by path inside the run folder.
export const ALLOWED = [
  /^[^/]+\.jsonl?$/, // manifest, rows, resumes, score files, judge.json, outcomes, unresolved, scanners
  /^cases(-[A-Za-z0-9._-]+)?\/[^/]+\.json$/, // the specs the run used, and amended copies such as cases-v2/
  /^samples\/[^/]+\/[^/]+\/[^/]+\/(sample\.json|stderr\.txt|receipt\.txt|usage\.json|dispositions\.json|completion\.json|transcript\.jsonl|progress\.jsonl)$/,
  /^samples\/[^/]+\/[^/]+\/[^/]+\/report\/(report|scan|trace|submission|reviewer|manifest|rounds)\.json$/,
  /^samples\/[^/]+\/[^/]+\/[^/]+\/report\/brief\.md$/,
  /^outside\/.+\.json$/,
];
// Files that carry the reviewed code by design: left out for a case whose
// licence class is not permissive.
export const CODE_FILES = /^samples\/([^/]+)\/[^/]+\/[^/]+\/report\/(brief\.md|trace\.json)$/;

const FIXED_MTIME = 1767225600; // 2026-01-01T00:00:00Z, the time every packaged file carries

const git = (args, opts = {}) => execFileSync("git", args, { cwd: repoRoot, maxBuffer: 1 << 30, ...opts });

// --- the package: a ustar tarball, the same bytes for the same files ---

function octal(n, width) {
  return `${n.toString(8).padStart(width - 1, "0")}\0`;
}

function header(name, size, type, prefix = "") {
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, 100, "utf8");
  h.write(octal(0o644, 8), 100, "ascii");
  h.write(octal(0, 8), 108, "ascii");
  h.write(octal(0, 8), 116, "ascii");
  h.write(octal(size, 12), 124, "ascii");
  h.write(octal(FIXED_MTIME, 12), 136, "ascii");
  h.write("        ", 148, "ascii");
  h.write(type, 156, "ascii");
  h.write("ustar\0", 257, "ascii");
  h.write("00", 263, "ascii");
  h.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return h;
}

const pad = (n) => Buffer.alloc((512 - (n % 512)) % 512, 0);

// One member: its header (a pax header first when the path does not fit the
// ustar name and prefix fields), its bytes, and the padding.
function member(path, bytes) {
  const out = [];
  let name = path;
  let prefix = "";
  if (Buffer.byteLength(path) > 100) {
    const cut = [...path.matchAll(/\//g)].map((m) => m.index).find((i) => Buffer.byteLength(path.slice(0, i)) <= 155 && Buffer.byteLength(path.slice(i + 1)) <= 100);
    if (cut === undefined) {
      const body = (n) => ` path=${path}\n`.length + String(n).length;
      let len = body(0);
      while (body(len) !== len) len = body(len);
      const record = Buffer.from(`${len} path=${path}\n`, "utf8");
      out.push(header("PaxHeader", record.length, "x"), record, pad(record.length));
      name = path.slice(-100);
    } else {
      prefix = path.slice(0, cut);
      name = path.slice(cut + 1);
    }
  }
  out.push(header(name, bytes.length, "0", prefix), bytes, pad(bytes.length));
  return out;
}

export function tarGz(files) {
  const parts = [];
  for (const f of [...files].sort((a, b) => byBytes(a.path, b.path))) parts.push(...member(f.path, f.bytes));
  parts.push(Buffer.alloc(1024, 0));
  const gz = gzipSync(Buffer.concat(parts), { level: 9 });
  // Byte 9 names the operating system that compressed it; zlib sets it by
  // the platform it was built for. 255 is "unknown" on every platform.
  gz[9] = 0xff;
  return gz;
}

// --- what a run publishes ---

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

// Each case's record in the run (its own copy of the spec or case entry),
// with its licence class: planted cases are this repository's own code.
function caseRecords(folder, paths) {
  const out = new Map();
  for (const p of paths.filter((x) => /^cases\/[^/]+\.json$/.test(x))) {
    const record = readJson(join(folder, p));
    const name = p.slice("cases/".length, -".json".length);
    const planted = record.suite === undefined || record.suite === "planted";
    out.set(name, { name, record, planted, licence: planted ? "permissive" : (record.source?.licence?.class ?? "unknown") });
  }
  return out;
}

// The scrub patterns: the public list, and the private list beside the
// repository's main checkout when there is one (a worktree shares it).
function scrubPatterns() {
  const lists = [{ file: join(repoRoot, "scripts", "scrub-patterns.txt"), private: false }];
  const common = (() => {
    try {
      return resolve(repoRoot, git(["rev-parse", "--git-common-dir"]).toString("utf8").trim(), "..");
    } catch {
      return repoRoot;
    }
  })();
  for (const root of new Set([repoRoot, common])) lists.push({ file: join(root, ".private", "scrub-patterns.txt"), private: true });
  const out = [];
  const seen = new Set();
  for (const l of lists.filter((x) => existsSync(x.file))) {
    for (const source of readFileSync(l.file, "utf8").split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#"))) {
      if (seen.has(source)) continue;
      seen.add(source);
      out.push({ regex: new RegExp(source, "i"), label: l.private ? "matches a private scrub pattern" : `matches the scrub pattern ${source}` });
    }
  }
  return out;
}

// The reviewers of a run that call a model over HTTP: the server path, a
// `model:<deployment>` reviewer, or a reviewer recorded with an endpoint.
function modelReviewers(manifest) {
  const named = Object.entries(manifest?.reviewers ?? {})
    .filter(([name, r]) => name.startsWith("model:") || r?.endpoint !== undefined || r?.endpointHash !== undefined)
    .map(([name]) => name);
  return named.length === 0 && manifest?.path === "server" ? ["the server path"] : named;
}

// Every value of the model settings file, and the host of each URL in it.
// A run with a model reviewer is refused when the file cannot be read here,
// since that run may hold the key or base URL and nothing could find them.
function modelValues(env, runId, manifest) {
  const path = env.OPENQODEX_BENCH_MODEL_ENV ?? join(homedir(), ".config", "openqodex-bench", "azure.env");
  const model = modelReviewers(manifest);
  let text = null;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    if (model.length > 0) throw new Error(`refused: ${runId} uses a model reviewer (${model.join(", ")}), and the model settings file ${path} cannot be read here, so its key and base URL cannot be looked for; publish it where that file is`);
    return [];
  }
  const values = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const value = m[1].replace(/^(["'])(.*)\1$/, "$2");
    if (value.length < 8) continue;
    values.push(value);
    try {
      const host = new URL(value).host;
      if (host.length >= 8) values.push(host);
    } catch {
      // not a URL
    }
  }
  if (model.length > 0 && values.length === 0) throw new Error(`refused: ${runId} uses a model reviewer (${model.join(", ")}), and the model settings file ${path} holds no key or base URL to look for`);
  return values;
}

// Streams each line of the head and merge base trees the reviewer saw to
// visit. materialised.json pins the cache's two commits, whose trees mirror
// upstream. Shared blobs are read once, one blob at a time. No line is kept.
async function codeLines(c, env, visit) {
  const cache = env.OPENQODEX_BENCH_CACHE ?? join(homedir(), ".cache", "openqodex-bench");
  const repo = join(cache, "cases", `${c.record.hash}.git`);
  if (!c.record.hash || !existsSync(repo)) throw new Error(`${c.name} is ${c.licence} and its repository is not in the cache (${join("$OPENQODEX_BENCH_CACHE", "cases", `${c.record.hash ?? "<hash>"}.git`)}), so its code cannot be looked for; materialise the case first`);
  let record;
  try {
    record = readJson(join(repo, "materialised.json"));
  } catch {
    throw new Error(`refused: ${c.name}: its materialised record cannot be read, so its code cannot be looked for; materialise the case first`);
  }
  for (const kind of ["head", "base"]) {
    if (typeof record?.[kind] !== "string" || !/^[a-f0-9]{40}$/.test(record[kind])) throw new Error(`refused: ${c.name}: its materialised record lacks a valid ${kind} commit, so its code cannot be looked for; materialise the case first`);
  }
  const start = (args) => {
    const child = spawn("git", ["--git-dir", repo, ...args], { stdio: ["pipe", "pipe", "ignore"] });
    const done = new Promise((resolve) => {
      child.once("error", () => resolve(false));
      child.once("close", (code) => resolve(code === 0));
    });
    // A broken batch pipe is reported by the checked process exit below.
    child.stdin.on("error", () => {});
    return { child, done };
  };
  const batch = start(["cat-file", "--batch"]);
  const chunks = batch.child.stdout[Symbol.asyncIterator]();
  let chunk = Buffer.alloc(0);
  let offset = 0;
  const refill = async () => {
    if (offset < chunk.length) return;
    const next = await chunks.next();
    if (next.done) throw new Error("incomplete blob");
    chunk = next.value;
    offset = 0;
  };
  const read = async (size) => {
    const body = Buffer.allocUnsafe(size);
    let at = 0;
    while (at < size) {
      await refill();
      const count = Math.min(size - at, chunk.length - offset);
      chunk.copy(body, at, offset, offset + count);
      at += count;
      offset += count;
    }
    return body;
  };
  const header = async () => {
    let text = "";
    while (true) {
      await refill();
      const end = chunk.indexOf(10, offset);
      if (end >= 0) {
        text += chunk.toString("ascii", offset, end);
        offset = end + 1;
        return text;
      }
      text += chunk.toString("ascii", offset);
      offset = chunk.length;
      if (text.length > 100) throw new Error("invalid blob header");
    }
  };
  const seen = new Set();
  try {
    for (const kind of ["head", "base"]) {
      const tree = start(["ls-tree", "-r", "-z", `${record[kind]}^{commit}`]);
      tree.child.stdin.end();
      try {
        let pending = "";
        for await (const bytes of tree.child.stdout) {
          pending += bytes.toString("utf8");
          let end;
          while ((end = pending.indexOf("\0")) >= 0) {
            const entry = pending.slice(0, end);
            pending = pending.slice(end + 1);
            const id = /^\d+ blob ([a-f0-9]{40})\t/.exec(entry)?.[1];
            if (!id || seen.has(id)) continue;
            seen.add(id);
            batch.child.stdin.write(`${id}\n`);
            const match = /^([a-f0-9]{40}) blob (\d+)$/.exec(await header());
            if (!match || match[1] !== id) throw new Error("invalid blob header");
            const size = Number(match[2]);
            if (!Number.isSafeInteger(size)) throw new Error("invalid blob size");
            const body = await read(size);
            if ((await read(1))[0] !== 10) throw new Error("invalid blob terminator");
            if (body.includes(0)) continue;
            const text = body.toString("utf8");
            let at = 0;
            while (at <= text.length) {
              const nl = text.indexOf("\n", at);
              const line = normalise(text.slice(at, nl < 0 ? text.length : nl));
              if (!carriesNoCode(line)) visit(line);
              if (nl < 0) break;
              at = nl + 1;
            }
          }
        }
        if (pending !== "" || !await tree.done) throw new Error("incomplete tree");
      } catch {
        throw new Error(`refused: ${c.name}: its cached ${kind} commit, tree or blob cannot be read, so its code cannot be looked for; materialise the case first`);
      } finally {
        tree.child.kill();
        await tree.done;
      }
    }
    batch.child.stdin.end();
    if (!await batch.done) throw new Error(`refused: ${c.name}: a blob in its reviewed trees cannot be read; materialise the case first`);
  } finally {
    batch.child.kill();
    await batch.done;
  }
}

// Whitespace runs become one space, so a line matches however it was
// indented, wrapped in a table cell or prefixed by a reader tool.
const normalise = (s) => s.replace(/\s+/g, " ").trim();

// The only source lines left out of the search, because they hold no code
// of their own: blank lines, lines of punctuation alone (a lone brace or
// bracket such as `}` or `});`, a comment marker such as `*/`), a number
// alone (`1,` in a list; every run's own JSON prints such lines), and a
// single keyword (`else:`, `end`, `return;`). Every other line counts,
// however short: a two-line function is still the repository's code.
const KEYWORDS = new Set(["abstract", "and", "async", "await", "begin", "break", "case", "catch", "class", "const", "continue", "debugger", "def", "default", "defer", "do", "done", "echo", "elif", "else", "end", "endfor", "endif", "endwhile", "ensure", "enum", "esac", "except", "export", "extends", "false", "fi", "final", "finally", "fn", "for", "foreach", "from", "func", "function", "go", "goto", "if", "impl", "implements", "import", "in", "interface", "is", "let", "loop", "match", "mod", "module", "mut", "namespace", "new", "nil", "none", "not", "null", "or", "override", "package", "pass", "print", "private", "protected", "pub", "public", "raise", "require", "rescue", "return", "select", "self", "static", "struct", "super", "switch", "template", "then", "this", "throw", "true", "try", "type", "undefined", "union", "unless", "until", "use", "using", "var", "virtual", "when", "where", "while", "with", "yield"]);
export function carriesNoCode(line) {
  if (line === "" || !/[A-Za-z0-9]/.test(line)) return true;
  if (/^[-+]?\d[\dA-Fa-fxXoObB._]*[,;:]*$/.test(line)) return true;
  const word = /^([A-Za-z_]+)[:;,]?$/.exec(line);
  return word !== null && KEYWORDS.has(word[1].toLowerCase());
}

// A line of at least SUBSTRING_MIN characters, not one bare name, is looked
// for anywhere in the text. A shorter one (`import os`, `} else {`,
// `return x * 3`) or one bare name (`name,`) still counts, but only as the
// whole of a decoded line, as is or once a search's `path:line:` prefix, a
// reader's line number or a diff marker is removed: found inside other text
// it would match unrelated prose and code and refuse nearly every publish.
export const SUBSTRING_MIN = 24;
export const wholeOnly = (line) => line.length < SUBSTRING_MIN || /^[A-Za-z0-9_$.]+[,;:]*$/.test(line);
const LINE_PREFIX = /^(?:\S+:\d+:\s?|\d+(?:\t|:|\s*\|)\s?|[+-]\s?)/;
const wholeForms = (t) => {
  const s = t.replace(/^\s+/, "");
  return [normalise(s), normalise(s.replace(LINE_PREFIX, ""))];
};

// Whether the run may hold a source line: a short or bare-name line as a
// whole-line form, any other by the fingerprint of its first 24 characters,
// confirmed with includes. includes ignores word edges; inspect checks them.
// Hash UTF-16 windows modulo 2^32. Zero is the table's empty slot, so
// the zero fingerprint shares the slot for one. Collisions only cause an
// extra includes check, never a refusal on their own.
const HASH_BASE = 31;
const fingerprint = (text, at = 0) => {
  let hash = 0;
  for (let i = 0; i < SUBSTRING_MIN; i++) hash = (Math.imul(hash, HASH_BASE) + text.charCodeAt(at + i)) >>> 0;
  return hash;
};
function runIndex(text, whole) {
  const windows = Math.max(0, text.length - SUBSTRING_MIN + 1);
  let size = 1;
  while (size <= windows * 2) size *= 2;
  const table = new Uint32Array(size);
  const mask = size - 1;
  const slot = (hash) => {
    // Mix the polynomial hash before probing, including its high bits.
    let mixed = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
    mixed = Math.imul(mixed ^ (mixed >>> 13), 0xc2b2ae35);
    let at = (mixed ^ (mixed >>> 16)) & mask;
    while (table[at] !== 0 && table[at] !== hash) at = (at + 1) & mask;
    return at;
  };
  let power = 1;
  for (let i = 1; i < SUBSTRING_MIN; i++) power = Math.imul(power, HASH_BASE);
  let hash = windows > 0 ? fingerprint(text) : 0;
  for (let at = 0; at < windows; at++) {
    const key = hash || 1;
    table[slot(key)] = key;
    if (at + 1 < windows) hash = (Math.imul(hash - Math.imul(text.charCodeAt(at), power), HASH_BASE) + text.charCodeAt(at + SUBSTRING_MIN)) >>> 0;
  }
  return (line) => {
    if (wholeOnly(line)) return whole.has(line);
    const key = fingerprint(line) || 1;
    return table[slot(key)] === key && text.includes(line);
  };
}

const WORD = /[A-Za-z0-9_$]/;

// Finds which of many strings occur anywhere in a text, in one pass over it
// (Aho-Corasick over UTF-16 units). A match must not cut a word in two: a
// pattern that starts or ends with a word character needs a non-word
// character, or the text's edge, beside it.
export function substringMatcher(patterns) {
  const list = [...new Set(patterns)];
  const next = [new Map()];
  const fail = [0];
  const own = [[]];
  for (const [id, p] of list.entries()) {
    let s = 0;
    for (let k = 0; k < p.length; k++) {
      let t = next[s].get(p[k]);
      if (t === undefined) {
        t = next.length;
        next.push(new Map());
        fail.push(0);
        own.push([]);
        next[s].set(p[k], t);
      }
      s = t;
    }
    own[s].push(id);
  }
  // `link[s]`: the nearest state on the failure chain where a pattern ends.
  const link = Array.from({ length: next.length }, () => 0);
  const queue = [...next[0].values()];
  for (let i = 0; i < queue.length; i++) {
    const s = queue[i];
    for (const [ch, t] of next[s]) {
      let f = fail[s];
      while (f !== 0 && !next[f].has(ch)) f = fail[f];
      const g = next[f].get(ch);
      fail[t] = g !== undefined && g !== t ? g : 0;
      link[t] = own[fail[t]].length > 0 ? fail[t] : link[fail[t]];
      queue.push(t);
    }
  }
  return (text) => {
    const found = [];
    let s = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      while (s !== 0 && !next[s].has(ch)) s = fail[s];
      s = next[s].get(ch) ?? 0;
      for (let u = own[s].length > 0 ? s : link[s]; u !== 0; u = link[u]) {
        for (const id of own[u]) {
          const p = list[id];
          const start = i - p.length + 1;
          if (WORD.test(p[0]) && start > 0 && WORD.test(text[start - 1])) continue;
          if (WORD.test(p[p.length - 1]) && i + 1 < text.length && WORD.test(text[i + 1])) continue;
          found.push(p);
        }
      }
    }
    return found;
  };
}

// The texts one line of a file may carry: the line itself and every JSON
// string in it, decoded and split into its own lines.
function textsOf(line) {
  const out = [line];
  for (const m of line.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
    try {
      const s = JSON.parse(m[0]);
      if (s !== m[0].slice(1, -1)) out.push(s);
      if (s.includes("\n")) out.push(...s.split("\n"));
    } catch {
      // not a JSON string
    }
  }
  return out;
}

// A home folder of any platform, followed by a path inside it:
// /Users/<name>/, /home/<name>/, C:\Users\<name>\ (or with forward slashes).
// A name in angle brackets or starting with $ is a placeholder, not a home.
const HOME_PATH = /(?:^|[^\w.~-])(?:\/Users\/[^/\s"'`<>$]+\/|\/home\/[^/\s"'`<>$]+\/|[A-Za-z]:[\\/]Users[\\/][^\\/\s"'`<>$]+[\\/])/;

// Every hit in the files to publish, as "<path>:<line>: <what>", and how
// many values and patterns of each kind were looked for.
export async function inspect(folder, files, { cases, env = process.env, manifest = null } = {}) {
  const needles = [];
  for (const c of cases.values()) {
    if (!c.planted) continue;
    for (const g of c.record.generated ?? []) needles.push({ value: generatedValue(c.name, g.file, g.kind), label: `the generated secret of ${c.name}` });
  }
  const home = homedir();
  if (home.length > 1) needles.push({ value: home, label: "the home folder path" });
  for (const value of modelValues(env, basename(folder), manifest)) needles.push({ value, label: "a value from the model settings file" });
  const patterns = scrubPatterns();
  patterns.push({ regex: HOME_PATH, label: "a home folder path" });
  const code = [...cases.values()].filter((c) => c.licence !== "permissive");
  const whole = new Set();
  const runParts = [];
  // What was looked for, by kind and count only, for the publish's report.
  const looked = {
    secrets: needles.filter((n) => n.label.startsWith("the generated secret")).length,
    modelValues: needles.filter((n) => n.label === "a value from the model settings file").length,
    patterns: patterns.filter((p) => p.label.startsWith("matches the scrub")).length,
    privatePatterns: patterns.filter((p) => p.label.startsWith("matches a private")).length,
    codeCases: code.length,
  };
  const hits = [];
  for (const f of files) {
    const text = f.bytes.toString("utf8");
    text.split("\n").forEach((line, i) => {
      const at = `${f.path}:${i + 1}`;
      const texts = textsOf(line);
      for (const n of needles) if (texts.some((t) => t.includes(n.value))) hits.push(`${at}: ${n.label}`);
      for (const p of patterns) if (texts.some((t) => p.regex.test(t))) hits.push(`${at}: ${p.label}`);
      if (code.length > 0) {
        for (const t of texts) {
          for (const form of wholeForms(t)) if (wholeOnly(form)) whole.add(form);
          runParts.push(normalise(t));
        }
      }
    });
  }
  if (code.length > 0) {
    const matches = runIndex(runParts.join("\n"), whole);
    runParts.length = 0;
    for (const c of code) {
      // Only tree lines the run holds are kept, so this grows with the run.
      const quoted = new Set();
      await codeLines(c, env, (line) => {
        if (matches(line)) quoted.add(line);
      });
      if (quoted.size === 0) continue;
      // Anywhere in the decoded text: behind a file name and line number as
      // a search prints it, after a diff marker, inside a sentence.
      const find = substringMatcher([...quoted].filter((l) => !wholeOnly(l)));
      for (const f of files) {
        f.bytes.toString("utf8").split("\n").forEach((line, i) => {
          if (textsOf(line).some((t) => wholeForms(t).some((w) => quoted.has(w) && wholeOnly(w)) || find(normalise(t)).length > 0)) hits.push(`${f.path}:${i + 1}: a line of ${c.name}'s code, whose licence class is ${c.licence}`);
        });
      }
    }
  }
  return { hits: [...new Set(hits)], looked };
}

// For a legacy run: every file of the folder must be the blob the recipe's
// commit holds at the same path, and the commit must hold no other file.
function originalsProblems(folder, recipe) {
  const listing = git(["ls-tree", "-r", "-z", recipe.originals.commit, "--", recipe.originals.path]).toString("utf8").split("\0").filter(Boolean);
  if (listing.length === 0) return [`commit ${recipe.originals.commit} holds no ${recipe.originals.path}; is this a full clone?`];
  const committed = new Map(listing.map((l) => [l.split("\t")[1].slice(recipe.originals.path.length + 1), l.split(" ")[2].split("\t")[0]]));
  const local = fileList(folder);
  const problems = [];
  for (const p of local) {
    if (!committed.has(p)) {
      if (ALLOWED.some((re) => re.test(p))) problems.push(`${p} is not in the folder ${recipe.originals.commit.slice(0, 7)} holds`);
      continue;
    }
    const bytes = readFileSync(join(folder, p));
    const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (blob !== committed.get(p)) problems.push(`${p} differs from the file ${recipe.originals.commit.slice(0, 7)} holds`);
  }
  for (const p of committed.keys()) if (!local.includes(p)) problems.push(`${p} is missing; ${recipe.originals.commit.slice(0, 7)} holds it`);
  return problems;
}

// Packages a run into <out>/<run-id>.tar.gz after every check, and returns
// what the index entry records about it. Throws, writing nothing, on any hit.
export async function packageRun(folder, { out, env = process.env, recipes = readRecipes() } = {}) {
  folder = resolve(folder);
  const runId = basename(folder);
  if (!existsSync(join(folder, "manifest.json"))) throw new Error(`${folder} has no manifest.json; it is not a benchmark run`);
  const recipe = recipes.runs[runId] ?? null;
  const local = fileList(folder);
  const privateListHash = listHash(local.map((path) => ({ path, sha256: sha256(readFileSync(join(folder, path))) })));
  if (recipe) {
    const problems = originalsProblems(folder, recipe);
    if (problems.length > 0) throw new Error(`refused: ${runId} is not the folder its recipe names:\n${problems.slice(0, 20).join("\n")}`);
  }
  const cases = caseRecords(folder, local);
  const unverified = publishRefusal([...cases.values()]);
  if (unverified !== null) throw new Error(unverified);
  const left = [];
  const files = [];
  for (const path of local) {
    const code = CODE_FILES.exec(path);
    const hidden = code && cases.get(code[1])?.licence !== "permissive";
    if (!ALLOWED.some((re) => re.test(path)) || hidden) left.push(path);
    else files.push({ path, bytes: readFileSync(join(folder, path)) });
  }
  if (recipe) {
    for (const commit of new Set(recipe.scores.map((s) => s.scorer.commit))) {
      const scorer = scorerFiles(commit);
      const want = recipe.scores.find((s) => s.scorer.commit === commit).scorer.sha256;
      if (scorerHash(scorer) !== want) throw new Error(`refused: the scorer at ${commit} hashes to ${scorerHash(scorer)}, not the recipe's ${want}`);
      for (const f of scorer) files.push({ path: `${archiveDir(commit)}/${f.path}`, bytes: f.bytes });
    }
    files.push({ path: "_archive/recipe.json", bytes: Buffer.from(`${JSON.stringify({ runId, ...recipe }, null, 2)}\n`) });
  }
  const { hits, looked } = await inspect(folder, files, { cases, env, manifest: readJson(join(folder, "manifest.json")) });
  if (hits.length > 0) throw new Error(`refused: ${hits.length} hit${hits.length === 1 ? "" : "s"} in the files to publish:\n${hits.slice(0, 40).join("\n")}`);
  const tar = tarGz(files.map((f) => ({ path: `${runId}/${f.path}`, bytes: f.bytes })));
  mkdirSync(out, { recursive: true });
  const tarPath = join(out, `${runId}.tar.gz`);
  writeFileSync(tarPath, tar);
  return {
    runId,
    tarPath,
    sha256: sha256(tar),
    bytes: tar.length,
    files: files.length,
    listHash: listHash(files.map((f) => ({ path: f.path, sha256: sha256(f.bytes) }))),
    privateListHash,
    left,
    looked,
    legacy: recipe,
  };
}

// The score an entry cites: for a legacy run its recipe's headline file.
function citedScore(folder, recipe) {
  const file = recipe ? recipe.headline : "score.json";
  return readJson(join(folder, file));
}

const gh = (args) => spawnSync("gh", [...args, "--repo", REPOSITORY], { cwd: repoRoot, encoding: "utf8" });

function upload(tarPath, runId) {
  const view = gh(["release", "view", RELEASE, "--json", "assets", "--jq", ".assets[].name"]);
  if (view.status !== 0) {
    if (!/release not found/i.test(view.stderr)) throw new Error(`gh release view ${RELEASE} failed: ${view.stderr.trim()}`);
    const made = gh(["release", "create", RELEASE, "--prerelease", "--latest=false", "--title", "Benchmark data (not a product release)", "--notes", "One asset per benchmark run, <run-id>.tar.gz, named by benchmark/index/runs/<run-id>.json in the repository. Fetch one with node benchmark/fetch-run.mjs <run-id>. This is not a release of the package."]);
    if (made.status !== 0) throw new Error(`gh release create ${RELEASE} failed: ${made.stderr.trim()}`);
  } else if (view.stdout.split("\n").includes(`${runId}.tar.gz`)) {
    throw new Error(`refused: ${RELEASE} already holds ${runId}.tar.gz; fetch it with node benchmark/fetch-run.mjs ${runId} to check it`);
  }
  const sent = gh(["release", "upload", RELEASE, tarPath]);
  if (sent.status !== 0) throw new Error(`gh release upload failed: ${sent.stderr.trim()}`);
}

export async function publishRun(folder, { dryRun = false, writeIndex = false, out = null, env = process.env, runs = runsRoot } = {}) {
  folder = resolve(folder);
  const recipes = readRecipes();
  const runId = basename(folder);
  // A smoke run (run.mjs --smoke) checks that the runner works; its numbers are never indexed.
  if (existsSync(join(folder, "manifest.json")) && readJson(join(folder, "manifest.json")).smoke === true) throw new Error(`refused: ${runId} is a smoke run (run.mjs --smoke), which is never indexed or published`);
  const recipe = recipes.runs[runId] ?? null;
  if (!recipe && !existsSync(join(folder, "score.json"))) {
    const scored = spawnSync(process.execPath, [join(benchRoot, "score.mjs"), folder], { encoding: "utf8" });
    if (scored.status === 2) throw new Error(`scoring ${runId} failed:\n${scored.stderr.trim()}`);
  }
  const outDir = out ?? mkdtempSync(join(tmpdir(), "oq-publish-"));
  const asset = await packageRun(folder, { out: outDir, env, recipes });
  // The package must unpack, with the system tar, to the files it was made from.
  const check = mkdtempSync(join(tmpdir(), "oq-publish-check-"));
  try {
    extractAsset(asset.tarPath, asset, check, runId);
  } finally {
    rmSync(check, { recursive: true, force: true });
  }
  const manifest = readJson(join(folder, "manifest.json"));
  const resumes = existsSync(join(folder, "resumes.jsonl")) ? readFileSync(join(folder, "resumes.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const entry = buildEntry({
    runId,
    manifest,
    resumes,
    score: citedScore(folder, recipe),
    asset: { url: assetUrl(runId), sha256: asset.sha256, bytes: asset.bytes, files: asset.files, listHash: asset.listHash },
    privateListHash: asset.privateListHash,
    legacy: recipe,
  });
  const problems = entryProblems(entry);
  if (problems.length > 0) throw new Error(`the entry for ${runId} is not sound:\n${problems.join("\n")}`);
  // The committed entry, when there is one, must name the same files. The
  // same files packaged by another zlib build may differ in their bytes; the
  // entry then gets the new sha256, and that change must be committed.
  const committed = readEntry(runId, runs);
  if (committed && (committed.asset.listHash !== entry.asset.listHash || committed.privateListHash !== entry.privateListHash)) {
    throw new Error(`refused: the committed entry for ${runId} names other files (list hash ${committed.asset.listHash}, private ${committed.privateListHash}) than this folder packages (list hash ${entry.asset.listHash}, private ${entry.privateListHash})`);
  }
  const rebytes = committed !== null && committed.asset.sha256 !== entry.asset.sha256;
  // An accepted run stays accepted: benchmark/index/accepted.json names it,
  // and only trend.mjs --accept sets the mark.
  if (committed?.accepted === true) Object.assign(entry, { accepted: true, acceptedAt: committed.acceptedAt, acceptedBy: committed.acceptedBy });
  if (!dryRun) upload(asset.tarPath, runId);
  const written = !dryRun || writeIndex ? writeEntry(entry, runs) : null;
  return { asset, entry, written, rebytes };
}

async function main() {
  const args = process.argv.slice(2);
  let dryRun = false;
  let writeIndex = false;
  let out = null;
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") dryRun = true;
    else if (args[i] === "--write-index") writeIndex = true;
    else if (args[i] === "--out") out = args[++i];
    else pos.push(args[i]);
  }
  if (pos.length !== 1 || out === undefined) {
    console.error("usage: node benchmark/publish-run.mjs <results folder> [--dry-run] [--write-index] [--out <dir>]");
    process.exit(2);
  }
  let r;
  try {
    r = await publishRun(pos[0], { dryRun, writeIndex, out });
  } catch (error) {
    console.error(error.message);
    process.exit(error.message.startsWith("refused") ? 1 : 2);
  }
  const { asset, entry, written, rebytes } = r;
  console.log(`${asset.runId}: ${asset.files} files in ${asset.tarPath} (${asset.bytes} bytes, sha256 ${asset.sha256}, list hash ${asset.listHash})`);
  if (rebytes) console.log(`The committed entry names the same files packaged to other bytes; ${written ? "the entry now names this asset's sha256, and the change must be committed" : "a publish rewrites its sha256"}.`);
  if (asset.left.length > 0) console.log(`Left out (not on the allowlist, or a non-permissive case's code): ${asset.left.length} files, such as ${asset.left.slice(0, 3).join(", ")}`);
  const l = asset.looked;
  console.log(`Inspected every packaged file for: ${l.secrets} generated secrets, this machine's and any platform's home folder paths, ${l.modelValues} model settings values, ${l.patterns} public and ${l.privatePatterns} private scrub patterns, and the head and base code of ${l.codeCases} non-permissive cases. No hit.`);
  console.log(dryRun ? `Dry run: nothing uploaded. The asset unpacks to the same file list.` : `Uploaded to ${entry.asset.url}`);
  if (written) {
    console.log(`Index entry written: ${written}`);
    console.log(`Commit it in a pull request: git add benchmark/index/runs/${asset.runId}.json`);
  } else console.log(JSON.stringify(entry, null, 2));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
