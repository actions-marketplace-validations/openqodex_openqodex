// The feedback offer. When OpenQodex fails, a scanner breaks, or the developer
// runs `openqodex report`, it prints the exact GitHub issue it would create
// and two choices: 1 create the issue, 2 ignore. Nothing is ever sent without
// choice 1. The issue body never holds code, file names, paths, repo names,
// config or secrets: only the command's flags, a scrubbed error line, the
// scanner statuses and the platform.
import { execFile } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { STATE_DIR, findRepoRoot } from "@openqodex/core";
import type { ScanResult, ScannerRunSummary } from "@openqodex/core";
import { writeAtomic } from "./agents/files.js";
import { openqodexHomeDir } from "./launcher.js";

const execFileAsync = promisify(execFile);

export const ISSUE_REPO = "openqodex/openqodex";
export const SEND_LAST = "openqodex report --send-last";
const LAST_REPORT = "last-report.json";
const DIAGNOSTIC_MAX = 300;

export type Problem = {
  // A short stable word for the failure class, so issues group.
  code: "internal-error" | "scanner-failed" | "developer-report";
  component: string;
  diagnostic: string;
};

export type Issue = { title: string; body: string };

// What this run learned, kept for the one offer at its end.
const run: {
  pending: Problem | null;
  scanners: ScannerRunSummary[] | null;
  repoRoot: string | null;
  files: string[];
} = { pending: null, scanners: null, repoRoot: null, files: [] };

// Called by the scan pipeline once the scanners have run. A scanner that
// ended `failed` queues the offer; every other status is not a problem.
export function noteScan(repoRoot: string, scan: ScanResult, changedPaths: string[]): void {
  run.repoRoot = repoRoot;
  run.scanners = scan.scanners;
  run.files.push(...changedPaths.map((p) => basename(p)));
  const failed = scan.scanners.filter((s) => s.status === "failed");
  if (failed.length === 0 || run.pending !== null) return;
  run.pending = {
    code: "scanner-failed",
    component: failed.map((s) => `scanner:${s.scanner}`).join(", "),
    diagnostic: failed.map((s) => `${s.scanner}: ${firstLine(s.reason ?? "failed")}`).join("; "),
  };
}

// The CLI's own failure replaces a queued scanner failure: one offer per run.
export function noteInternalError(command: string, args: string[], message: string): void {
  const component = command === "review" && args.includes("--finalize") ? "finalize" : "cli";
  run.pending = { code: "internal-error", component, diagnostic: firstLine(message) };
}

export function takePending(): Problem | null {
  const p = run.pending;
  run.pending = null;
  return p;
}

function firstLine(text: string): string {
  return (text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "").trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The names that identify this user or this repo.
function privateNames(): string[] {
  const names = new Set<string>();
  for (const key of ["USER", "USERNAME", "LOGNAME"]) {
    const value = process.env[key];
    if (value) names.add(value);
  }
  try {
    names.add(userInfo().username);
  } catch {
    // no user entry for this uid
  }
  names.add(basename(homedir()));
  if (run.repoRoot !== null) names.add(basename(run.repoRoot));
  return longestFirst(names);
}

// A name of one or two letters would eat ordinary words; a path holding it is
// removed whole anyway.
function longestFirst(names: Iterable<string>): string[] {
  return [...new Set(names)].filter((n) => n.length >= 3).sort((a, b) => b.length - a.length);
}

function replaceWord(text: string, word: string, by: string): string {
  return text.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(word)}(?![A-Za-z0-9])`, "gi"), by);
}

// Removes from a line of text everything that could point at the developer:
// anything shaped like a path (slash or backslash separated, or starting with
// ~), anything shaped like a key or token, the names of the changed files,
// and the user, home and repo names.
export function scrub(text: string): string {
  let out = text.replace(/\s+/g, " ").trim();
  out = out.replace(/[^\s'"`()[\]{}<>,;]+/g, (token) => {
    const trail = /[:.!?]+$/.exec(token)?.[0] ?? "";
    const core = token.slice(0, token.length - trail.length);
    if (core === "") return token;
    if (/[\\/]/.test(core) || core.startsWith("~")) return `<path>${trail}`;
    if (/^[A-Za-z0-9_+=.-]{16,}$/.test(core) && /[A-Za-z]/.test(core) && /\d/.test(core)) return `<secret>${trail}`;
    return token;
  });
  for (const file of longestFirst(run.files)) out = replaceWord(out, file, "<file>");
  for (const name of privateNames()) out = replaceWord(out, name, "<name>");
  return out.length > DIAGNOSTIC_MAX ? `${out.slice(0, DIAGNOSTIC_MAX)}...` : out;
}

// The command with its flags; a value is kept only after scrubbing, so a
// path given to --cwd, --output or --finalize never reaches the issue.
function commandLine(command: string, args: string[]): string {
  if (command === "report") return "report";
  const parts = args.map((arg) => {
    if (!arg.startsWith("-")) return scrub(arg);
    const eq = arg.indexOf("=");
    return eq === -1 ? arg : `${arg.slice(0, eq)}=${scrub(arg.slice(eq + 1))}`;
  });
  return [command, ...parts].join(" ");
}

function osName(): string {
  const names: Record<string, string> = { darwin: "macOS", linux: "Linux", win32: "Windows" };
  return names[process.platform] ?? process.platform;
}

export function composeIssue(problem: Problem, command: string, args: string[]): Issue {
  const scanners =
    run.scanners === null || run.scanners.length === 0
      ? "none ran"
      : run.scanners.map((s) => `${s.scanner} ${s.status}`).join(", ");
  const body = [
    `Command: ${commandLine(command, args)}`,
    `Component: ${problem.component}`,
    `Diagnostic: ${scrub(problem.diagnostic)}`,
    `Scanners: ${scanners}`,
    `Environment: ${osName()}, ${process.arch}, Node ${process.versions.node.split(".")[0]}`,
  ].join("\n");
  return { title: `OpenQodex ${__OPENQODEX_VERSION__}: ${problem.code}`, body };
}

export function issueText(issue: Issue): string {
  return [
    "OpenQodex had a problem. Nothing has been sent.",
    `Issue title: ${issue.title}`,
    "Issue body:",
    issue.body,
    "1 create a GitHub issue",
    "2 ignore",
    "",
  ].join("\n");
}

// .openqodex/last-report.json in the repo (ignored by the folder's own
// .gitignore), or last-report.json in the OpenQodex home outside a repo.
async function lastReportPath(cwd: string): Promise<string> {
  if (run.repoRoot === null) {
    try {
      run.repoRoot = await findRepoRoot(cwd);
    } catch {
      return join(openqodexHomeDir(), LAST_REPORT);
    }
  }
  return join(run.repoRoot, STATE_DIR, LAST_REPORT);
}

function saveLast(path: string, issue: Issue): void {
  const dir = join(path, "..");
  if (lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) return;
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) return;
  mkdirSync(dir, { recursive: true });
  // A state folder made here ignores itself, as every run's folder does.
  if (basename(dir) === STATE_DIR) {
    try {
      writeFileSync(join(dir, ".gitignore"), "*\n", { flag: "wx" });
    } catch {
      // already there
    }
  }
  writeAtomic(path, `${JSON.stringify({ version: 1, ...issue }, null, 2)}\n`);
}

export async function readLast(cwd: string): Promise<Issue | null> {
  try {
    const value = JSON.parse(readFileSync(await lastReportPath(cwd), "utf8")) as Partial<Issue>;
    return typeof value.title === "string" && typeof value.body === "string" ? { title: value.title, body: value.body } : null;
  } catch {
    return null;
  }
}

// One key from the terminal. Anything but 1, Enter, Ctrl-C and end of input
// all mean 2.
function readKey(): Promise<string> {
  const stdin = process.stdin;
  return new Promise((done) => {
    const finish = (key: string): void => {
      stdin.removeAllListeners("data");
      stdin.removeAllListeners("end");
      stdin.setRawMode(false);
      stdin.pause();
      done(key);
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.once("data", (chunk: Buffer) => finish(chunk.toString("utf8")));
    stdin.once("end", () => finish(""));
  });
}

// Choice 1. With a signed-in GitHub CLI the issue is created as shown;
// otherwise the new-issue page opens with the same title and body filled in.
// Never signs in.
export async function sendIssue(issue: Issue): Promise<string> {
  try {
    await execFileAsync("gh", ["auth", "status"], { timeout: 15_000 });
    const { stdout } = await execFileAsync(
      "gh",
      ["issue", "create", "--repo", ISSUE_REPO, "--title", issue.title, "--body", issue.body],
      { timeout: 60_000 },
    );
    return `Created ${stdout.trim()}`;
  } catch {
    // no gh, not signed in, or the create failed: the browser page instead
  }
  const url = `https://github.com/${ISSUE_REPO}/issues/new?title=${encodeURIComponent(issue.title)}&body=${encodeURIComponent(issue.body)}`;
  const opener = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : null;
  if (opener !== null) {
    try {
      await execFileAsync(opener, [url], { timeout: 15_000 });
      return `Opened the new issue page in your browser: ${url}`;
    } catch {
      // no browser here
    }
  }
  return `Open this page to create the issue: ${url}`;
}

// Prints the issue and the two choices. On a terminal it reads one key; else
// it says how to send it later, so an agent can ask the developer.
export async function offer(problem: Problem, command: string, args: string[], cwd: string): Promise<void> {
  // Found first, so the repo's name is scrubbed from the issue too.
  const lastPath = await lastReportPath(cwd);
  const issue = composeIssue(problem, command, args);
  process.stderr.write(issueText(issue));
  try {
    saveLast(lastPath, issue);
  } catch {
    // the offer still stands on a terminal; --send-last will say none is kept
  }
  if (process.stdin.isTTY && process.stderr.isTTY) {
    process.stderr.write("Choose 1 or 2: ");
    const key = await readKey();
    process.stderr.write("\n");
    if (key === "1") process.stderr.write(`${await sendIssue(issue)}\n`);
    return;
  }
  process.stderr.write(`To create the issue, run: ${SEND_LAST}\nTo ignore it, do nothing\n`);
}
