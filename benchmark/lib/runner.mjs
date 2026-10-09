// The parts of the runner that decide what a run holds, kept apart from the
// script that starts reviews so each is tested without a reviewer.
//
// Failure list, written before the code:
// 1. A retry writes over the first attempt's report and receipt, so the
//    failure that caused it is lost: every attempt has its own folder.
// 2. A review that timed out or failed leaves no row, so the run looks better
//    than it was: every attempt, a failed or stopped one included, is saved
//    as a sample before anything halts, and is scored.
// 3. A product result (an unread range, a failed answer check) is retried as
//    if the reviewer broke: only a reviewer that failed, timed out or could
//    not start counts as a reviewer failure.
// 4. A resume mixes two runs: it is refused when the bundle, the machine,
//    any reviewer's version or model, web access, the timeout, the
//    concurrency, the cases, the configurations or the repeats differ.
// 5. A run names a commit its bundle was not built from: the build records
//    the commit and the tree it was built from, and the bundle's hash; a run
//    refuses a bundle whose hash differs.
// 6. "Dirty" reads the checkout as it is now, or only some folders: it means
//    the tree the bundle was built from differs from the commit's tree,
//    every file git sees counted, staged or not, untracked included.
// 7. The Codex model is guessed or taken from a variable Codex never reads:
//    it is read from the header Codex prints, or recorded as unknown.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REVIEWER_FAILED } from "./reviewers.mjs";

export function attemptDir(out, job, attempt) {
  const base = join(out, "samples", job.case, job.config);
  return attempt === 1 ? join(base, String(job.repeat)) : join(base, `${job.repeat}-attempt${attempt}`);
}

// Why a review did not end complete, in one line, whether the reviewer itself
// failed (`infra`), and whether no reviewer could start at all. Null when it
// completed.
export function failureOf(result, report) {
  const missing = report?.completion?.missing ?? [];
  const reviewerFailed = missing.find((m) => REVIEWER_FAILED.test(m));
  if (!report) {
    const last = String(result.stderr ?? "").trim().split("\n").slice(-6).join(" | ");
    const unavailable = /Full review unavailable|could not start a reviewer/.test(result.stderr ?? "");
    return { cause: unavailable ? `no reviewer could start: ${last}` : `no report.json (exit ${result.code ?? result.signal}): ${last}`, infra: true, unavailable };
  }
  if (reviewerFailed) return { cause: reviewerFailed, infra: true, unavailable: false };
  if (report.completion?.status !== "complete") return { cause: missing.join("; ") || "incomplete", infra: false, unavailable: false };
  return null;
}

// The saved record of one attempt, whatever happened to it.
export function sampleRecord({ job, attempt, result, report, who, startedAt, failure, stopped }) {
  return {
    case: job.case,
    config: job.config,
    reviewer: job.reviewer,
    graph: job.graph ? "on" : "off",
    repeat: job.repeat,
    attempt,
    started_at: startedAt,
    exit: result.code ?? null,
    signal: result.signal ?? null,
    wallMs: result.wallMs ?? null,
    status: report ? (report.completion?.status ?? "unknown") : "failed",
    failure: failure?.cause ?? null,
    // Set when the run halted while this attempt ran: why it halted.
    stopped: stopped ?? null,
    verdict: report?.verdict ?? null,
    reviewerUsed: who ?? null,
    findings: report ? report.findings.length + (report.outside_change?.length ?? 0) : null,
    usage: report?.completion?.reviewer?.usage ?? null,
    reviewerMs: report?.completion?.reviewer?.duration_ms ?? null,
    rounds: report?.completion?.reviewer?.rounds ?? null,
    graphStatus: report?.impact?.status ?? null,
    graphMs: report?.impact?.build?.durationMs ?? null,
    scanners: (report?.scanners ?? []).map((s) => ({ scanner: s.scanner, status: s.status, version: s.version, kept: s.keptCount, ms: s.durationMs })),
  };
}

// Every setting of `now` that differs from the run being resumed.
export function resumeProblems(earlier, now) {
  const out = [];
  const same = (label, a, b) => {
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) out.push(`${label}: ${JSON.stringify(a ?? null)} then, now ${JSON.stringify(b ?? null)}`);
  };
  same("CLI bundle", earlier.build?.bundleHash ?? earlier.build?.bundleSha256, now.build?.bundleHash);
  same("machine", earlier.machine, now.machine);
  const names = [...new Set([...Object.keys(earlier.reviewers ?? {}), ...Object.keys(now.reviewers ?? {})])].sort();
  for (const n of names) {
    same(`${n} reviewer version`, earlier.reviewers?.[n]?.version, now.reviewers?.[n]?.version);
    same(`${n} model`, earlier.reviewers?.[n]?.model, now.reviewers?.[n]?.model);
  }
  same("reviewer web access", earlier.review?.web, now.review?.web);
  same("review timeout in seconds", earlier.review?.timeoutSeconds, now.review?.timeoutSeconds);
  same("concurrency", earlier.concurrency, now.concurrency);
  if (earlier.cases !== undefined || now.cases !== undefined) same("cases", earlier.cases, now.cases);
  if (earlier.configs !== undefined || now.configs !== undefined) same("configurations", earlier.configs, now.configs);
  if (earlier.repeat !== undefined || now.repeat !== undefined) same("repeats", earlier.repeat, now.repeat);
  for (const c of Object.keys(now.caseHashes ?? {})) {
    if (earlier.caseHashes?.[c] !== now.caseHashes[c]) out.push(`case ${c}: its files or spec differ from the run's (or the run recorded no hash)`);
  }
  return out;
}

function gitOut(dir, args, env) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// The commit, the tree the work tree holds now (every file git sees, staged
// or not, untracked included, through a temporary index so the real one is
// not touched), the commit's own tree, and whether the two differ.
export function treeState(dir) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_") && v !== undefined) env[k] = v;
  const temp = mkdtempSync(join(tmpdir(), "oq-bench-tree-"));
  const withIndex = { ...env, GIT_INDEX_FILE: join(temp, "index") };
  let tree;
  try {
    gitOut(dir, ["read-tree", "HEAD"], withIndex);
    gitOut(dir, ["add", "-A"], withIndex);
    tree = gitOut(dir, ["write-tree"], withIndex);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  const commit = gitOut(dir, ["rev-parse", "HEAD"], env);
  const commitTree = gitOut(dir, ["rev-parse", "HEAD^{tree}"], env);
  return { commit, tree, commitTree, dirty: tree !== commitTree };
}

// One hash over everything the installed CLI runs from: the bundle and the
// assets copied beside it.
export const BUNDLE_PARTS = ["dist", "lenses", "wasm", "locks", "demo", "docs", "skills", "toolchain.json"];
export function bundleHash(cliDir) {
  const h = createHash("sha256");
  const add = (rel) => {
    const full = join(cliDir, rel);
    if (!existsSync(full)) return;
    for (const e of readdirSync(full, { withFileTypes: true, recursive: true }).filter((x) => x.isFile()).map((x) => join(x.parentPath, x.name)).sort()) {
      h.update(`\0${e.slice(cliDir.length)}\0`);
      h.update(readFileSync(e));
    }
  };
  for (const part of BUNDLE_PARTS) {
    const full = join(cliDir, part);
    if (part.endsWith(".json")) {
      if (existsSync(full)) {
        h.update(`\0/${part}\0`);
        h.update(readFileSync(full));
      }
    } else add(part);
  }
  return h.digest("hex");
}

// Why a run cannot trust the bundle it would start, if anything.
export function provenanceProblems(provenance, bundleNow) {
  if (!provenance) return ["no record of how the CLI was built; run node benchmark/build-cli.mjs, which builds it and records the commit and tree it was built from"];
  if (provenance.bundleHash !== bundleNow) return ["the CLI bundle is not the one benchmark/build-cli.mjs built (it was rebuilt or edited since); run node benchmark/build-cli.mjs again"];
  return [];
}

// Defined beside the Codex probe; here because the runner records it.
export { codexModelFrom } from "./reviewers.mjs";
