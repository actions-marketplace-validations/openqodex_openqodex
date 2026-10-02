// The git change source: what the developer changed, relative to a base,
// including untracked files, without writing anything inside `.git`.
//
// Untracked files are staged into a copy of the index that lives in a temp
// folder, with new blobs written to a temp object folder that borrows the
// repo's own objects as an alternate. Every diff is then taken from that one
// temp index with `--cached`, so the user's index, objects and hooks are never
// touched and the whole thing works with `.git` read-only.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parseDiffCoverage } from "./diff.js";
import { matchesGlob } from "./glob.js";
import { STATE_DIR } from "./report-files.js";
import type { Change, ChangedFile, ChangeScope } from "./types.js";
import { OpenQodexError } from "./types.js";

// Text handed to the brief is capped; files past the cap are left out whole.
export const DIFF_CAP_BYTES = 5 * 1024 * 1024;

// Our own run state never counts as part of a change.
const STATE_PATHSPEC = `:(top,exclude)${STATE_DIR}`;

// Settings that would make git write inside `.git`, run user code, or change
// the shape of its output, switched off for every call.
const GIT_CONFIG = [
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  "core.splitIndex=false",
  "gc.auto=0",
  "maintenance.auto=false",
];

const DIFF_FLAGS = [
  "--cached",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--no-relative",
  "--find-renames",
];

type GitResult = { code: number; stdout: Buffer; stderr: string };

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<GitResult> {
  const argv: string[] = [];
  for (const c of GIT_CONFIG) argv.push("-c", c);
  argv.push(...args);
  return new Promise((done, fail) => {
    const child = spawn("git", argv, {
      cwd,
      env: { ...env, GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", (e) => fail(new OpenQodexError(`could not run git: ${e.message}`)));
    child.on("close", (code) =>
      done({ code: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") }),
    );
  });
}

async function gitOk(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<Buffer> {
  const r = await git(cwd, args, env);
  if (r.code !== 0) {
    throw new OpenQodexError(`git ${args[0]} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  }
  return r.stdout;
}

async function gitLine(cwd: string, args: string[]): Promise<string | null> {
  const r = await git(cwd, args);
  if (r.code !== 0) return null;
  const line = r.stdout.toString("utf8").trim();
  return line === "" ? null : line;
}

export async function findRepoRoot(cwd: string): Promise<string> {
  const root = await gitLine(cwd, ["rev-parse", "--show-toplevel"]);
  if (root === null) throw new OpenQodexError("not a git repository");
  return root;
}

type Base = { ref: string; sha: string };

async function mergeBaseWithHead(repoRoot: string, ref: string): Promise<string | null> {
  return gitLine(repoRoot, ["merge-base", "HEAD", ref]);
}

async function resolveBase(repoRoot: string, scope: ChangeScope): Promise<Base> {
  const head = await gitLine(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);

  if (scope.base !== undefined) {
    const sha = await gitLine(repoRoot, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${scope.base}^{commit}`]);
    if (sha === null) throw new OpenQodexError(`base not found: ${scope.base}`);
    // The change is what this branch did since it left the base, so commits
    // that landed on the base afterwards are not shown as reverted.
    const mb = head === null ? null : await mergeBaseWithHead(repoRoot, sha);
    return { ref: scope.base, sha: mb ?? sha };
  }

  if (head === null) {
    // No commits yet: everything in the working tree is the change.
    const empty = await gitOk(repoRoot, ["hash-object", "-t", "tree", "--stdin"]);
    return { ref: "empty tree", sha: empty.toString("utf8").trim() };
  }
  if (scope.uncommitted) return { ref: "HEAD", sha: head };

  const upstream = await gitLine(repoRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  if (upstream !== null) {
    const mb = await mergeBaseWithHead(repoRoot, upstream);
    if (mb !== null) return { ref: upstream, sha: mb };
  }

  const remoteHead = await gitLine(repoRoot, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (remoteHead !== null) {
    const mb = await mergeBaseWithHead(repoRoot, remoteHead);
    if (mb !== null) return { ref: remoteHead.replace(/^refs\/remotes\//, ""), sha: mb };
  }

  return { ref: "HEAD", sha: head };
}

function splitNul(buf: Buffer): string[] {
  const parts = buf.toString("utf8").split("\0");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function parseNameStatus(buf: Buffer): Omit<ChangedFile, "binary">[] {
  const parts = splitNul(buf);
  const files: Omit<ChangedFile, "binary">[] = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++][0];
    if (code === "R" || code === "C") {
      const oldPath = parts[i++];
      const path = parts[i++];
      files.push(code === "R" ? { path, status: "renamed", oldPath } : { path, status: "added", oldPath: null });
    } else {
      const path = parts[i++];
      const status = code === "A" ? "added" : code === "D" ? "deleted" : "modified";
      files.push({ path, status, oldPath: null });
    }
  }
  return files;
}

type NumStat = { additions: number; deletions: number; binary: boolean };

// `--numstat -z`: "<add>\t<del>\t<path>\0", or for a rename
// "<add>\t<del>\t\0<old>\0<new>\0". A binary file shows "-" for both counts.
function parseNumstat(buf: Buffer): NumStat[] {
  const parts = splitNul(buf);
  const out: NumStat[] = [];
  for (let i = 0; i < parts.length; ) {
    const [add, del, path] = parts[i++].split("\t");
    if (path === "") i += 2;
    const binary = add === "-" && del === "-";
    out.push({ binary, additions: binary ? 0 : Number(add), deletions: binary ? 0 : Number(del) });
  }
  return out;
}

// One block per file pair, in the same order git lists the pairs.
function splitDiffBlocks(diff: string): string[] {
  if (diff === "") return [];
  return diff.split(/^(?=diff --git )/m);
}

function excluded(path: string, exclude: string[]): boolean {
  if (path === STATE_DIR || path.startsWith(`${STATE_DIR}/`)) return true;
  return exclude.some((g) => matchesGlob(path, g));
}

export async function getChange(args: {
  repoRoot: string;
  scope: ChangeScope;
  exclude: string[];
}): Promise<Change> {
  const { repoRoot, scope, exclude } = args;
  const base = await resolveBase(repoRoot, scope);

  const absGitPath = async (name: string): Promise<string> => {
    const p = (await gitOk(repoRoot, ["rev-parse", "--git-path", name])).toString("utf8").trim();
    return isAbsolute(p) ? p : resolve(repoRoot, p);
  };
  const indexPath = await absGitPath("index");
  const objectsPath = await absGitPath("objects");

  const tmp = await mkdtemp(join(tmpdir(), "openqodex-change-"));
  try {
    const tmpIndex = join(tmp, "index");
    const tmpObjects = join(tmp, "objects");
    await mkdir(tmpObjects);
    if (existsSync(indexPath)) await copyFile(indexPath, tmpIndex);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_INDEX_FILE: tmpIndex,
      GIT_OBJECT_DIRECTORY: tmpObjects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: objectsPath,
    };

    await gitOk(repoRoot, ["add", "-A", "--", ".", STATE_PATHSPEC], env);

    const diffArgs = (...extra: string[]): string[] => ["diff", ...DIFF_FLAGS, ...extra, base.sha, "--", STATE_PATHSPEC];
    const [nameStatus, numstat, raw, u0, u3] = await Promise.all([
      gitOk(repoRoot, diffArgs("--name-status", "-z"), env),
      gitOk(repoRoot, diffArgs("--numstat", "-z"), env),
      gitOk(repoRoot, diffArgs("--raw", "-z", "--no-abbrev"), env),
      gitOk(repoRoot, diffArgs("-U0", "--src-prefix=a/", "--dst-prefix=b/"), env),
      gitOk(repoRoot, diffArgs("-U3", "--src-prefix=a/", "--dst-prefix=b/"), env),
    ]);

    const id = createHash("sha256").update(`${base.sha}\n`).update(raw).digest("hex");

    const pairs = parseNameStatus(nameStatus);
    const stats = parseNumstat(numstat);
    const blocks = splitDiffBlocks(u3.toString("utf8"));
    if (stats.length !== pairs.length || blocks.length !== pairs.length) {
      throw new OpenQodexError(
        `git listed ${pairs.length} changed files but ${stats.length} counts and ${blocks.length} diff blocks`,
      );
    }

    const files: ChangedFile[] = [];
    const notReviewed: string[] = [];
    const diffParts: string[] = [];
    let diffBytes = 0;
    let additions = 0;
    let deletions = 0;
    for (let i = 0; i < pairs.length; i++) {
      if (excluded(pairs[i].path, exclude)) continue;
      files.push({ ...pairs[i], binary: stats[i].binary });
      additions += stats[i].additions;
      deletions += stats[i].deletions;
      const size = Buffer.byteLength(blocks[i], "utf8");
      if (diffBytes + size > DIFF_CAP_BYTES) {
        notReviewed.push(pairs[i].path);
        continue;
      }
      diffParts.push(blocks[i]);
      diffBytes += size;
    }

    const changedPaths = files.filter((f) => f.status !== "deleted").map((f) => f.path);
    const keep = new Set(changedPaths);
    const coverage = parseDiffCoverage(u0.toString("utf8"));
    for (const path of coverage.keys()) if (!keep.has(path)) coverage.delete(path);

    return {
      repoRoot,
      baseRef: base.ref,
      baseSha: base.sha,
      id,
      shortId: id.slice(0, 12),
      files,
      changedPaths,
      coverage,
      diff: diffParts.join(""),
      notReviewed,
      stats: { files: files.length, additions, deletions },
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
