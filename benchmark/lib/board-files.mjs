// What an outside board's converter and wrapper need about files and
// processes: the one folder of a run a board step writes in, the bench
// cache their pinned checkouts live in, the state of such a checkout, and
// the filter that keeps the judge's key and base URL out of everything
// printed or saved. AACR and Martian share these checks and filters.
// AACR's boardFolder fixes the board name to aacr; its converter re-exports
// benchCache, and its judge re-exports checkoutState and redactor. The
// command started with core files off is aacr-judge.mjs withoutCore,
// which the Martian judge imports from there.
//
// Failure list, written before the code:
// 1. Board files leave the run through a symbolic link: boardFolder(run,
//    board) gives <run>/outside/<board> by its real path, and refuses a
//    path whose real location is not inside the run's real folder, or that
//    passes through a link that leads nowhere.
// 2. The bench cache lies in the repository, so a board's checkout and its
//    venv land there: benchCache refuses a cache whose real path, or the
//    real path of the deepest folder of it that is there, is inside it, and
//    outsideRepo does the same for every folder a board uses under it (a
//    link under the cache can lead into the repository).
// 3. A modified evaluator runs while the record names the pinned commit:
//    checkoutState hashes every working file of the checkout and compares
//    it with the blob the commit's tree holds, so a file git was told to
//    assume unchanged, or an ignored file, cannot hide an edit; it names
//    every file that differs, is missing, or is not in the tree.
// 4. A secret reaches the terminal or a log in pieces: a redactor keeps one
//    buffer per stream and holds back what could still be the start of a
//    secret (up to its length less one) until the next chunk, so a key or
//    host split across two chunks is replaced whole; it replaces each
//    secret and its URL-encoded forms. leaksIn finds a secret in a saved
//    text also when a line break splits it.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { repoRoot } from "./cases.mjs";
import { cacheRoot } from "./licence.mjs";

// `path` by its real location: the deepest part of it that is there
// resolved (a link counts, even a broken one), the rest joined on. Null
// when that part is a link that leads nowhere.
export function realLocation(path) {
  let head = path;
  const rest = [];
  for (;;) {
    let there = true;
    try {
      lstatSync(head);
    } catch {
      there = false;
    }
    if (there || dirname(head) === head) break;
    rest.unshift(basename(head));
    head = dirname(head);
  }
  try {
    return join(realpathSync(head), ...rest);
  } catch {
    return null;
  }
}

/**
 * <run>/outside/<board> by its real path, the folder every step of that
 * board writes in; a thrown refusal when it, or a folder on the way to it,
 * is a link that leads out of the run or nowhere.
 */
export function boardFolder(folder, board) {
  const run = realpathSync(folder);
  const wanted = join(run, "outside", board);
  const real = realLocation(wanted);
  if (real === null) throw new Error(`${wanted} passes through a link that leads nowhere; the board's files are written only inside the run (${run})`);
  if (!real.startsWith(`${run}${sep}`)) throw new Error(`${wanted} leads outside the run, to ${real}; the board's files are written only inside the run's own folder`);
  return real;
}

/**
 * `path`, or a thrown refusal ("refused: ...") when its real location (see
 * realLocation) is this repository or inside it. `what` names it.
 */
export function outsideRepo(path, what) {
  const real = realLocation(resolve(path));
  if (real === null) throw new Error(`refused: ${what} ${path} passes through a link that leads nowhere`);
  const repo = realpathSync(repoRoot);
  if (real === repo || real.startsWith(`${repo}${sep}`)) throw new Error(`refused: ${what} ${path} is inside the repository (${real}); set OPENQODEX_BENCH_CACHE to a folder outside it, with no link under it that leads into it`);
  return path;
}

/** The bench cache (lib/licence.mjs cacheRoot), or a thrown refusal when it lies in this repository. */
export function benchCache(env = process.env) {
  return outsideRepo(resolve(cacheRoot(env)), "the bench cache");
}

// A blob id as git computes it, for the bytes given.
const blobId = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

/**
 * A checkout as it stands: its commit, its tree, and one problem for each
 * working file that is not the blob its commit's tree holds (by content,
 * kind and executable bit), each tree file that is missing, and each file
 * on disk the tree does not hold. Nothing is taken from git's index, so a
 * file marked assume-unchanged or skip-worktree, or an ignored one, is
 * still seen.
 */
export function checkoutState(dir) {
  const git = (...args) => spawnSync("git", ["-C", dir, "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8", maxBuffer: 1 << 28 });
  const commit = git("rev-parse", "HEAD").stdout.trim();
  const tree = git("rev-parse", "HEAD^{tree}").stdout.trim();
  const problems = [];
  const listed = git("ls-tree", "-r", "-z", "--full-tree", "HEAD");
  if (listed.status !== 0) return { commit, tree, problems: [`git ls-tree failed: ${listed.stderr.trim()}`] };
  const want = new Map();
  for (const entry of listed.stdout.split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const [mode, type, id] = entry.slice(0, tab).split(" ");
    want.set(entry.slice(tab + 1), { mode, type, id });
  }
  const changed = [];
  const missing = [];
  for (const [path, w] of want) {
    const full = join(dir, path);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      missing.push(path);
      continue;
    }
    if (w.type !== "blob") {
      changed.push(`${path} (a ${w.type} in the tree)`);
      continue;
    }
    const link = w.mode === "120000";
    if (link !== st.isSymbolicLink() || (!link && !st.isFile())) {
      changed.push(`${path} (another kind of file)`);
      continue;
    }
    const got = link ? blobId(Buffer.from(readlinkSync(full))) : blobId(readFileSync(full));
    if (got !== w.id) changed.push(path);
    else if (!link && (w.mode === "100755") !== ((st.mode & 0o111) !== 0)) changed.push(`${path} (its executable bit)`);
  }
  const extra = [];
  const walk = (rel) => {
    for (const d of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = rel === "" ? d.name : `${rel}/${d.name}`;
      if (rel === "" && d.name === ".git") continue;
      if (d.isDirectory()) walk(path);
      else if (!want.has(path)) extra.push(path);
    }
  };
  walk("");
  const name = (list, what) => {
    if (list.length > 0) problems.push(`${list.length} ${what}: ${list.slice(0, 5).join(", ")}${list.length > 5 ? ", ..." : ""}`);
  };
  name(changed, "files differ from the pinned tree");
  name(missing, "files of the pinned tree are missing");
  name(extra, "files are not in the pinned tree");
  return { commit, tree, problems };
}

/** Each secret with its URL-encoded forms, longest first. */
export function secretForms(secrets) {
  const out = new Set();
  for (const s of secrets) for (const f of [s, encodeURIComponent(s), encodeURI(s)]) if (f !== "") out.add(f);
  return [...out].sort((a, b) => b.length - a.length);
}

/**
 * A filter for one stream: write(chunk) and end() pass the text to `sink`
 * with every secret form replaced by "[hidden]". What could still be the
 * start of a secret (its length less one) is held until the next chunk or
 * the end; a whole line is passed as soon as it ends.
 */
export function redactor(secrets, sink) {
  const forms = secretForms(secrets);
  const hold = Math.max(0, ...forms.map((f) => f.length)) - 1;
  const decoder = new StringDecoder("utf8");
  let rest = "";
  // Passes the text before `cut`, a secret starting there replaced whole
  // (the longest one that starts at a place), and keeps what follows. Any
  // secret that starts before the cut is whole in `rest`: a secret holds no
  // line break, and the cut leaves at least its length less one behind.
  const flush = (final) => {
    const cut = final ? rest.length : Math.min(rest.length, Math.max(rest.lastIndexOf("\n") + 1, rest.length - hold));
    if (cut <= 0) return;
    let shown = "";
    let i = 0;
    while (i < cut) {
      const hit = forms.find((f) => rest.startsWith(f, i));
      if (hit) {
        shown += "[hidden]";
        i += hit.length;
      } else shown += rest[i++];
    }
    if (shown !== "") sink(shown);
    rest = rest.slice(i);
  };
  return {
    write(chunk) {
      rest += typeof chunk === "string" ? chunk : decoder.write(chunk);
      flush(false);
    },
    end() {
      rest += decoder.end();
      flush(true);
    },
  };
}

/** True when `text` holds a secret form, also with its line breaks taken out. */
export function leaksIn(text, secrets) {
  const forms = secretForms(secrets);
  const joined = text.replace(/[\r\n]/g, "");
  return forms.some((f) => text.includes(f) || joined.includes(f));
}
