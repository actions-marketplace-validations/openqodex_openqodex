#!/usr/bin/env node
// Runs the review benchmark: every case, every configuration, N times, with
// the real built CLI and the real reviewer. A script, never a model, decides
// what runs; the scores come later, from the saved files (score.mjs).
//
//   node benchmark/run.mjs [--repeat 3] [--cases a,b] [--graph off,on]
//                          [--reviewers claude[,codex]] [--concurrency 1]
//                          [--timeout 900] [--out <folder>] [--resume]
//                          [--model <id>] [--web on|off] [--dry-run]
//
// One results folder per run, benchmark/results/<date>-<commit>/ unless
// --out names another:
//   manifest.json                     the build, versions, machine, date, plan, how the run ended
//   cases/<case>.json                 the specs this run used (the scorer reads these)
//   samples/<case>/<config>/<n>/      one review: report/ (the CLI's --report-dir),
//                                     receipt.txt (what it printed), stderr.txt, sample.json
//   rows.jsonl                        one line per finished review
//
// Failure list, written before the code:
// 1. A stale or edited build is benchmarked under the commit's name: the
//    manifest records the commit, whether the tree had uncommitted changes,
//    the CLI's version and the sha256 of the bundle that ran.
// 2. The reviewer quietly falls back to another agent: --reviewer is always
//    passed, and the reviewer each review used is read from its reviewer.json.
// 3. A usage limit, a rate limit or a login wall turns every later review
//    into a failure: the reviewer is probed before the run, and again after
//    any review whose reviewer failed; a probe that fails stops the run at
//    once with its exact text.
// 4. A crash or a hang of one review: it is run once more; the same failure
//    twice stops the run, and what is done is kept.
// 5. Two reviews share a repository or a graph cache: each review gets its
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
// 9. An earlier run's folder is overwritten: a folder that holds samples is
//    refused unless --resume, which keeps every saved review and runs the rest.
// 10. Wall time includes building the case: the clock runs from the start
//    of the CLI to its exit only.
// 11. The run spends more than asked: more than three repeats needs
//    --allow-more, and the plan is printed before anything starts.
// 12. A review outlives the script after Ctrl-C: running reviews are
//    stopped, and the manifest says the run stopped and why.
// 13. Parallel reviews slow each other, which reads as a slower build: the
//    manifest records the concurrency, and the default is one at a time.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { cpus, totalmem, tmpdir, hostname, platform, arch, release } from "node:os";
import { join, relative, resolve } from "node:path";
import { benchRoot, buildCase, casesRoot, generatedValue, listCases, readCase, repoRoot } from "./lib/cases.mjs";
import { probeReviewer, REVIEWER_FAILED, BLOCKED } from "./lib/reviewers.mjs";

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
  const all = listCases();
  for (const c of o.cases ?? []) if (!all.includes(c)) throw new Error(`no case ${c}; cases: ${all.join(", ")}`);
  o.cases ??= all;
  return o;
}

const sh = (cmd, args, cwd = repoRoot) => {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
};

function buildInfo(cli) {
  const commit = sh("git", ["rev-parse", "HEAD"]);
  // Only what goes into the bundle: an edit to the benchmark itself does not change the build.
  const status = sh("git", ["status", "--porcelain", "--untracked-files=no", "--", "packages", "scripts", "package.json", "pnpm-lock.yaml"]);
  const bundle = existsSync(cli) ? createHash("sha256").update(readFileSync(cli)).digest("hex") : null;
  return {
    commit,
    short: commit ? commit.slice(0, 7) : "unknown",
    branch: sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]),
    dirty: status === null ? null : status !== "",
    cli: relative(repoRoot, cli),
    cliVersion: sh(process.execPath, [cli, "--version"]),
    bundleSha256: bundle,
    bundleBuiltAt: existsSync(cli) ? statSync(cli).mtime.toISOString() : null,
  };
}

function machine() {
  return { host: hostname(), platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model ?? null, cpus: cpus().length, memoryGb: Math.round(totalmem() / 1024 ** 3), node: process.version };
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

const sampleDir = (out, job) => join(out, "samples", job.case, job.config, String(job.repeat));

function sanitize(text, replacements) {
  let out = text;
  for (const [from, to] of replacements) if (from) out = out.split(from).join(to);
  return out;
}

function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

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

// Why a review did not end complete, in one line, and whether the reviewer
// itself failed (as opposed to the product judging the review incomplete).
function failureOf(result, report) {
  const missing = report?.completion?.missing ?? [];
  const reviewerFailed = missing.find((m) => REVIEWER_FAILED.test(m));
  if (report === null) {
    const last = result.stderr.trim().split("\n").slice(-6).join(" | ");
    const unavailable = /Full review unavailable|could not start a reviewer/.test(result.stderr);
    return { cause: unavailable ? `no reviewer could start: ${last}` : `no report.json (exit ${result.code ?? result.signal}): ${last}`, infra: true, unavailable };
  }
  if (reviewerFailed) return { cause: reviewerFailed, infra: true, unavailable: false };
  if (report.completion?.status !== "complete") return { cause: missing.join("; ") || "incomplete", infra: false, unavailable: false };
  return null;
}

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    process.exit(2);
  }
  if (!existsSync(o.cli)) {
    console.error(`no built CLI at ${o.cli}; run pnpm build first`);
    process.exit(2);
  }
  const build = buildInfo(o.cli);
  const date = new Date().toISOString().slice(0, 10);
  const out = o.out ?? join(benchRoot, "results", `${date}-${build.short}`);
  const { configs, jobs } = plan(o);
  const shown = (p) => (p.startsWith(process.cwd()) ? relative(process.cwd(), p) || "." : p);
  const saved = (job) => existsSync(join(sampleDir(out, job), "sample.json"));
  if (existsSync(join(out, "samples")) && !o.resume) {
    console.error(`${out} already holds samples; pass --resume to finish that run, or --out for a new folder`);
    process.exit(2);
  }
  const todo = jobs.filter((j) => !saved(j));
  console.log(`Benchmark: ${o.cases.length} cases x ${configs.length} configurations (${configs.map((c) => c.id).join(", ")}) x ${o.repeat} repeats = ${jobs.length} reviews; ${todo.length} to run, ${o.concurrency} at a time.`);
  console.log(`Build ${build.short}${build.dirty ? " with uncommitted source changes" : ""}, openqodex ${build.cliVersion}. Results: ${shown(out)}`);
  if (build.dirty) console.log("Warning: the CLI's source has uncommitted changes; the run is not tied to one commit.");
  if (o.dryRun) {
    for (const j of todo) console.log(`  ${j.case} ${j.config} #${j.repeat}`);
    return;
  }

  // The reviewers, before anything is spent (failure 3).
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
    reviewers[name] = { name, version: p.version, model: p.model };
    console.log(`Reviewer ${name} ${p.version}, model ${JSON.stringify(p.model)}`);
  }

  mkdirSync(join(out, "cases"), { recursive: true });
  for (const c of o.cases) cpSync(join(casesRoot, c, "case.json"), join(out, "cases", `${c}.json`));
  const manifestPath = join(out, "manifest.json");
  const earlier = readJson(manifestPath);
  const manifest = {
    version: 1,
    started_at: earlier?.started_at ?? new Date().toISOString(),
    resumed_at: earlier ? [...(earlier.resumed_at ?? []), new Date().toISOString()] : [],
    build,
    machine: machine(),
    reviewer: o.reviewers.length === 1 ? reviewers[o.reviewers[0]] : null,
    reviewers,
    review: { web: o.web, timeoutSeconds: o.timeout, reportDir: true, flags: "review --report-dir <sample>/report --reviewer <name> --reviewer-web <on|off> --timeout <s> [--no-graph]" },
    cases: o.cases,
    configs: configs.map((c) => c.id),
    repeat: o.repeat,
    concurrency: o.concurrency,
    planned: jobs.length,
    ended: null,
  };
  const writeManifest = () => writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeManifest();

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

  const once = async (job, attempt) => {
    const dir = sampleDir(out, job);
    const caseDir = join(tempRoot, `${job.case}-${job.config}-${job.repeat}-${attempt}`);
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
    return { result, report, who, startedAt };
  };

  const runJob = async (job) => {
    let attempt = 1;
    let r = await once(job, attempt);
    let failure = failureOf(r.result, r.report);
    if (stop !== null) return;
    if (failure?.unavailable) return halt(`${job.case} ${job.config}: ${failure.cause}`);
    if (failure?.infra) {
      const p = await probeReviewer(job.reviewer, { env });
      if (!p.ok) return halt(`${job.case} ${job.config}: the reviewer failed (${failure.cause}) and the probe says: ${p.text}${p.blocked ? " (a limit or login wall)" : ""}`);
      if (BLOCKED.test(failure.cause)) return halt(`${job.case} ${job.config}: ${failure.cause}`);
      attempt = 2;
      console.log(`  ${job.case} ${job.config} #${job.repeat}: reviewer failed (${failure.cause}); running it once more`);
      const first = failure.cause;
      r = await once(job, attempt);
      failure = failureOf(r.result, r.report);
      if (stop !== null) return;
      if (failure?.infra) {
        const same = failure.cause.split(":")[0] === first.split(":")[0];
        if (same) return halt(`${job.case} ${job.config}: the same reviewer failure twice: ${failure.cause}`);
      }
    }
    const dir = sampleDir(out, job);
    for (const file of filesUnder(dir)) {
      const text = readFileSync(file, "utf8");
      for (const s of secrets) if (text.includes(s)) return halt(`the generated secret is in ${relative(out, file)}; nothing more runs until that is fixed`);
    }
    const report = r.report;
    const sample = {
      case: job.case,
      config: job.config,
      reviewer: job.reviewer,
      graph: job.graph ? "on" : "off",
      repeat: job.repeat,
      attempts: attempt,
      started_at: r.startedAt,
      exit: r.result.code,
      signal: r.result.signal,
      wallMs: r.result.wallMs,
      status: report === null ? "failed" : report.completion?.status ?? "unknown",
      failure: failure?.cause ?? null,
      verdict: report?.verdict ?? null,
      reviewerUsed: r.who ?? null,
      findings: report ? report.findings.length + (report.outside_change?.length ?? 0) : null,
      usage: report?.completion?.reviewer?.usage ?? null,
      reviewerMs: report?.completion?.reviewer?.duration_ms ?? null,
      rounds: report?.completion?.reviewer?.rounds ?? null,
      graphStatus: report?.impact?.status ?? null,
      graphMs: report?.impact?.build?.durationMs ?? null,
      scanners: (report?.scanners ?? []).map((s) => ({ scanner: s.scanner, status: s.status, version: s.version, kept: s.keptCount, ms: s.durationMs })),
    };
    writeFileSync(join(dir, "sample.json"), `${JSON.stringify(sample, null, 2)}\n`);
    appendFileSync(join(out, "rows.jsonl"), `${JSON.stringify(sample)}\n`);
    const cost = sample.usage?.cost_usd;
    console.log(`  ${job.case} ${job.config} #${job.repeat}: ${sample.status}, ${sample.findings ?? "no"} findings, ${(sample.wallMs / 1000).toFixed(0)} s${typeof cost === "number" ? `, $${cost.toFixed(2)}` : ""}${sample.failure ? ` (${sample.failure.slice(0, 160)})` : ""}`);
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
  manifest.ended = { at: new Date().toISOString(), how: stop === null ? "finished" : "stopped", why: stop, samples: finished };
  writeManifest();
  console.log(stop === null ? `Done: ${finished} reviews saved in ${shown(out)}` : `Stopped after ${finished} of ${jobs.length} reviews: ${stop}`);
  console.log(`Score it: node benchmark/score.mjs ${shown(out)}`);
  process.exit(stop === null ? 0 : 1);
}

await main();
