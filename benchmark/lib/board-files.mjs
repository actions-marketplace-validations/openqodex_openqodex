// What every outside board's converter and wrapper share about files and
// processes: the one folder of a run a board step writes in, the bench
// cache their pinned checkouts live in, the state of such a checkout, and a
// command started with core files off. The AACR-Bench board (PR 155) holds
// the same rules in its own files; once both have landed, it can read them
// from here.
//
// Failure list, written before the code:
// 1. Board files leave the run through a symbolic link: boardFolder(run,
//    board) gives <run>/outside/<board> by its real path, and refuses a
//    path whose real location is not inside the run's real folder, or that
//    passes through a link that leads nowhere.
// 2. The bench cache lies in the repository, so a board's checkout and its
//    venv land there: benchCache refuses a cache whose real path, or the
//    real path of the deepest folder of it that is there, is inside it.
// 3. A modified evaluator runs while the record names the pinned commit:
//    checkoutState gives a checkout's commit and tree and names everything
//    git sees as changed (an edit, a staged change, an untracked file).
// 4. A crash of a board's evaluator, whose environment holds the judge's key
//    and base URL, writes a core file: withoutCore starts a command through
//    a shell that sets the core file limit to zero and then becomes it
//    (Node cannot set a resource limit itself).
import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { repoRoot } from "./cases.mjs";
import { cacheRoot } from "./licence.mjs";

// `path` by its real location: the deepest part of it that is there
// resolved (a link counts, even a broken one), the rest joined on. Null
// when that part is a link that leads nowhere.
function realLocation(path) {
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
 * The bench cache (lib/licence.mjs cacheRoot), or a thrown refusal
 * ("refused: ...") when its real path lies in this repository.
 */
export function benchCache(env = process.env) {
  const cache = resolve(cacheRoot(env));
  const real = realLocation(cache);
  if (real === null) throw new Error(`refused: the bench cache ${cache} passes through a link that leads nowhere`);
  const repo = realpathSync(repoRoot);
  if (real === repo || real.startsWith(`${repo}${sep}`)) throw new Error(`refused: the bench cache ${cache} is inside the repository (${real}); set OPENQODEX_BENCH_CACHE to a folder outside it`);
  return cache;
}

/**
 * A checkout as it stands: its commit, its tree, and what git sees as
 * changed (an edit, a staged change, an untracked file), one problem each.
 */
export function checkoutState(dir) {
  const git = (...args) => spawnSync("git", ["-C", dir, "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" });
  const problems = [];
  const status = git("status", "--porcelain=v1", "--untracked-files=all");
  if (status.status !== 0) problems.push(`git status failed: ${status.stderr.trim()}`);
  const changed = status.stdout.split("\n").filter((l) => l !== "").map((l) => l.slice(3));
  if (changed.length > 0) problems.push(`git sees ${changed.length} changed or untracked file${changed.length === 1 ? "" : "s"}: ${changed.slice(0, 5).join(", ")}${changed.length > 5 ? ", ..." : ""}`);
  if (git("diff", "--quiet", "HEAD").status !== 0) problems.push("its files differ from its commit (git diff HEAD)");
  return { commit: git("rev-parse", "HEAD").stdout.trim(), tree: git("rev-parse", "HEAD^{tree}").stdout.trim(), problems };
}

/** A command run with core files off: a shell sets the limit to zero, then becomes the command. */
export const withoutCore = (command, args) => ["/bin/sh", ["-c", 'ulimit -c 0 && exec "$0" "$@"', command, ...args]];
