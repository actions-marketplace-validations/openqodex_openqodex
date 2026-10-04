// Temporary detached checkouts of one commit, each in its own folder under
// the OS temp folder: the push hook scans a pushed commit in one, and
// `review <target>` reads a branch or a pull request in one.
//
// A target checkout is made from someone else's code, so making it runs
// nothing: no hook, no clean, smudge or process filter (large file storage
// included), no submodule. It carries a marker file beside the tree, so a
// later review can tell an abandoned one of ours from anything else.
import { execFile, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { readRepoFile } from "@openqodex/core";

const execFileAsync = promisify(execFile);

export const PUSH_PREFIX = "openqodex-push-";
export const TARGET_PREFIX = "openqodex-target-";
export const CHECKOUT_MARKER = "openqodex-checkout.json";

// A checkout older than this with no finalize is abandoned.
const ABANDONED_MS = 24 * 3600_000;

export type Checkout = { folder: string; tree: string };
type Marker = { repo: string; sha: string; created: string };

async function gitOut(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 16 << 20, env: env ?? process.env });
    return stdout.trim();
  } catch {
    return null;
  }
}

// `-c` settings that switch off every program the repo's config names for a
// checkout: hooks, each configured filter driver, the file system monitor
// and submodule recursion.
async function runNothing(repoRoot: string): Promise<string[]> {
  const out = (await gitOut(repoRoot, ["config", "--get-regexp", "^filter\\."])) ?? "";
  const drivers = new Set<string>();
  for (const line of out.split("\n")) {
    const key = line.split(" ", 1)[0];
    const m = /^filter\.(.+)\.[^.]+$/.exec(key);
    if (m) drivers.add(m[1]);
  }
  const config = ["core.hooksPath=/dev/null", "core.fsmonitor=false", "submodule.recurse=false"];
  for (const d of drivers) {
    config.push(`filter.${d}.smudge=`, `filter.${d}.clean=`, `filter.${d}.process=`, `filter.${d}.required=false`);
  }
  return config.flatMap((c) => ["-c", c]);
}

// A detached work tree of `sha` in a new folder named with `prefix`. With
// `safe`, nothing from the repo's config runs, and the marker is written
// first, so even a checkout that dies half made is swept later. Null when
// git refuses; the folder is then gone.
export async function addCheckout(repoRoot: string, sha: string, prefix: string, safe = false): Promise<Checkout | null> {
  const folder = mkdtempSync(join(tmpdir(), prefix));
  const tree = join(folder, "tree");
  if (safe) {
    const marker: Marker = { repo: repoRoot, sha, created: new Date().toISOString() };
    writeFileSync(join(folder, CHECKOUT_MARKER), `${JSON.stringify(marker)}\n`, { flag: "wx" });
  }
  const pre = safe ? await runNothing(repoRoot) : [];
  const env = safe ? { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" } : undefined;
  if ((await gitOut(repoRoot, [...pre, "worktree", "add", "--detach", "--quiet", tree, sha], env)) === null) {
    await removeCheckout(repoRoot, folder);
    return null;
  }
  return { folder, tree };
}

export async function removeCheckout(repoRoot: string, folder: string): Promise<void> {
  await gitOut(repoRoot, ["worktree", "remove", "--force", join(folder, "tree")]);
  rmSync(folder, { recursive: true, force: true });
}

// The marker of a target checkout folder, or null when the folder is not one
// of ours: a real folder with our prefix holding a regular marker file.
function markerOf(folder: string): (Marker & { mtimeMs: number }) | null {
  try {
    if (!basename(folder).startsWith(TARGET_PREFIX)) return null;
    const dir = lstatSync(folder);
    const file = lstatSync(join(folder, CHECKOUT_MARKER));
    if (!dir.isDirectory() || !file.isFile()) return null;
    const value = JSON.parse(readFileSync(join(folder, CHECKOUT_MARKER), "utf8")) as Marker;
    return typeof value.repo === "string" ? { ...value, mtimeMs: file.mtimeMs } : null;
  } catch {
    return null;
  }
}

// Removes a target checkout only when its folder carries our marker for this
// repository, so a path read from a run folder can never name anything else.
export async function removeTargetCheckout(repoRoot: string, tree: string): Promise<void> {
  const folder = dirname(tree);
  const marker = markerOf(folder);
  if (marker !== null && marker.repo === repoRoot) await removeCheckout(repoRoot, folder);
}

// The developer's repository when `root` is the tree of a target checkout.
export function checkoutOwner(root: string): string | null {
  return markerOf(dirname(root))?.repo ?? null;
}

// Removes target checkouts whose marker is older than a day: a review that was
// never finalized. A younger one may belong to a review still in progress.
// Then git forgets the work trees that are gone.
export async function sweepCheckouts(repoRoot: string): Promise<void> {
  let names: string[];
  try {
    names = readdirSync(tmpdir()).filter((n) => n.startsWith(TARGET_PREFIX));
  } catch {
    return;
  }
  const repos = new Set<string>();
  for (const name of names) {
    const folder = join(tmpdir(), name);
    const marker = markerOf(folder);
    if (marker === null || Date.now() - marker.mtimeMs < ABANDONED_MS) continue;
    rmSync(folder, { recursive: true, force: true });
    repos.add(marker.repo);
  }
  if (repos.size === 0) return;
  repos.add(repoRoot);
  for (const repo of repos) if (existsSync(repo)) await gitOut(repo, ["worktree", "prune"]);
}

// How many of `paths` the checkout stores in Git LFS: their content was not
// fetched, so the files hold pointers.
export function lfsPaths(tree: string, paths: string[]): number {
  if (paths.length === 0) return 0;
  const r = spawnSync("git", ["check-attr", "-z", "--stdin", "filter"], { cwd: tree, input: `${paths.join("\0")}\0`, encoding: "utf8", maxBuffer: 16 << 20 });
  if (r.status !== 0) return 0;
  const parts = r.stdout.split("\0");
  let n = 0;
  for (let i = 0; i + 2 < parts.length; i += 3) if (parts[i + 2] === "lfs") n++;
  return n;
}

// The repo's settings files as they are in its work tree, never the ones the
// checked-out commit holds.
const STATE_SETTINGS = [".openqodex/config.yaml", ".openqodex/custom-instructions.md", ".openqodex/.gitignore"];

// Replaces the checked-out commit's own `.openqodex` folder (and, with
// `rootConfig`, its root config) with the work tree's settings. What the
// commit holds there never reaches the scan: links that point anywhere, or
// run state such as a receipt. rmSync removes a link itself and never follows
// one inside a folder it removes; the files are then created exclusively in
// a fresh real folder. A target review leaves the root config as the target
// has it: it is part of the code under review, and its config is read from
// the developer's repository instead.
export function placeSettings(repoRoot: string, tree: string, rootConfig: boolean): void {
  rmSync(join(tree, ".openqodex"), { recursive: true, force: true });
  if (rootConfig) rmSync(join(tree, ".openqodex.yaml"), { recursive: true, force: true });
  mkdirSync(join(tree, ".openqodex"));
  for (const rel of rootConfig ? [".openqodex.yaml", ...STATE_SETTINGS] : STATE_SETTINGS) {
    // From the work tree through the repo state reader: a link there stops the scan with one line.
    const text = readRepoFile(repoRoot, rel);
    if (text !== null) writeFileSync(join(tree, rel), text, { flag: "wx" });
  }
}
