#!/usr/bin/env node
// Runs the review benchmark: every case, every configuration, N times, with
// the real built CLI and the real reviewer. A script, never a model, decides
// what runs; the scores come later, from the saved files (score.mjs).
//
//   node benchmark/build-cli.mjs      build the CLI and record where it came from
//   node benchmark/run.mjs [--repeat 3] [--cases a,b] [--graph off,on]
//                          [--reviewers claude[,codex]] [--concurrency 1]
//                          [--timeout 900] [--out <folder>] [--resume]
//                          [--model <id>] [--web on|off] [--dry-run]
//                          [--draft] [--allow-retired]
//   node benchmark/run.mjs --mode scan [--cases a,b] [--repeat 1]
//                          [--check-identical] [--scanner-config <file>]
//                          [--allow-missing-scanners] [--timeout 120]
//                          [--out <folder>] [--dry-run] [--draft]
//
// Without --cases, every case the lock does not mark retired runs.
//
// --mode scan is the scanner-only run: per case, `openqodex scan
// --report-dir`, with no reviewer and no model, one case at a time, in the
// run's own OpenQodex home (its tool folders are links to the warm tools
// of $OPENQODEX_HOME or ~/.openqodex, so nothing installs during a pass and
// the developer's approvals are never read or written). The run refuses to
// start when a scanner is not ready, unless --allow-missing-scanners, and
// the manifest then lists each missing one. --scanner-config <file> passes
// --config <file> to every scan, after one `openqodex trust --yes` in the
// run's own home for the one repository path each case is built at in
// turn. At the end of a pass the manifest records `external` (the toolchain
// hash, the scanner versions, the Semgrep rule packs the scans consumed and
// a hash of the osv.dev advisories, lib/external.mjs) and the pass is scored
// (score.json, outcomes.jsonl, lib/scan-score.mjs). --check-identical runs
// a second pass on the same build into <out>-pass2, with fresh case
// repositories, and compares the two scores and every sample's files with
// the time fields left out (lib/identical.mjs); identical.json in both
// folders says how it went. Exit codes: 0 finished (and identical); 1
// stopped; 2 refused; 3 the two passes are not identical.
//
// One results folder per run, benchmark/results/<date>-<commit>/ unless
// --out names another:
//   manifest.json                     the build and where it came from, the machine, the
//                                     reviewers with their versions and models, the
//                                     settings, every planned job with its id (`jobs`),
//                                     how the first invocation ended
//   resumes.jsonl                     one line when a resume starts and one when it ends
//   cases/<case>.json                 the specs this run used (the scorer reads these)
//   samples/<case>/<config>/<n>/      one attempt at one review: report/ (the CLI's
//                                     --report-dir), receipt.txt (what it printed),
//                                     stderr.txt, sample.json; a second attempt of the
//                                     same review is <n>-attempt2/
//   rows.jsonl                        one line per attempt
//
// Failure list, written before the code:
// 1. A stale or edited build is benchmarked under a commit it was not built
//    from: benchmark/build-cli.mjs records the commit, the tree the build
//    read and a hash of the bundle; the run refuses a bundle with another
//    hash, and "dirty" means that tree differs from the commit's.
// 2. The reviewer quietly falls back to another agent: --reviewer is always
//    passed, and the reviewer each review used is read from its reviewer.json.
// 3. A usage limit, a rate limit or a login wall turns every later review
//    into a failure: the reviewer is probed before the run, and again after
//    any review whose reviewer failed; a probe that fails stops the run at
//    once with its exact text.
// 4. A failed, timed-out or stopped review leaves no row, or a retry writes
//    over it: every attempt has its own folder and is saved as a scored
//    sample before anything halts. A reviewer failure gets one more
//    attempt; the same failure twice stops the run, and what is done is kept.
// 5. Two reviews share a repository or a graph cache: each attempt gets its
//    own freshly built repository, and --report-dir keeps every file of the
//    run out of that repository.
// 6. The developer's own settings shape the review (a repo config, custom
//    instructions, the reviewer or web choice in the user config): the
//    review runs with --report-dir (built-in defaults, no instructions) and
//    with --reviewer and --reviewer-web given.
// 7. Configurations always run in the same order, so drift (load, time of
//    day) lands on one of them: within each repeat the cases run in order
//    and the configurations alternate which goes first.
// 8. A saved file holds the generated secret or this machine's paths: the
//    receipt's paths are replaced by placeholders, and every saved file is
//    checked for the generated value; one found stops the run.
// 9. An earlier run is overwritten or mixed with a new one: a folder that
//    holds a manifest or samples is refused unless --resume, and one run
//    folder has one runner at a time (lib/runner.mjs executeRun); a resume
//    keeps every saved attempt, the specs the run copied and its manifest
//    untouched, runs the reviews that have no saved attempt (one whose first
//    attempt started and never saved runs in its next attempt folder, and
//    the crashed one stays), and is refused when the bundle, the machine, a
//    reviewer's version or model, web access, the timeout, the concurrency,
//    the cases, the configurations or the repeats differ.
// 10. Wall time includes building the case: the clock runs from the start
//    of the CLI to its exit only.
// 11. The run spends more than asked: more than three repeats needs
//    --allow-more, and the plan is printed before anything starts.
// 12. A review outlives the script after Ctrl-C: running reviews are
//    stopped, saved as stopped attempts, and the run says why it stopped.
// 13. Parallel reviews slow each other, which reads as a slower build: the
//    manifest records the concurrency, and the default is one at a time.
// 14. A model is recorded that the reviewer never used: Claude Code's model
//    is read from its own answer and must equal a requested one; Codex's is
//    read from the header Codex prints, or recorded as unknown.
// 15. A requested model is passed in a way the reviewer ignores: --model
//    reaches Claude Code through ANTHROPIC_MODEL, which its driver passes
//    on; Codex runs with --ignore-user-config and takes no model setting, so
//    --model with Codex is refused.
// 16. A case edited after a run is run again under its old name, so the two
//    runs compare across different code: a case whose files do not hash to
//    its entry in benchmark/cases.lock.json, or that has none, is refused
//    unless --draft (the manifest then says draft, and a draft run is never
//    accepted); a retired case is refused unless --allow-retired; a lock
//    that is there but unsound is refused for every run, a draft included;
//    the manifest lists every case's id, planted/<name>@<first 8 hex of its
//    hash>.
// 17. A case edited while the run goes is rebuilt from the live folders for
//    later attempts, while the manifest keeps the first hash and id: at the
//    start the run copies every folder its cases build from (the demo's
//    examples/demo-repo included) into its temp folder, and every hash,
//    lock check, spec copy and attempt comes from that copy.
// Scanner-only runs (--mode scan):
// 18. Two scanner-only passes on one build differ and nobody notices:
//    --check-identical runs the second pass and compares (lib/identical.mjs);
//    a difference exits 3 and names each file and field, and whether the
//    inputs changed (other Semgrep rule packs, other osv.dev advisories) or
//    the product did.
// 19. A scanner that is not installed reads as a scanner that found
//    nothing: `openqodex doctor --json` in the run's own home lists every
//    scanner first, and one that is not ready refuses the run unless
//    --allow-missing-scanners, with which the manifest names each one and
//    says scannersComplete false; scans run with --no-install, so no pass
//    installs a tool the other did not have.
// 20. An overlay scanner runs without the trust step, or the run reads or
//    changes the developer's own approvals: --scanner-config runs `openqodex
//    trust --yes` once, in the run's own home, for the one repository path
//    every case is built at in turn (one scan at a time); a trust step that
//    fails refuses the run before any scan, and the manifest records what
//    was approved.
// 21. A scan's numbers move with inputs the build does not fix: the
//    manifest's `external` records the toolchain hash, the scanner versions,
//    the Semgrep rule packs each sample consumed ("mixed" when two differ)
//    and a hash of the osv.dev advisories, read from the saved scans, never
//    downloaded again (lib/external.mjs).
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { cpus, homedir, totalmem, tmpdir, platform, arch, release } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { benchRoot, buildCase, caseHash, caseIdFromHash, generatedValue, git, listCases, loadRunLock, lockPath, lockRefusals, readCase, repoRoot, snapshotCases } from "./lib/cases.mjs";
import { externalOf, scannerPreflight } from "./lib/external.mjs";
import { comparePasses } from "./lib/identical.mjs";
import { probeReviewer, BLOCKED } from "./lib/reviewers.mjs";
import { attemptDir, bundleHash, executeRun, failureOf, jobState, planJobs, provenanceProblems, resumeProblems, runManifest, sampleRecord, scanSampleRecord } from "./lib/runner.mjs";
import { SCAN_CONFIG, SCAN_RULES_VERSION } from "./lib/scan-score.mjs";
import { renderScan, saveScore } from "./score.mjs";

const USAGE = "usage: node benchmark/run.mjs [--repeat 3] [--cases a,b] [--graph off,on] [--reviewers claude[,codex]] [--concurrency 1] [--timeout 900] [--out <folder>] [--resume] [--model <id>] [--web on|off] [--dry-run] [--draft] [--allow-retired]\n       node benchmark/run.mjs --mode scan [--cases a,b] [--repeat 1] [--check-identical] [--scanner-config <file>] [--allow-missing-scanners] [--timeout 120] [--out <folder>] [--dry-run] [--draft] [--allow-retired]";

// Flags only a review run reads, and flags only a scanner-only run reads.
const REVIEW_ONLY = ["--reviewers", "--graph", "--web", "--model", "--resume"];
const SCAN_ONLY = ["--scanner-config", "--check-identical", "--allow-missing-scanners"];

function parseArgs(argv) {
  const o = { mode: "review", repeat: null, cases: null, graph: ["off", "on"], reviewers: ["claude"], concurrency: 1, timeout: null, out: null, resume: false, model: null, web: "on", dryRun: false, allowMore: false, draft: false, allowRetired: false, scannerConfig: null, checkIdentical: false, allowMissingScanners: false, cli: join(repoRoot, "packages/cli/dist/bin.js") };
  const given = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    given.add(a);
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--mode") o.mode = next();
    else if (a === "--scanner-config") o.scannerConfig = resolve(next());
    else if (a === "--check-identical") o.checkIdentical = true;
    else if (a === "--allow-missing-scanners") o.allowMissingScanners = true;
    else if (a === "--repeat") o.repeat = Number(next());
    else if (a === "--cases") o.cases = next().split(",").filter(Boolean);
    else if (a === "--graph") o.graph = next().split(",").filter(Boolean);
    else if (a === "--reviewers") o.reviewers = next().split(",").filter(Boolean);
    else if (a === "--concurrency") o.concurrency = Number(next());
    else if (a === "--timeout") o.timeout = Number(next());
    else if (a === "--out") o.out = resolve(next());
    else if (a === "--model") o.model = next();
    else if (a === "--web") o.web = next();
    else if (a === "--cli") o.cli = resolve(next());
    else if (a === "--resume") o.resume = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--allow-more") o.allowMore = true;
    else if (a === "--draft") o.draft = true;
    else if (a === "--allow-retired") o.allowRetired = true;
    else throw new Error(`unknown flag ${a}`);
  }
  if (o.mode !== "review" && o.mode !== "scan") throw new Error("--mode takes review or scan");
  const scan = o.mode === "scan";
  // A scan is deterministic (--check-identical proves it), so one repeat; a scan has no reviewer to wait on.
  o.repeat ??= scan ? 1 : 3;
  o.timeout ??= scan ? 120 : 900;
  const wrong = (scan ? REVIEW_ONLY : SCAN_ONLY).filter((f) => given.has(f));
  if (wrong.length > 0) {
    throw new Error(scan ? `${wrong.join(", ")}: a scanner-only run (--mode scan) runs no reviewer, and is run again rather than resumed` : `${wrong.join(", ")}: only a scanner-only run (--mode scan) reads ${wrong.length === 1 ? "it" : "them"}`);
  }
  if (scan && o.concurrency !== 1) throw new Error("--mode scan runs one scan at a time: every case is built at the one repository path the overlay's approval names, and scan times compare only at concurrency 1");
  if (o.scannerConfig !== null && !existsSync(o.scannerConfig)) throw new Error(`--scanner-config: there is no file ${o.scannerConfig}`);
  if (!Number.isInteger(o.repeat) || o.repeat < 1) throw new Error("--repeat takes a whole number from 1");
  if (o.repeat > 3 && !o.allowMore) throw new Error("--repeat over 3 spends more than the benchmark needs; add --allow-more to mean it");
  if (!Number.isInteger(o.concurrency) || o.concurrency < 1) throw new Error("--concurrency takes a whole number from 1");
  if (!Number.isInteger(o.timeout) || o.timeout < 60) throw new Error("--timeout takes whole seconds, at least 60");
  if (o.graph.some((g) => g !== "off" && g !== "on")) throw new Error("--graph takes off, on or off,on");
  if (o.reviewers.some((r) => r !== "claude" && r !== "codex")) throw new Error("--reviewers takes claude, codex or both");
  if (o.web !== "on" && o.web !== "off") throw new Error("--web takes on or off");
  if (o.model !== null && o.reviewers.includes("codex")) {
    throw new Error("--model cannot be used with Codex: the Codex reviewer runs with --ignore-user-config and takes no model setting; run without --model, and the run records the model Codex names in its own output");
  }
  const all = listCases();
  for (const c of o.cases ?? []) if (!all.includes(c)) throw new Error(`no case ${c}; cases: ${all.join(", ")}`);
  return o;
}

// The cases this run may use, copied once into a temp folder (failures 16
// and 17): the lock is checked against that copy, and every hash, spec and
// attempt comes from it. Exits 2 on a refusal, leaving no temp folder.
function lockedCases(o) {
  let lock;
  try {
    lock = loadRunLock(lockPath, { draft: o.draft });
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const cases = o.cases ?? listCases().filter((c) => lock.cases[c]?.retired !== true);
  const tempRoot = mkdtempSync(join(tmpdir(), "oq-bench-run-"));
  const refuse = (lines) => {
    rmSync(tempRoot, { recursive: true, force: true });
    console.error("The run cannot start:");
    for (const r of lines) console.error(`- ${r}`);
    process.exit(2);
  };
  let snap;
  let hashes;
  try {
    snap = snapshotCases(cases, join(tempRoot, "cases-snapshot"));
    hashes = Object.fromEntries(cases.map((c) => [c, caseHash(c, snap)]));
  } catch (error) {
    refuse([error.message]);
  }
  const refusals = lockRefusals(cases, lock, { draft: o.draft, allowRetired: o.allowRetired }, snap);
  if (refusals.length > 0) refuse(refusals);
  return { cases, snap, hashes, tempRoot };
}

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

// The build as benchmark/build-cli.mjs recorded it, checked against the
// bundle that is there now (failure 1).
function buildInfo(cli) {
  const provenance = readJson(join(benchRoot, ".build", "provenance.json"));
  const now = existsSync(cli) ? bundleHash(dirname(dirname(cli))) : null;
  const problems = now === null ? [`no built CLI at ${cli}; run node benchmark/build-cli.mjs`] : provenanceProblems(provenance, now);
  if (problems.length > 0) return { problems, build: null };
  let cliVersion = null;
  try {
    cliVersion = execFileSync(process.execPath, [cli, "--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    cliVersion = null;
  }
  return {
    problems: [],
    build: { commit: provenance.commit, short: provenance.commit.slice(0, 7), tree: provenance.tree, commitTree: provenance.commitTree, dirty: provenance.dirty, bundleHash: provenance.bundleHash, builtAt: provenance.builtAt, builtWithNode: provenance.node, cli: relative(repoRoot, cli), cliVersion },
  };
}

function machine() {
  // No host name: the results are published, and the hardware is what compares.
  return { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model ?? null, cpus: cpus().length, memoryGb: Math.round(totalmem() / 1024 ** 3), node: process.version };
}

function sanitize(text, replacements) {
  let out = text;
  for (const [from, to] of replacements) if (from) out = out.split(from).join(to);
  return out;
}

function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

const children = new Set();

function runCli(cli, args, env, cwd, timeoutMs, graceMs = 120_000) {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(process.execPath, [cli, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    children.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    // A review has its own reviewer deadline, so this one, graceMs past it,
    // catches a hang of the CLI itself; a scan has none, so its grace is 0.
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // gone already
      }
    }, timeoutMs + graceMs);
    child.on("error", (e) => (stderr += `\ncould not start the CLI: ${e.message}`));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      done({ code, signal, stdout, stderr, wallMs: Date.now() - started });
    });
  });
}

function killAll() {
  for (const c of children) {
    try {
      process.kill(-c.pid, "SIGTERM");
    } catch {
      // gone already
    }
  }
}

// --- scanner-only runs (--mode scan) ---

// A path as the manifest may hold it: the home folder written as ~.
const hideHome = (p) => (homedir() && p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);

// A file the run was given, as the manifest names it: its path in this
// repository, or its name when it lies outside.
function shownPath(file) {
  const r = relative(repoRoot, file);
  return r !== "" && !r.startsWith("..") && !isAbsolute(r) ? r : basename(file);
}

// The run's own OpenQodex home, in the run's temp folder: each tool folder
// of the warm install root ($OPENQODEX_HOME/tools or ~/.openqodex/tools) is
// linked in, so the scans read the developer's installed scanners, while
// trust.json, the custom scanners an overlay installs and every cache are
// the run's own (failure 20). "cold" when there was nothing to link.
function runHome(tempRoot) {
  const warm = join(process.env.OPENQODEX_HOME ? resolve(process.env.OPENQODEX_HOME) : join(homedir(), ".openqodex"), "tools");
  const dir = join(tempRoot, "home");
  mkdirSync(join(dir, "tools"), { recursive: true });
  let linked = 0;
  if (existsSync(warm)) {
    for (const e of readdirSync(warm, { withFileTypes: true })) {
      if ((!e.isDirectory() && !e.isSymbolicLink()) || e.name === "custom") continue;
      symlinkSync(join(warm, e.name), join(dir, "tools", e.name));
      linked++;
    }
  }
  return { dir, toolsHome: linked > 0 ? "warm" : "cold", installRoot: hideHome(warm) };
}

// The environment every CLI command of a scanner-only run gets: the run's
// own home, no update check, no colour, and none of the caller's git
// variables.
function cliEnv(home) {
  const env = { ...process.env, OPENQODEX_AUTO_UPDATE: "0", NO_COLOR: "1", OPENQODEX_HOME: home };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_") || k === "FORCE_COLOR") delete env[k];
  return env;
}

// `openqodex doctor --json` of the bundle the run uses, in the run's own
// home: it installs nothing and asks nothing of the network (failure 19).
function doctorRecord(cli, env, cwd) {
  const p = spawnSync(process.execPath, [cli, "doctor", "--json", "--cwd", cwd], { cwd, env, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  try {
    return JSON.parse(p.stdout);
  } catch {
    throw new Error(`openqodex doctor --json gave no record (exit ${p.status ?? p.signal}): ${String(p.stderr ?? "").trim().split("\n").slice(-3).join(" | ")}`);
  }
}

// The overlay's trust step (failure 20): the file is copied into the run,
// an empty repository is made at the path every case is built at in turn,
// and `openqodex trust --yes --config <copy>` approves the overlay's custom
// scanners for that path, in the run's own home. The empty repository is
// then moved aside. Returns the copy to pass to every scan and what the
// manifest records, or why the step failed.
function trustOverlay({ cli, env, file, tempRoot, repoPath, home, hide }) {
  const copy = join(tempRoot, "overlay", basename(file));
  mkdirSync(dirname(copy), { recursive: true });
  copyFileSync(file, copy);
  const sha256 = createHash("sha256").update(readFileSync(copy)).digest("hex");
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, "init", "-q");
  const key = realpathSync(repoPath);
  const p = spawnSync(process.execPath, [cli, "trust", "--yes", "--no-color", "--config", copy, "--cwd", repoPath], { cwd: repoPath, env, encoding: "utf8", timeout: 900_000, maxBuffer: 16 * 1024 * 1024 });
  const aside = join(tempRoot, "repos", "trust");
  mkdirSync(dirname(aside), { recursive: true });
  renameSync(repoPath, aside);
  if (p.status !== 0) {
    const why = hide(String(p.stderr ?? p.error ?? "")).trim().split("\n").slice(-4).join(" | ");
    return { error: `openqodex trust --yes --config ${shownPath(file)} failed (exit ${p.status ?? p.signal}), so no scanner of the overlay may run: ${why}` };
  }
  const records = readJson(join(home, "trust.json"))?.records ?? [];
  const trusted = records
    .filter((r) => r.repoRoot === key)
    .map((r) => ({ name: r.name, entryHash: r.entryHash, version: r.artifact?.version ?? null, sha256: r.artifact?.sha256 ?? null, checksumSource: r.artifact?.checksumSource ?? null }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { file: copy, record: { path: shownPath(file), sha256, trusted } };
}

// The first attempt of each planned job of a pass, as lib/external.mjs reads
// it: its case id, when it started and its saved scan.json.
function firstAttempts(folder, jobs) {
  return jobs.map((job) => {
    const dir = attemptDir(folder, job, 1);
    return { caseId: job.caseId, startedAt: readJson(join(dir, "sample.json"))?.started_at ?? null, scan: readJson(join(dir, "report", "scan.json")) };
  });
}

// A scanner-only run: the preflight, the overlay's trust step, one pass (or
// two with --check-identical), each scored, and the comparison.
async function scanMain(o, { cases, snap, hashes, tempRoot, build, leave }) {
  const date = new Date().toISOString().slice(0, 10);
  const out = o.out ?? join(benchRoot, "results", `${date}-${build.short}-planted-scan-laptop`);
  const runId = basename(out);
  const folders = o.checkIdentical ? [out, `${out}-pass2`] : [out];
  const shown = (p) => (p.startsWith(process.cwd()) ? relative(process.cwd(), p) || "." : p);
  const idOf = Object.fromEntries(cases.map((c) => [c, caseIdFromHash(c, hashes[c])]));
  const { jobs } = planJobs({ cases, caseIds: idOf, repeat: o.repeat, mode: "scan" });
  for (const folder of folders) {
    if (existsSync(join(folder, "samples")) || existsSync(join(folder, "manifest.json"))) {
      console.error(`${folder} already holds a run (a manifest or samples); use --out for a new folder`);
      leave(2);
    }
  }
  console.log(`Scanner-only benchmark: ${cases.length} cases x ${o.repeat} repeats = ${jobs.length} scans, one at a time${o.checkIdentical ? ", in two passes that must be identical" : ""}.`);
  console.log(`Build ${build.short}${build.dirty ? ", built from a tree the commit does not hold (dirty)" : ""}, openqodex ${build.cliVersion}. Results: ${folders.map(shown).join(" and ")}`);
  console.log(`Cases: ${cases.map((c) => idOf[c]).join(", ")}`);
  if (o.draft) console.log("A draft run: its cases need not match the lock, and it is never accepted.");
  if (o.dryRun) {
    for (const j of jobs) console.log(`  ${j.case} ${j.config} #${j.repeat}`);
    leave(0);
  }

  const realTemp = realpathSync(tempRoot);
  const replacements = (more) => [...more, [join(realTemp, "scan-repo"), "<repo>"], [realTemp, "<temp>"], [tempRoot, "<temp>"], [process.env.HOME, "~"]];
  const hide = (text) => sanitize(text, replacements([]));
  const home = runHome(tempRoot);
  const env = cliEnv(home.dir);
  let preflight;
  try {
    preflight = scannerPreflight(doctorRecord(o.cli, env, tempRoot));
  } catch (error) {
    console.error(`The run cannot start: ${error.message}`);
    leave(2);
  }
  if (preflight.missing.length > 0) {
    const list = preflight.missing.map((m) => `${m.scanner} (${m.detail ?? m.state})`).join(", ");
    if (!o.allowMissingScanners) {
      console.error(`The run cannot start: ${preflight.missing.length} scanners are not ready in ${home.installRoot}: ${list}. Install them with node ${relative(repoRoot, o.cli)} doctor --install --all-scanners (brakeman and rubocop need Ruby, golangci Go, cargo-deny Cargo), or pass --allow-missing-scanners to run without them: the manifest then names each one, and the run is never accepted.`);
      leave(2);
    }
    console.log(`Not ready, so not run (--allow-missing-scanners): ${list}`);
  }
  console.log(`Case repositories and the run's own OpenQodex home (tools linked from ${home.installRoot}): ${tempRoot}`);
  const repoPath = join(tempRoot, "scan-repo");
  let overlay = null;
  if (o.scannerConfig !== null) {
    overlay = trustOverlay({ cli: o.cli, env, file: o.scannerConfig, tempRoot, repoPath, home: home.dir, hide });
    if (overlay.error) {
      console.error(`The run cannot start: ${overlay.error}`);
      leave(2);
    }
    console.log(`Overlay ${overlay.record.path} (${overlay.record.sha256.slice(0, 12)}): approved in the run's own home: ${overlay.record.trusted.map((t) => `${t.name} ${t.version ?? ""}`.trim()).join(", ") || "no custom scanner"}`);
  }

  const settings = {
    runId,
    mode: "scan",
    path: "laptop",
    suite: "planted",
    split: "dev",
    build,
    machine: machine(),
    reviewer: null,
    reviewers: {},
    scan: { timeoutSeconds: o.timeout, flags: `scan --cwd <repo> --report-dir <sample>/report --no-color --no-install${overlay ? " --config <overlay>" : ""}` },
    toolsHome: home.toolsHome,
    installRoot: home.installRoot,
    scannerOverlay: overlay?.record ?? null,
    scannersComplete: preflight.missing.length === 0,
    scannersMissing: preflight.missing,
    checkIdentical: o.checkIdentical,
    cases,
    caseIds: cases.map((c) => idOf[c]),
    caseHashes: hashes,
    draft: o.draft,
    configs: [SCAN_CONFIG],
    repeat: o.repeat,
    concurrency: 1,
  };
  const secrets = new Set();
  for (const c of cases) for (const g of readCase(c, snap).generated ?? []) secrets.add(generatedValue(c, g.file, g.kind));

  let stop = null;
  const halt = (why) => {
    if (stop !== null) return;
    stop = why;
    console.error(`Stopping the run: ${why}`);
    killAll();
  };
  process.on("SIGINT", () => halt("stopped by Ctrl-C"));
  process.on("SIGTERM", () => halt("stopped by SIGTERM"));

  // One pass into `folder`: every scan, then the external inputs into the manifest.
  const pass = async (folder, n) => {
    console.log(n === 1 ? `Pass 1 into ${shown(folder)}` : `Pass 2, on the same build with fresh case repositories, into ${shown(folder)}`);
    const manifest = { ...runManifest({ startedAt: new Date().toISOString(), settings: n === 1 ? settings : { ...settings, identicalPass: { pass: 2, of: runId } }, jobs }), rulesVersion: SCAN_RULES_VERSION };
    let failedBefore = null;
    const attempt = async (job, k) => {
      const dir = attemptDir(folder, job, k);
      mkdirSync(dir, { recursive: true });
      const reportDir = join(dir, "report");
      // Every case is built at the one path the overlay's approval names, and moved aside after its scan.
      const { dir: repo } = buildCase(job.case, repoPath, snap);
      const args = ["scan", "--cwd", repo, "--report-dir", reportDir, "--no-color", "--no-install", ...(overlay ? ["--config", overlay.file] : [])];
      const startedAt = new Date().toISOString();
      let result;
      try {
        result = await runCli(o.cli, args, env, repo, o.timeout * 1000, 0);
      } finally {
        const aside = join(tempRoot, "repos", `pass${n}`, `${job.case}-${job.repeat}-${k}`);
        mkdirSync(dirname(aside), { recursive: true });
        renameSync(repoPath, aside);
      }
      const more = [[reportDir, "<sample>/report"], [folder, "<results>"]];
      writeFileSync(join(dir, "receipt.txt"), sanitize(result.stdout, replacements(more)));
      const stderr = sanitize(result.stderr, replacements(more));
      writeFileSync(join(dir, "stderr.txt"), stderr);
      const scan = readJson(join(reportDir, "scan.json"));
      const report = readJson(join(reportDir, "report.json"));
      const failure = scan ? null : { cause: stop !== null ? `stopped by the run: ${stop}` : `no scan.json (exit ${result.code ?? result.signal}): ${stderr.trim().split("\n").slice(-4).join(" | ")}` };
      const rec = scanSampleRecord({ job, attempt: k, result, scan, report, startedAt, failure, stopped: stop });
      writeFileSync(join(dir, "sample.json"), `${JSON.stringify(rec, null, 2)}\n`);
      appendFileSync(join(folder, "rows.jsonl"), `${JSON.stringify(rec)}\n`);
      console.log(`  ${job.case} #${job.repeat}: ${rec.status}, ${rec.candidates ?? "no"} candidates, ${(rec.wallMs / 1000).toFixed(1)} s${failure ? ` (${failure.cause.slice(0, 200)})` : ""}`);
      for (const file of filesUnder(dir)) {
        const text = readFileSync(file, "utf8");
        for (const s of secrets) if (text.includes(s)) halt(`the generated secret is in ${relative(folder, file)}; nothing more runs until that is fixed`);
      }
      return failure;
    };
    const runJob = async (job, k) => {
      try {
        const failure = await attempt(job, k);
        // The same step failing twice stops the run.
        if (failure && failedBefore && stop === null) halt(`two scans in a row wrote no scan.json; the last: ${failure.cause}`);
        failedBefore = failure;
      } catch (error) {
        halt(`${job.case} #${job.repeat}: the benchmark itself failed: ${error.message}`);
      }
    };
    const { ended } = await executeRun({
      out: folder,
      manifest,
      copies: cases.map((c) => [join(snap, c, "case.json"), join("cases", `${c}.json`)]),
      jobs,
      concurrency: 1,
      runJob,
      stopReason: () => stop,
      // The inputs every first attempt consumed, read from its saved scan (failure 21).
      finish: () => ({ external: externalOf({ samples: firstAttempts(folder, jobs), preflight }) }),
    });
    console.log(`Pass ${n}: ${ended.reviewsWithAnAttempt} of ${jobs.length} scans saved in ${ended.elapsedMin} minutes`);
    return ended;
  };

  const ends = [];
  for (const [i, folder] of folders.entries()) {
    try {
      ends.push(await pass(folder, i + 1));
    } catch (error) {
      console.error(error.message);
      process.exit(2);
    }
    if (stop !== null) {
      console.log(`Stopped: ${stop}`);
      process.exit(1);
    }
    try {
      const { score, run } = saveScore(folder);
      if (i === 0) console.log(`\n${renderScan(score, run.manifest)}\n`);
    } catch (error) {
      console.error(`The scan of ${shown(folder)} could not be scored: ${error.message}`);
      process.exit(2);
    }
  }
  console.log(`Score: ${folders.map((f) => shown(join(f, "score.json"))).join(" and ")}`);
  if (!o.checkIdentical) process.exit(0);
  const cmp = comparePasses(folders[0], folders[1]);
  const record = { version: 1, runId, identical: cmp.identical, cause: cmp.cause, inputs: cmp.inputs, differences: cmp.differences, passes: folders.map((f, i) => ({ folder: basename(f), elapsedMin: ends[i].elapsedMin })) };
  for (const f of folders) writeFileSync(join(f, "identical.json"), `${JSON.stringify(record, null, 2)}\n`);
  const times = `pass 1 took ${ends[0].elapsedMin} minutes, pass 2 ${ends[1].elapsedMin}`;
  if (cmp.identical) {
    console.log(`The two passes are identical: the same scores and the same samples, time fields left out (${times}).${cmp.inputs.length > 0 ? ` Their inputs differed without changing anything: ${cmp.inputs.join("; ")}` : ""}`);
    process.exit(0);
  }
  console.error(`The two passes are not identical (${cmp.cause === "input" ? "their inputs differ, so this pass cannot tell whether the product is deterministic; run it again" : "with the same inputs: the product's output is not deterministic"}; ${times}):`);
  for (const line of cmp.inputs) console.error(`- ${line}`);
  for (const line of cmp.differences.slice(0, 20)) console.error(`- ${line}`);
  if (cmp.differences.length > 20) console.error(`- and ${cmp.differences.length - 20} more, in identical.json`);
  process.exit(3);
}

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    process.exit(2);
  }
  const { cases, snap, hashes, tempRoot } = lockedCases(o);
  o.cases = cases;
  // Every exit before the reviews start leaves no copy behind.
  const leave = (code) => {
    rmSync(tempRoot, { recursive: true, force: true });
    process.exit(code);
  };
  const { problems, build } = buildInfo(o.cli);
  if (problems.length > 0) {
    for (const p of problems) console.error(p);
    leave(2);
  }
  if (o.mode === "scan") return scanMain(o, { cases, snap, hashes, tempRoot, build, leave });
  const date = new Date().toISOString().slice(0, 10);
  const out = o.out ?? join(benchRoot, "results", `${date}-${build.short}`);
  // The jobs in run order, each with its id (lib/runner.mjs planJobs; failure 7).
  const idOf = Object.fromEntries(o.cases.map((c) => [c, caseIdFromHash(c, hashes[c])]));
  let configs;
  let jobs;
  try {
    ({ configs, jobs } = planJobs({ cases: o.cases, caseIds: idOf, reviewers: o.reviewers, graph: o.graph, repeat: o.repeat }));
  } catch (error) {
    console.error(error.message);
    leave(2);
  }
  const shown = (p) => (p.startsWith(process.cwd()) ? relative(process.cwd(), p) || "." : p);
  // Refused here before any probe is spent; executeRun refuses again under the folder's lock.
  if ((existsSync(join(out, "samples")) || existsSync(join(out, "manifest.json"))) && !o.resume) {
    console.error(`${out} already holds a run (a manifest or samples); pass --resume to finish it, or --out for a new folder`);
    leave(2);
  }
  // A review is done once any of its attempts is saved; one whose first attempt never saved runs again in its next attempt folder.
  const todo = jobs.filter((j) => !jobState(out, j).done);
  console.log(`Benchmark: ${o.cases.length} cases x ${configs.length} configurations (${configs.map((c) => c.id).join(", ")}) x ${o.repeat} repeats = ${jobs.length} reviews; ${todo.length} to run, ${o.concurrency} at a time.`);
  console.log(`Build ${build.short}${build.dirty ? ", built from a tree the commit does not hold (dirty)" : ""}, openqodex ${build.cliVersion}. Results: ${shown(out)}`);
  const caseIds = o.cases.map((c) => idOf[c]);
  console.log(`Cases: ${caseIds.join(", ")}`);
  if (o.draft) console.log("A draft run: its cases need not match the lock, and it is never accepted.");
  if (o.dryRun) {
    for (const j of todo) console.log(`  ${j.case} ${j.config} #${j.repeat}`);
    leave(0);
  }

  // The reviewers, before anything is spent (failure 3), with the model each
  // one really answers with (failure 14).
  const env = { ...process.env, OPENQODEX_AUTO_UPDATE: "0", NO_COLOR: "1" };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_") || k === "FORCE_COLOR") delete env[k];
  if (o.model) env.ANTHROPIC_MODEL = o.model;
  const reviewers = {};
  for (const name of o.reviewers) {
    const p = await probeReviewer(name, { env });
    if (!p.ok) {
      console.error(`The ${name} reviewer cannot run: ${p.text}`);
      leave(2);
    }
    if (o.model && name === "claude" && p.model !== o.model) {
      console.error(`Asked for the model ${o.model}, but Claude Code answered with ${JSON.stringify(p.model)}; nothing runs.`);
      leave(2);
    }
    reviewers[name] = { name, version: p.version, model: p.model, modelFrom: name === "claude" ? "the model Claude Code names in its answer" : "the model line of the header Codex prints" };
    console.log(`Reviewer ${name} ${p.version}, model ${JSON.stringify(p.model)}`);
  }

  const settings = {
    runId: basename(out),
    mode: "review",
    build,
    machine: machine(),
    reviewer: o.reviewers.length === 1 ? reviewers[o.reviewers[0]] : null,
    reviewers,
    review: { web: o.web, timeoutSeconds: o.timeout, reportDir: true, flags: "review --report-dir <sample>/report --reviewer <name> --reviewer-web <on|off> --timeout <s> [--no-graph]" },
    cases: o.cases,
    // The frozen ids (planted/<name>@<hash8>) that scores and the index key by.
    caseIds,
    // What each case was built from, so a comparison can tell an edited case from a product change.
    caseHashes: hashes,
    // A draft run used cases that need not match the lock; it is never accepted.
    draft: o.draft,
    configs: configs.map((c) => c.id),
    repeat: o.repeat,
    concurrency: o.concurrency,
  };
  // A resume is refused when any setting, or the spec copy of any case, differs from the run's.
  const checkResume = (earlier) => {
    const differ = resumeProblems(earlier, settings);
    for (const c of o.cases) {
      const copy = join(out, "cases", `${c}.json`);
      if (existsSync(copy) && readFileSync(copy, "utf8") !== readFileSync(join(snap, c, "case.json"), "utf8")) differ.push(`case ${c}: its spec differs from the copy the run saved`);
    }
    return differ;
  };

  console.log(`Case repositories: ${tempRoot}`);
  const secrets = new Set();
  for (const c of o.cases) for (const g of readCase(c, snap).generated ?? []) secrets.add(generatedValue(c, g.file, g.kind));

  let stop = null;
  const halt = (why) => {
    if (stop !== null) return;
    stop = why;
    console.error(`Stopping the run: ${why}`);
    killAll();
  };
  process.on("SIGINT", () => halt("stopped by Ctrl-C"));
  process.on("SIGTERM", () => halt("stopped by SIGTERM"));

  // One attempt, saved as its own scored sample whatever happened (failure 4).
  const attempt = async (job, k) => {
    const dir = attemptDir(out, job, k);
    const caseDir = join(tempRoot, `${job.case}-${job.config}-${job.repeat}-${k}`);
    const { dir: repo } = buildCase(job.case, join(caseDir, "repo"), snap);
    const reportDir = join(dir, "report");
    mkdirSync(dir, { recursive: true });
    const args = ["review", "--cwd", repo, "--report-dir", reportDir, "--reviewer", job.reviewer, "--reviewer-web", o.web, "--timeout", String(o.timeout), "--no-color"];
    if (!job.graph) args.push("--no-graph");
    const startedAt = new Date().toISOString();
    const result = await runCli(o.cli, args, env, repo, o.timeout * 1000);
    const replacements = [[reportDir, "<sample>/report"], [repo, "<repo>"], [tempRoot, "<temp>"], [out, "<results>"], [process.env.HOME, "~"]];
    writeFileSync(join(dir, "receipt.txt"), sanitize(result.stdout, replacements));
    writeFileSync(join(dir, "stderr.txt"), sanitize(result.stderr, replacements));
    const report = readJson(join(reportDir, "report.json"));
    const who = readJson(join(reportDir, "reviewer.json"));
    const stoppedHere = stop;
    const failure = stoppedHere !== null && !report ? { cause: `stopped by the run: ${stoppedHere}`, infra: false, unavailable: false } : failureOf(result, report);
    const rec = sampleRecord({ job, attempt: k, result, report, who, startedAt, failure, stopped: stoppedHere });
    writeFileSync(join(dir, "sample.json"), `${JSON.stringify(rec, null, 2)}\n`);
    appendFileSync(join(out, "rows.jsonl"), `${JSON.stringify(rec)}\n`);
    const cost = rec.usage?.cost_usd;
    console.log(`  ${job.case} ${job.config} #${job.repeat}${k > 1 ? ` attempt ${k}` : ""}: ${rec.status}, ${rec.findings ?? "no"} findings, ${(rec.wallMs / 1000).toFixed(0)} s${typeof cost === "number" ? `, $${cost.toFixed(2)}` : ""}${rec.failure ? ` (${rec.failure.slice(0, 160)})` : ""}`);
    for (const file of filesUnder(dir)) {
      const text = readFileSync(file, "utf8");
      for (const s of secrets) if (text.includes(s)) halt(`the generated secret is in ${relative(out, file)}; nothing more runs until that is fixed`);
    }
    return failure;
  };

  // One job's reviews: its next free attempt (a first attempt that started
  // and never saved is kept, and the work goes to the next folder), and one
  // more after a reviewer failure.
  const runJob = async (job, k) => {
    try {
      const first = await attempt(job, k);
      if (stop !== null) return;
      if (first?.unavailable) return halt(`${job.case} ${job.config}: ${first.cause}`);
      if (!first?.infra) return;
      const p = await probeReviewer(job.reviewer, { env });
      if (!p.ok) return halt(`${job.case} ${job.config}: the reviewer failed (${first.cause}) and the probe says: ${p.text}${p.blocked ? " (a limit or login wall)" : ""}`);
      if (BLOCKED.test(first.cause)) return halt(`${job.case} ${job.config}: ${first.cause}`);
      console.log(`  ${job.case} ${job.config} #${job.repeat}: reviewer failed (${first.cause}); running it once more`);
      const second = await attempt(job, jobState(out, job).next);
      if (stop !== null) return;
      if (second?.infra && second.cause.split(":")[0] === first.cause.split(":")[0]) halt(`${job.case} ${job.config}: the same reviewer failure twice: ${second.cause}`);
    } catch (error) {
      halt(`${job.case} ${job.config} #${job.repeat}: the benchmark itself failed: ${error.message}`);
    }
  };

  // The folder is taken, the manifest with every planned job written (or the
  // resume checked) and the specs copied before the first review starts
  // (lib/runner.mjs executeRun). The manifest is the first invocation's; a
  // resume never writes it (failure 9).
  let ended;
  try {
    ({ ended } = await executeRun({
      out,
      manifest: o.resume ? null : runManifest({ startedAt: new Date().toISOString(), settings, jobs }),
      resume: o.resume,
      checkResume,
      copies: o.cases.map((c) => [join(snap, c, "case.json"), join("cases", `${c}.json`)]),
      jobs,
      concurrency: o.concurrency,
      runJob,
      stopReason: () => stop,
      log: (done, total) => {
        if (done % 10 === 0) console.log(`${done} of ${total} reviews done`);
      },
    }));
  } catch (error) {
    console.error(error.message);
    leave(2);
  }
  const finished = ended.reviewsWithAnAttempt;
  console.log(stop === null ? `Done: ${finished} reviews saved in ${shown(out)}` : `Stopped after ${finished} of ${jobs.length} reviews: ${stop}`);
  console.log(`Score it: node benchmark/score.mjs ${shown(out)}`);
  process.exit(stop === null ? 0 : 1);
}

await main();
