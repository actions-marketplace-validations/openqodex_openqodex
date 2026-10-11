#!/usr/bin/env node
// Runs the review benchmark: every case, every configuration, N times, with
// the real built CLI and the real reviewer. A script, never a model, decides
// what runs; the scores come later, from the saved files (score.mjs).
//
//   node benchmark/build-cli.mjs      build the CLI and record where it came from
//   node benchmark/run.mjs --max-usd <n> --max-minutes <n>
//                          [--max-tokens <n>] [--max-reviews <n>] [--allow-over]
//                          [--repeat 3] [--cases a,b] [--graph off,on]
//                          [--reviewers claude[,codex]] [--concurrency 1]
//                          [--timeout 900] [--out <folder>] [--resume]
//                          [--add-repeats <n>] [--change <RC-id>]
//                          [--model <id>] [--web off|on] [--dry-run]
//                          [--draft] [--allow-retired] [--allow-missing-scanners]
//
// Without --cases, every case the lock does not mark retired runs.
//
// Exit codes: 0 finished; 1 stopped (a limit or login wall, the budget, the
// same failure twice, Ctrl-C); 2 refused (flags, build, lock, budget
// estimate, scanners) or the benchmark itself failed.
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
//    the cases, the configurations, the repeats, the scanners found missing
//    or the change differ. A resume names its own budget (a run stopped by
//    its budget is finished by resuming it with more), and --add-repeats
//    adds repeats to a finished run under lib/runner.mjs's rules.
// 10. Wall time includes building the case: the clock runs from the start
//    of the CLI to its exit only.
// 11. The run spends more than asked: more than three repeats needs
//    --allow-more, more than six is refused, and the plan is printed before
//    anything starts, with its estimate (lib/budget.mjs). Every run names
//    --max-usd and --max-minutes; one whose estimate passes either is
//    refused unless --allow-over. Before each review the launch rule asks
//    whether what is spent, plus the median review so far for each review
//    running and the next, would pass --max-usd, and whether the time gone
//    plus the median review time would pass --max-minutes; --max-tokens and
//    --max-reviews stop launches the same way. Claude Code and Codex report
//    their cost only after a review, so these are forecast stops: a run may
//    pass --max-usd by the reviews already running, and its manifest says
//    so (ended.how "budget", limitKind "forecast", spentUsd). Hard caps that
//    hold every model call before it is sent are lib/budget.mjs's, for the
//    model reviewers and the judge.
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
// 18. A run on a machine that lacks a scanner its cases need (no Ruby for
//    brakeman and rubocop, no Go for golangci-lint) is taken for a run with
//    every scanner: before anything is spent, the CLI's own doctor is asked,
//    in each case's built repository, which scanners the case calls for and
//    whether each is installed; a missing one refuses the run unless
//    --allow-missing-scanners, and then the manifest records
//    scannersComplete false and each missing scanner, and the run is never
//    accepted.
// 19. The reviewer reads the cases' truth on the web (every case and its
//    discussion is public): web access is off unless --web on is given.
// 20. A run's reviews are compared under different loop changes: --change
//    records the reviewer-loop change id the run measures, and a resume
//    with another is refused.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { cpus, totalmem, tmpdir, platform, arch, release } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { benchRoot, buildCase, caseHash, caseIdFromHash, generatedValue, listCases, loadRunLock, lockPath, lockRefusals, readCase, repoRoot, snapshotCases } from "./lib/cases.mjs";
import { estimateRun, manifestBudget, readLedger, runBudget, startRefusals } from "./lib/budget.mjs";
import { probeReviewer, BLOCKED } from "./lib/reviewers.mjs";
import { attemptDir, bundleHash, executeRun, failureOf, jobState, planJobs, preflightRefusals, provenanceProblems, resumeProblems, runManifest, sampleRecord, scannerPreflight } from "./lib/runner.mjs";

const USAGE = "usage: node benchmark/run.mjs --max-usd <n> --max-minutes <n> [--max-tokens <n>] [--max-reviews <n>] [--allow-over] [--repeat 3] [--cases a,b] [--graph off,on] [--reviewers claude[,codex]] [--concurrency 1] [--timeout 900] [--out <folder>] [--resume] [--add-repeats <n>] [--change <RC-id>] [--model <id>] [--web off|on] [--dry-run] [--draft] [--allow-retired] [--allow-missing-scanners]";

// What this runner reviews today: the planted suite, through the laptop
// reviewers (Claude Code and Codex).
const SUITE = "planted";
const PATH_KIND = "laptop";

const positive = (flag, value, whole = false) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || (whole && !Number.isInteger(n))) throw new Error(`${flag} takes ${whole ? "a whole number" : "a number"} above 0`);
  return n;
};

function parseArgs(argv) {
  const o = { repeat: 3, repeatGiven: false, cases: null, graph: ["off", "on"], reviewers: ["claude"], concurrency: 1, timeout: 900, out: null, resume: false, addRepeats: null, change: null, model: null, web: "off", dryRun: false, allowMore: false, draft: false, allowRetired: false, allowMissingScanners: false, allowOver: false, maxUsd: null, maxMinutes: null, maxTokens: null, maxReviews: null, reviewMaxUsd: null, cli: join(repoRoot, "packages/cli/dist/bin.js") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--repeat") {
      o.repeat = Number(next());
      o.repeatGiven = true;
    } else if (a === "--max-usd") o.maxUsd = positive(a, next());
    else if (a === "--max-minutes") o.maxMinutes = positive(a, next());
    else if (a === "--max-tokens") o.maxTokens = positive(a, next(), true);
    else if (a === "--max-reviews") o.maxReviews = positive(a, next(), true);
    else if (a === "--review-max-usd") o.reviewMaxUsd = positive(a, next());
    else if (a === "--add-repeats") o.addRepeats = positive(a, next(), true);
    else if (a === "--change") o.change = next();
    else if (a === "--allow-over") o.allowOver = true;
    else if (a === "--allow-missing-scanners") o.allowMissingScanners = true;
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
  if (o.maxUsd === null || o.maxMinutes === null) throw new Error("--max-usd and --max-minutes are required: every run names what it may spend and how long it may take");
  if (!Number.isInteger(o.repeat) || o.repeat < 1 || o.repeat > 6) throw new Error("--repeat takes a whole number from 1 to 6");
  if (o.repeat > 3 && !o.allowMore) throw new Error("--repeat over 3 spends more than the benchmark needs; add --allow-more to mean it");
  if (o.addRepeats !== null) {
    if (o.out === null) throw new Error("--add-repeats needs --out <folder>: the finished run to add repeats to");
    if (o.repeatGiven || o.resume) throw new Error("--add-repeats takes the run's own repeats and adds to them, and resumes it; leave out --repeat and --resume");
  }
  if (o.change !== null && !/^RC-\d{4}$/.test(o.change)) throw new Error("--change takes a reviewer-loop change id, RC-<4 digits>");
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

function runCli(cli, args, env, cwd, timeoutMs) {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(process.execPath, [cli, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    children.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    // The CLI has its own reviewer deadline; this one catches a hang of the CLI itself.
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // gone already
      }
    }, timeoutMs + 120_000);
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
  const date = new Date().toISOString().slice(0, 10);
  const out = o.out ?? join(benchRoot, "results", `${date}-${build.short}`);
  // --add-repeats: the run's own repeats plus the added ones, as a resume of
  // that run whose plan grows (lib/runner.mjs executeRun, failure 15 there).
  if (o.addRepeats !== null) {
    const earlier = readJson(join(out, "manifest.json"));
    if (!earlier) {
      console.error(`${out} holds no run to add repeats to`);
      leave(2);
    }
    o.repeat = earlier.repeat + o.addRepeats;
    o.resume = true;
    if (o.repeat > 6 || (o.repeat > 3 && !o.allowMore)) {
      console.error(`adding ${o.addRepeats} to the run's ${earlier.repeat} repeats gives ${o.repeat}; ${o.repeat > 6 ? "6 is the most" : "over 3 needs --allow-more"}`);
      leave(2);
    }
  }
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
  if (o.web === "on") console.log("Web access is on: the reviewer may read each case and its discussion online.");

  // The environment every review, probe and doctor run gets.
  const env = { ...process.env, OPENQODEX_AUTO_UPDATE: "0", NO_COLOR: "1" };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_") || k === "FORCE_COLOR") delete env[k];
  if (o.model) env.ANTHROPIC_MODEL = o.model;

  // The budget, before anything is spent (failure 11): the estimate of what
  // is left to run, on top of what the run's ledger says is spent already.
  const caps = { maxUsd: o.maxUsd, reviewMaxUsd: o.reviewMaxUsd };
  const forecast = { maxMinutes: o.maxMinutes, maxTokens: o.maxTokens, maxReviews: o.maxReviews };
  const estimate = estimateRun({ jobs: todo, suite: SUITE, path: PATH_KIND, concurrency: o.concurrency });
  const spentBefore = readLedger(out).spentUsd;
  const usd = (n) => `$${n.toFixed(2)}`;
  console.log(`Estimate: ${usd(estimate.usd)} for ${estimate.reviews - estimate.unpriced} reviews${estimate.unpriced > 0 ? ` (${estimate.unpriced} more report tokens, not dollars)` : ""}, about ${Math.ceil(estimate.minutes)} minutes; from ${[...new Set(Object.values(estimate.perConfig).map((p) => p.from))].join(" and ")}.`);
  console.log(`Budget: --max-usd ${usd(o.maxUsd)}${spentBefore > 0 ? ` (${usd(spentBefore)} spent already)` : ""}, --max-minutes ${o.maxMinutes}${o.maxTokens ? `, --max-tokens ${o.maxTokens}` : ""}${o.maxReviews ? `, --max-reviews ${o.maxReviews}` : ""}. Claude Code and Codex report their cost after each review, so these are forecast stops: no review starts once the next would pass a limit.`);
  const refusals = startRefusals({ estimate, caps, forecast, spentUsd: spentBefore, allowOver: o.allowOver, path: PATH_KIND });

  // The scanners each case needs, from the CLI's own doctor in each case's
  // repository (failure 18).
  let preflight;
  try {
    const repos = o.cases.map((c) => ({ case: c, dir: buildCase(c, join(tempRoot, "preflight", c, "repo"), snap).dir }));
    preflight = scannerPreflight({ cli: o.cli, repos, env });
  } catch (error) {
    console.error(`The scanner preflight failed: ${error.message}`);
    leave(2);
  }
  if (preflight.complete) console.log("Scanners: every scanner the cases call for is installed.");
  else {
    console.log(`Scanners missing: ${preflight.missing.map((m) => `${m.scanner} for ${m.case} (${m.state})`).join(", ")}.`);
    if (o.allowMissingScanners) console.log("--allow-missing-scanners: the run records scannersComplete false and is never accepted.");
  }
  refusals.push(...preflightRefusals(preflight, { allowMissing: o.allowMissingScanners }));
  if (refusals.length > 0) {
    console.error("The run cannot start:");
    for (const r of refusals) console.error(`- ${r}`);
    leave(2);
  }
  if (o.dryRun) {
    for (const j of todo) console.log(`  ${j.case} ${j.config} #${j.repeat}`);
    leave(0);
  }

  // The reviewers, before anything is spent (failure 3), with the model each
  // one really answers with (failure 14).
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
    // The reviewer-loop change this run measures, if any.
    changeId: o.change,
    // Hard caps apart from forecast stops; on the laptop path --max-usd can
    // only be held as a forecast, and the end record says which stopped it.
    budget: manifestBudget({ caps, forecast, estimate, allowOver: o.allowOver }),
    // Whether every scanner the cases call for was installed (failure 18).
    scannersComplete: preflight.complete,
    scannersMissing: preflight.missing.map((m) => ({ case: m.case, scanner: m.scanner })),
  };
  // A resume is refused when any setting, or the spec copy of any case,
  // differs from the run's; adding repeats changes only the repeats.
  const checkResume = (earlier) => {
    const differ = resumeProblems(earlier, o.addRepeats !== null ? { ...settings, repeat: earlier.repeat } : settings);
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

  // The run's ledger, in its folder: each review's reported cost, tokens and
  // time, which the launch rule reads before the next review (failure 11).
  const budget = runBudget({ dir: out, caps, forecast, estimate, path: PATH_KIND });

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
    const tokens = Number.isInteger(rec.usage?.input_tokens) && Number.isInteger(rec.usage?.output_tokens) ? rec.usage.input_tokens + rec.usage.output_tokens : null;
    budget.recordReview({ jobId: job.jobId, usd: typeof rec.usage?.cost_usd === "number" ? rec.usage.cost_usd : null, tokens, wallMs: rec.wallMs });
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
      // A limit or a login wall in the failure itself stops the run at once, without a probe.
      if (BLOCKED.test(first.cause)) return halt(`${job.case} ${job.config}: ${first.cause}`);
      const p = await probeReviewer(job.reviewer, { env });
      if (!p.ok) return halt(`${job.case} ${job.config}: the reviewer failed (${first.cause}) and the probe says: ${p.text}${p.blocked ? " (a limit or login wall)" : ""}`);
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
  // resume never writes it, except to add repeats (failure 9). Before each
  // review the budget is asked; its stop ends the run as "budget".
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
      budget,
      addRepeats: o.addRepeats !== null ? { repeat: o.repeat, at: new Date().toISOString() } : null,
      resumeNote: { budget: settings.budget },
      log: (done, total) => {
        if (done % 10 === 0) console.log(`${done} of ${total} reviews done`);
      },
    }));
  } catch (error) {
    console.error(error.message);
    leave(2);
  }
  const finished = ended.reviewsWithAnAttempt;
  const spent = typeof ended.spentUsd === "number" ? `; $${ended.spentUsd.toFixed(2)} spent` : "";
  if (ended.how === "finished") console.log(`Done: ${finished} reviews saved in ${shown(out)}${spent}`);
  else console.log(`Stopped${ended.how === "budget" ? " by the budget" : ""} after ${finished} of ${jobs.length} reviews${spent}: ${ended.why}${ended.how === "budget" ? `. Resume with --resume and a larger limit to finish it; until then it is not a full run.` : ""}`);
  console.log(`Score it: node benchmark/score.mjs ${shown(out)}`);
  process.exit(ended.how === "finished" ? 0 : 1);
}

await main();
