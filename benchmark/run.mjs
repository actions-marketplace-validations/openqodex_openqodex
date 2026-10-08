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
//
// One results folder per run, benchmark/results/<date>-<commit>/ unless
// --out names another:
//   manifest.json                     the build and where it came from, the machine, the
//                                     reviewers with their versions and models, the
//                                     settings, the plan, how the first invocation ended
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
//    holds samples is refused unless --resume; a resume keeps every saved
//    attempt, the specs the run copied and its manifest untouched, runs the
//    reviews that have no attempt, and is refused when the bundle, the
//    machine, a reviewer's version or model, web access, the timeout, the
//    concurrency, the cases, the configurations or the repeats differ.
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
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import { cpus, totalmem, tmpdir, platform, arch, release } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { benchRoot, buildCase, caseHash, casesRoot, generatedValue, listCases, readCase, repoRoot } from "./lib/cases.mjs";
import { probeReviewer, BLOCKED } from "./lib/reviewers.mjs";
import { attemptDir, bundleHash, failureOf, provenanceProblems, resumeProblems, sampleRecord } from "./lib/runner.mjs";

const USAGE = "usage: node benchmark/run.mjs [--repeat 3] [--cases a,b] [--graph off,on] [--reviewers claude[,codex]] [--concurrency 1] [--timeout 900] [--out <folder>] [--resume] [--model <id>] [--web on|off] [--dry-run]";

function parseArgs(argv) {
  const o = { repeat: 3, cases: null, graph: ["off", "on"], reviewers: ["claude"], concurrency: 1, timeout: 900, out: null, resume: false, model: null, web: "on", dryRun: false, allowMore: false, cli: join(repoRoot, "packages/cli/dist/bin.js") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--repeat") o.repeat = Number(next());
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
    else throw new Error(`unknown flag ${a}`);
  }
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
  o.cases ??= all;
  return o;
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

// The jobs in run order: per repeat, every case, every configuration, with
// the configuration order alternating by repeat (failure 7).
function plan(o) {
  const configs = [];
  for (const reviewer of o.reviewers) for (const g of o.graph) configs.push({ id: `${reviewer}-graph-${g}`, reviewer, graph: g === "on" });
  const jobs = [];
  for (let r = 1; r <= o.repeat; r++) {
    const order = r % 2 === 1 ? configs : [...configs].reverse();
    for (const c of o.cases) for (const cfg of order) jobs.push({ case: c, config: cfg.id, reviewer: cfg.reviewer, graph: cfg.graph, repeat: r });
  }
  return { configs, jobs };
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
  const { problems, build } = buildInfo(o.cli);
  if (problems.length > 0) {
    for (const p of problems) console.error(p);
    process.exit(2);
  }
  const date = new Date().toISOString().slice(0, 10);
  const out = o.out ?? join(benchRoot, "results", `${date}-${build.short}`);
  const { configs, jobs } = plan(o);
  const shown = (p) => (p.startsWith(process.cwd()) ? relative(process.cwd(), p) || "." : p);
  // A review counts as done once its first attempt is saved, failed or not.
  const saved = (job) => existsSync(join(attemptDir(out, job, 1), "sample.json"));
  if (existsSync(join(out, "samples")) && !o.resume) {
    console.error(`${out} already holds samples; pass --resume to finish that run, or --out for a new folder`);
    process.exit(2);
  }
  const todo = jobs.filter((j) => !saved(j));
  console.log(`Benchmark: ${o.cases.length} cases x ${configs.length} configurations (${configs.map((c) => c.id).join(", ")}) x ${o.repeat} repeats = ${jobs.length} reviews; ${todo.length} to run, ${o.concurrency} at a time.`);
  console.log(`Build ${build.short}${build.dirty ? ", built from a tree the commit does not hold (dirty)" : ""}, openqodex ${build.cliVersion}. Results: ${shown(out)}`);
  if (o.dryRun) {
    for (const j of todo) console.log(`  ${j.case} ${j.config} #${j.repeat}`);
    return;
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
      process.exit(2);
    }
    if (o.model && name === "claude" && p.model !== o.model) {
      console.error(`Asked for the model ${o.model}, but Claude Code answered with ${JSON.stringify(p.model)}; nothing runs.`);
      process.exit(2);
    }
    reviewers[name] = { name, version: p.version, model: p.model, modelFrom: name === "claude" ? "the model Claude Code names in its answer" : "the model line of the header Codex prints" };
    console.log(`Reviewer ${name} ${p.version}, model ${JSON.stringify(p.model)}`);
  }

  const manifestPath = join(out, "manifest.json");
  const resumesPath = join(out, "resumes.jsonl");
  const hashes = Object.fromEntries(o.cases.map((c) => [c, caseHash(c)]));
  const settings = {
    build,
    machine: machine(),
    reviewer: o.reviewers.length === 1 ? reviewers[o.reviewers[0]] : null,
    reviewers,
    review: { web: o.web, timeoutSeconds: o.timeout, reportDir: true, flags: "review --report-dir <sample>/report --reviewer <name> --reviewer-web <on|off> --timeout <s> [--no-graph]" },
    cases: o.cases,
    // What each case was built from, so a comparison can tell an edited case from a product change.
    caseHashes: hashes,
    configs: configs.map((c) => c.id),
    repeat: o.repeat,
    concurrency: o.concurrency,
  };
  let manifest = null;
  if (o.resume) {
    const earlier = readJson(manifestPath);
    if (!earlier) {
      console.error(`${shown(out)} has no manifest.json; there is no run to resume`);
      process.exit(2);
    }
    const differ = resumeProblems(earlier, settings);
    for (const c of o.cases) {
      const copy = join(out, "cases", `${c}.json`);
      if (existsSync(copy) && readFileSync(copy, "utf8") !== readFileSync(join(casesRoot, c, "case.json"), "utf8")) differ.push(`case ${c}: its spec differs from the copy the run saved`);
    }
    if (differ.length > 0) {
      console.error(`${shown(out)} cannot be resumed: resuming would mix two runs. Start a new run with --out.`);
      for (const d of differ) console.error(`- ${d}`);
      process.exit(2);
    }
    appendFileSync(resumesPath, `${JSON.stringify({ event: "resumed", at: new Date().toISOString(), toRun: todo.length })}\n`);
  } else {
    manifest = { version: 2, started_at: new Date().toISOString(), ...settings, planned: jobs.length, ended: null };
    mkdirSync(out, { recursive: true });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  // The specs this run scores against; a resume keeps the copies it made first.
  mkdirSync(join(out, "cases"), { recursive: true });
  for (const c of o.cases) if (!existsSync(join(out, "cases", `${c}.json`))) cpSync(join(casesRoot, c, "case.json"), join(out, "cases", `${c}.json`));

  const tempRoot = mkdtempSync(join(tmpdir(), "oq-bench-run-"));
  console.log(`Case repositories: ${tempRoot}`);
  const secrets = new Set();
  for (const c of o.cases) for (const g of readCase(c).generated ?? []) secrets.add(generatedValue(c, g.file, g.kind));

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
    const { dir: repo } = buildCase(job.case, join(caseDir, "repo"));
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

  const runJob = async (job) => {
    const first = await attempt(job, 1);
    if (stop !== null) return;
    if (first?.unavailable) return halt(`${job.case} ${job.config}: ${first.cause}`);
    if (!first?.infra) return;
    const p = await probeReviewer(job.reviewer, { env });
    if (!p.ok) return halt(`${job.case} ${job.config}: the reviewer failed (${first.cause}) and the probe says: ${p.text}${p.blocked ? " (a limit or login wall)" : ""}`);
    if (BLOCKED.test(first.cause)) return halt(`${job.case} ${job.config}: ${first.cause}`);
    console.log(`  ${job.case} ${job.config} #${job.repeat}: reviewer failed (${first.cause}); running it once more`);
    const second = await attempt(job, 2);
    if (stop !== null) return;
    if (second?.infra && second.cause.split(":")[0] === first.cause.split(":")[0]) halt(`${job.case} ${job.config}: the same reviewer failure twice: ${second.cause}`);
  };

  const queue = [...todo];
  let done = 0;
  const worker = async () => {
    while (stop === null && queue.length > 0) {
      const job = queue.shift();
      try {
        await runJob(job);
      } catch (error) {
        halt(`${job.case} ${job.config} #${job.repeat}: the benchmark itself failed: ${error.message}`);
      }
      done++;
      if (done % 10 === 0) console.log(`${done} of ${todo.length} reviews done`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(o.concurrency, todo.length) }, worker));

  const finished = jobs.filter(saved).length;
  const ended = { at: new Date().toISOString(), how: stop === null ? "finished" : "stopped", why: stop, reviewsWithAnAttempt: finished, planned: jobs.length };
  // The manifest is the first invocation's; a resume never writes it (failure 9).
  if (manifest) {
    manifest.ended = ended;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  } else appendFileSync(resumesPath, `${JSON.stringify({ event: "ended", ...ended })}\n`);
  console.log(stop === null ? `Done: ${finished} reviews saved in ${shown(out)}` : `Stopped after ${finished} of ${jobs.length} reviews: ${stop}`);
  console.log(`Score it: node benchmark/score.mjs ${shown(out)}`);
  process.exit(stop === null ? 0 : 1);
}

await main();
