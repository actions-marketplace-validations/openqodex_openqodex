// What `review <target>` reviews: a branch or a pull request, its head
// commit, its base and the merge base of the two. The head is fetched from
// its remote first unless --offline, so a stale remote-tracking ref is
// refreshed. A pull request's head is GitHub's `pull/<n>/head` ref, read with
// git's own credentials. `gh`, when it is installed and signed in, only names
// a pull request's base; without it the next source is used. No token is
// ever read here.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { OpenQodexError } from "@openqodex/core";
import type { BaseSource } from "@openqodex/core";

const execFileAsync = promisify(execFile);

const GH_TIMEOUT_MS = 20_000;
const FETCH_TIMEOUT_MS = 300_000;

export type Resolved = {
  spec: string;
  headSha: string;
  baseRef: string;
  baseSource: BaseSource;
  baseSha: string;
  mergeBase: string;
  // One plain line each, for stderr.
  notes: string[];
};

type Parsed = { kind: "branch"; name: string } | { kind: "pr"; number: number; owner: string | null; repo: string | null };

const PR_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/;

export function parseTarget(spec: string): Parsed {
  const hash = /^#(\d+)$/.exec(spec);
  if (hash) return { kind: "pr", number: Number(hash[1]), owner: null, repo: null };
  const url = PR_URL.exec(spec);
  if (url) return { kind: "pr", number: Number(url[3]), owner: url[1], repo: url[2] };
  if (/^[a-z]+:\/\//i.test(spec)) throw new OpenQodexError(`not a branch or a GitHub pull request link: ${spec}`);
  return { kind: "branch", name: spec };
}

// git with nothing from the repo's config run: no hooks, no prompt for a password.
async function git(repoRoot: string, args: string[], timeout = 60_000): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const { stdout } = await execFileAsync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: repoRoot,
      timeout,
      maxBuffer: 16 << 20,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { ok: true, out: stdout.trim(), err: "" };
  } catch (error) {
    const e = error as { stderr?: string; message: string };
    return { ok: false, out: "", err: (e.stderr ?? e.message).trim().split("\n")[0] ?? "" };
  }
}

async function commitOf(repoRoot: string, ref: string): Promise<string | null> {
  const r = await git(repoRoot, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
  return r.ok && r.out !== "" ? r.out : null;
}

async function remotes(repoRoot: string): Promise<string[]> {
  const r = await git(repoRoot, ["remote"]);
  return r.ok ? r.out.split("\n").filter((l) => l !== "") : [];
}

// origin, else the only remote.
async function defaultRemote(repoRoot: string): Promise<string> {
  const all = await remotes(repoRoot);
  if (all.includes("origin")) return "origin";
  if (all.length === 1) return all[0];
  throw new OpenQodexError(all.length === 0 ? "this repository has no remote to fetch from" : "this repository has several remotes and none is origin; name the branch as <remote>/<branch>");
}

// "owner/repo" of a GitHub remote URL, lower case, or null.
function githubSlug(url: string): string | null {
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

async function remoteFor(repoRoot: string, owner: string, repo: string): Promise<string> {
  for (const name of await remotes(repoRoot)) {
    const url = await git(repoRoot, ["remote", "get-url", name]);
    if (url.ok && githubSlug(url.out) === `${owner}/${repo.replace(/\.git$/, "")}`.toLowerCase()) return name;
  }
  throw new OpenQodexError(`the pull request is on ${owner}/${repo}, which is not a remote of this repository`);
}

async function fetch(repoRoot: string, remote: string, refspec: string, what: string): Promise<void> {
  const r = await git(repoRoot, ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", remote, refspec], FETCH_TIMEOUT_MS);
  if (!r.ok) throw new OpenQodexError(`could not fetch ${what} from ${remote}: ${r.err}`);
}

// Refreshes a remote-tracking branch from its remote. The name goes into a
// refspec, so it must be a valid branch name first: no colon, no wildcard.
async function refresh(repoRoot: string, remote: string, branch: string): Promise<void> {
  if (!(await git(repoRoot, ["check-ref-format", `refs/heads/${branch}`])).ok || branch.startsWith("-")) {
    throw new OpenQodexError(`not a valid branch name: ${branch}`);
  }
  await fetch(repoRoot, remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`, branch);
}

// <remote>/<branch> when `name` starts with a remote's name.
async function splitRemote(repoRoot: string, name: string): Promise<{ remote: string; branch: string } | null> {
  for (const remote of await remotes(repoRoot)) {
    if (name.startsWith(`${remote}/`) && name.length > remote.length + 1) return { remote, branch: name.slice(remote.length + 1) };
  }
  return null;
}

// The base branch `gh` names: for a pull request, its base; for a branch, the
// base of its one open pull request. Null when gh is missing, not signed in,
// fails, or finds no single answer.
async function ghBase(repoRoot: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("gh", args, {
      cwd: repoRoot,
      timeout: GH_TIMEOUT_MS,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
    });
    const names = stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    return names.length === 1 ? names[0] : null;
  } catch {
    return null;
  }
}

type Head = { sha: string; remote: string | null; branch: string | null; prNumber: number | null };

async function resolveHead(repoRoot: string, spec: string, parsed: Parsed, offline: boolean): Promise<Head> {
  const missing = (what: string) =>
    new OpenQodexError(`${what} is not available locally and --offline forbids fetching it; run without --offline, or fetch it first`);
  if (parsed.kind === "pr") {
    const remote = parsed.owner && parsed.repo ? await remoteFor(repoRoot, parsed.owner, parsed.repo) : await defaultRemote(repoRoot);
    if (offline) {
      // Only what a fetch configured for pull requests left here.
      for (const ref of [`refs/remotes/${remote}/pr/${parsed.number}`, `refs/pull/${parsed.number}/head`]) {
        const sha = await commitOf(repoRoot, ref);
        if (sha !== null) return { sha, remote, branch: null, prNumber: parsed.number };
      }
      throw missing(`pull request ${parsed.number}`);
    }
    await fetch(repoRoot, remote, `refs/pull/${parsed.number}/head`, `pull request ${parsed.number}`);
    const sha = await commitOf(repoRoot, "FETCH_HEAD");
    if (sha === null) throw new OpenQodexError(`the fetch of pull request ${parsed.number} returned no commit`);
    return { sha, remote, branch: null, prNumber: parsed.number };
  }

  const name = parsed.name;
  const split = await splitRemote(repoRoot, name);
  if (split === null) {
    // A local branch is the developer's own: read as it is, never fetched.
    const local = await commitOf(repoRoot, `refs/heads/${name}`);
    if (local !== null) return { sha: local, remote: null, branch: name, prNumber: null };
  }
  const remote = split?.remote ?? (await defaultRemote(repoRoot));
  const branch = split?.branch ?? name;
  if (!offline) await refresh(repoRoot, remote, branch);
  const sha = await commitOf(repoRoot, `refs/remotes/${remote}/${branch}`);
  if (sha === null) throw offline ? missing(spec) : new OpenQodexError(`no branch ${branch} on ${remote}`);
  return { sha, remote, branch, prNumber: null };
}

export async function resolveTarget(args: {
  repoRoot: string;
  spec: string;
  offline: boolean;
  base: string | undefined; // --base
  defaultBase: string | null; // review.default_base
}): Promise<Resolved> {
  const { repoRoot, spec, offline } = args;
  const parsed = parseTarget(spec);
  const head = await resolveHead(repoRoot, spec, parsed, offline);
  const notes: string[] = [];

  // A remote-tracking base is refreshed too, so commits that are already on
  // the base are never shown as part of the target.
  const at = async (ref: string): Promise<string | null> => {
    const split = await splitRemote(repoRoot, ref);
    if (!offline && split !== null && (await commitOf(repoRoot, `refs/remotes/${ref}`)) !== null) await refresh(repoRoot, split.remote, split.branch);
    return commitOf(repoRoot, ref);
  };

  let base: { ref: string; source: BaseSource; sha: string } | null = null;
  if (args.base !== undefined) {
    const sha = await at(args.base);
    if (sha === null) throw new OpenQodexError(`base not found: ${args.base}`);
    base = { ref: args.base, source: "--base", sha };
  }

  if (base === null) {
    let name: string | null = null;
    if (!offline) {
      if (parsed.kind === "pr") name = await ghBase(repoRoot, ["pr", "view", parsed.owner ? spec : String(parsed.number), "--json", "baseRefName", "--jq", ".baseRefName"]);
      else if (head.branch !== null) name = await ghBase(repoRoot, ["pr", "list", "--head", head.branch, "--state", "open", "--json", "baseRefName", "--jq", ".[].baseRefName"]);
    }
    if (name !== null) {
      const remote = head.remote ?? (await defaultRemote(repoRoot));
      await refresh(repoRoot, remote, name);
      const ref = `${remote}/${name}`;
      const sha = await commitOf(repoRoot, ref);
      if (sha !== null) base = { ref, source: "the pull request", sha };
    } else if (parsed.kind === "pr") {
      notes.push(
        offline
          ? "--offline: the pull request's base is not known without gh, so the next base source is used"
          : "gh is not installed or not signed in here, so the pull request's base is not known; the next base source is used",
      );
    }
  }

  if (base === null && args.defaultBase !== null) {
    for (const ref of [args.defaultBase, `origin/${args.defaultBase}`]) {
      const sha = await at(ref);
      if (sha !== null) {
        base = { ref, source: "review.default_base", sha };
        break;
      }
    }
    if (base === null) throw new OpenQodexError(`review.default_base: ${args.defaultBase} is not a ref here or a branch on origin; fetch it or change the config`);
  }

  if (base === null) {
    const remote = head.remote ?? (await defaultRemote(repoRoot));
    // Set by clone; read here without the network.
    const symbolic = await git(repoRoot, ["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`]);
    if (symbolic.ok && symbolic.out !== "") {
      const ref = symbolic.out.replace(/^refs\/remotes\//, "");
      const sha = await at(ref);
      if (sha !== null) base = { ref, source: "the remote's default branch", sha };
    }
  }
  if (base === null) throw new OpenQodexError(`no base found for ${spec}: pass --base <ref>`);

  const mb = await git(repoRoot, ["merge-base", base.sha, head.sha]);
  if (!mb.ok || mb.out === "") throw new OpenQodexError(`${spec} shares no history with its base ${base.ref}; pass --base <ref>`);
  return { spec, headSha: head.sha, baseRef: base.ref, baseSource: base.source, baseSha: base.sha, mergeBase: mb.out, notes };
}
