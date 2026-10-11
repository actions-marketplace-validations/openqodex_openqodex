// The server path of the benchmark: one review of a materialised case
// through the library's server profile (`reviewChange`, docs/library.md),
// the way a host runs it, saved as a sample the scorer reads. run.mjs runs
// it for every `model:<id>` reviewer: `model:scripted` (the scripted model,
// lib/scripted-model.mjs) or a deployment of the model endpoint
// (lib/openai-reviewer.mjs, settings from lib/model-env.mjs).
//
// One attempt (serverAttempt):
// - the case is materialised in the server shape (lib/suites.mjs: the base
//   and the change as two commits), and its two commits are the merge base
//   and the head;
// - the review gets a fresh workDir of its own under a short work root (the
//   library writes only there, and TFLint's socket path must stay short),
//   which is removed when the review returns;
// - every model call is held by the run's budget ledger: `authorize` is the
//   review's meter (lib/budget.mjs), and the adapter is wrapped so each call
//   settles its reservation with the cost it reports; deadlineMs is the
//   run's --timeout;
// - the result is saved: report/report.json and report/report.md (the
//   library's own renderings), report/scan.json (the scan record, when the
//   library's result carries it), usage.json, completion.json,
//   dispositions.json, rounds.json, progress.txt and sample.json.
//
// Failure list, written before the code:
// 1. A server review writes outside its workDir: the work root may not lie
//    in the clone or the results folder; each review gets a new workDir
//    there and it is removed afterwards; the clone's head, refs and work
//    tree (ignored files included) are read before and after, and a
//    difference is named in the sample (`outside`), which stops the run;
//    every saved text has the workDir and clone paths replaced.
// 2. An incomplete server review is scored as complete: the sample's
//    status is the result's (complete and complete_blocking are complete;
//    incomplete stays incomplete, with the library's reason), the saved
//    report.json is the library's own rendering, whose completion record
//    the scorer reads, and a review that threw is failed.
// 3. The model recorded is not the one that answered: the sample records
//    the model each call asked for apart from the models the provider named
//    as answering (from the library's usage records); one served model is
//    named only when every answered call named that one, and none is named
//    when the provider named none. The manifest records the deployment, an
//    alias that led to it, and the settings (effort, maxOutputTokens).
// 4. A model nobody probed is reviewed with: resolveModelReviewer takes
//    `model:scripted`, a deployment boards.json records with a probed date,
//    or a name in boards.json's aliases map that points at one, and refuses
//    anything else before a run starts.
// 5. The key or the base URL of the model endpoint lands in a saved file:
//    the settings never enter a record, and run.mjs checks every saved file
//    with the settings' appearsIn and stops the run on a hit.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { gitEnv, repoRoot } from "./cases.mjs";
import { loadModelEnv, probedDeployment } from "./model-env.mjs";
import { createOpenAIReviewer } from "./openai-reviewer.mjs";
import { attemptDir, scannerRows } from "./runner.mjs";
import { createScriptedReviewer, DEFAULT_SCRIPT, readScript } from "./scripted-model.mjs";

const BOARDS = new URL("../outside/boards.json", import.meta.url);
export const SCRIPTED = "model:scripted";

/** True when the name is a model reviewer's (`model:<id>`). */
export const isModelReviewer = (name) => typeof name === "string" && name.startsWith("model:");

/**
 * Which model `name` (`model:<id>`) reviews with, or a thrown refusal:
 * the scripted model; a deployment boards.json records with a probed date;
 * or a name in boards.json's aliases map that points at one (failure 4).
 */
export function resolveModelReviewer(name, { boards = JSON.parse(readFileSync(BOARDS, "utf8")) } = {}) {
  if (!isModelReviewer(name) || name.length === "model:".length) throw new Error(`refused: ${JSON.stringify(name)} is not model:<deployment>`);
  const id = name.slice("model:".length);
  if (name === SCRIPTED) return { name, kind: "scripted", deployment: null, alias: null };
  const deployments = Object.values(boards?.deployments ?? {}).map((d) => d?.id);
  const aliases = boards?.aliases ?? {};
  const isDeployment = deployments.includes(id);
  const alias = !isDeployment && Object.hasOwn(aliases, id) ? aliases[id] : null;
  if (!isDeployment && alias === null) {
    const named = Object.keys(aliases);
    throw new Error(`refused: ${id} is neither a deployment boards.json records nor a name in its aliases map; the deployments are ${deployments.join(", ")}, and the aliases are ${named.length > 0 ? named.join(", ") : "none"}. A name is used only when benchmark/outside/boards.json maps it to a probed deployment`);
  }
  const d = probedDeployment(isDeployment ? id : alias, { boards });
  return { name, kind: "deployment", deployment: d.id, alias: isDeployment ? null : id, provider: d.provider ?? null, probed: d.probed, servedAtProbe: d.served ?? null };
}

// A path as a record shows it: in this repository, relative to it; else
// its name.
const shownFile = (path) => {
  const r = relative(repoRoot, path);
  return r !== "" && !r.startsWith("..") && !isAbsolute(r) ? r : path.split("/").at(-1);
};

/**
 * The ModelReviewer for a resolved model, with what the manifest records
 * about it and what the budget prices its calls at. `scriptPath` is the
 * scripted model's script; the endpoint's settings come from
 * lib/model-env.mjs and never enter `record`. `appearsIn(text)` is true when
 * a text holds the endpoint's key or base URL (null for the scripted model).
 */
export function createModelReviewer(resolved, { effort, maxOutputTokens = 32000, scriptPath = DEFAULT_SCRIPT, env = process.env } = {}) {
  const settings = { effort: effort ?? null, maxOutputTokens };
  const base = { name: resolved.name, kind: "model", version: null, settings, modelFrom: "the served model each call's response names, recorded in each sample" };
  if (resolved.kind === "scripted") {
    const { script, sha256 } = readScript(scriptPath);
    return {
      reviewer: createScriptedReviewer(script, { maxOutputTokens }),
      record: { ...base, model: script.model, deployment: null, alias: null, script: { file: shownFile(scriptPath), sha256 } },
      prices: { [script.model]: script.prices },
      appearsIn: null,
    };
  }
  const endpoint = loadModelEnv({ env });
  return {
    reviewer: createOpenAIReviewer({ model: resolved.deployment, baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey, authHeader: endpoint.authHeader, maxOutputTokens, effort }),
    record: { ...base, model: resolved.deployment, deployment: resolved.deployment, alias: resolved.alias, provider: resolved.provider, api: "responses", authHeader: endpoint.authHeader, probed: resolved.probed, servedAtProbe: resolved.servedAtProbe },
    prices: {},
    appearsIn: endpoint.appearsIn,
  };
}

/**
 * A short folder for the reviews' workDirs: the system temp folder when its
 * path is short, else /tmp, so <workDir>/scratch/tmp stays within the 64
 * characters TFLint's socket path allows. The caller removes it.
 */
export function makeWorkRoot() {
  const base = tmpdir().length <= 24 ? tmpdir() : "/tmp";
  return mkdtempSync(join(base, "oqb-"));
}

// ---------- the clone, before and after ----------

function gitOut(dir, args) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, env: gitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 30 });
}

// The clone's head, refs and work tree, ignored files included.
function cloneState(dir) {
  return {
    head: gitOut(dir, ["rev-parse", "HEAD"]).trim(),
    refs: gitOut(dir, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    tree: gitOut(dir, ["status", "--porcelain=v1", "--ignored", "-uall", "-z"]),
  };
}

// What changed in the clone during the review, one line each (failure 1).
function cloneChanges(before, after) {
  const out = [];
  if (before.head !== after.head) out.push(`the clone's HEAD moved from ${before.head.slice(0, 12)} to ${after.head.slice(0, 12)}`);
  if (before.refs !== after.refs) out.push("the clone's refs changed");
  if (before.tree !== after.tree) {
    const was = new Set(before.tree.split("\0").filter(Boolean));
    const now = after.tree.split("\0").filter((e) => e !== "" && !was.has(e));
    out.push(`the clone's work tree changed: ${now.slice(0, 5).map((e) => e.slice(3)).join(", ") || "an entry went away"}${now.length > 5 ? ", ..." : ""}`);
  }
  return out;
}

const within = (child, parent) => {
  const real = (p) => (existsSync(p) ? realpathSync(p) : resolve(p));
  const r = relative(real(parent), real(child));
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};

// ---------- one attempt ----------

/**
 * One server review of a materialised case, saved in its attempt folder
 * under `out`. `repo` is { dir, base, head } (lib/suites.mjs materialise in
 * the server shape); `meter` is the review's meter (lib/budget.mjs:
 * authorize and wrap); `hide(text)` replaces machine paths in what is
 * saved; `stopped()` names why the run is halting, if it is. Returns
 * { record, error }: the sample record, and what the review threw, if it
 * threw. Throws before any review when the work root lies in the clone or
 * the results folder.
 */
export async function serverAttempt({ reviewChange, job, attempt, out, repo, reviewer, meter, deadlineMs, workRoot, installRoot, hide = (t) => t, stopped = () => null }) {
  for (const [what, dir] of [["the clone", repo.dir], ["the results folder", out]]) {
    if (within(workRoot, dir)) throw new Error(`the work root ${workRoot} lies in ${what} (${dir}); a review writes only in a workDir of its own, outside both`);
  }
  const sampleDir = attemptDir(out, job, attempt);
  mkdirSync(sampleDir, { recursive: true });
  const workDir = mkdtempSync(join(workRoot, "r"));
  // The machine paths a saved text may hold, longest first.
  const swaps = [
    [workDir, "<work>"],
    [realpathSync(workDir), "<work>"],
    [repo.dir, "<repo>"],
    [realpathSync(repo.dir), "<repo>"],
  ].sort((a, b) => b[0].length - a[0].length);
  const before = cloneState(repo.dir);
  const progress = [];
  const startedAt = new Date().toISOString();
  const started = Date.now();
  let result = null;
  let error = null;
  try {
    result = await reviewChange(
      { clonePath: repo.dir, mergeBaseSha: repo.base, headSha: repo.head },
      meter.wrap(reviewer),
      { profile: "server", workDir, installRoot, budget: { authorize: meter.authorize, deadlineMs }, tools: { web: false, shell: false }, scanners: "preinstalled", onProgress: (line) => progress.push(line) },
    );
  } catch (e) {
    error = e;
  }
  const wallMs = Date.now() - started;
  const outside = cloneChanges(before, cloneState(repo.dir));
  rmSync(workDir, { recursive: true, force: true });
  const clean = (text) => hide(swaps.reduce((t, [path, label]) => t.split(path).join(label), String(text)));
  const save = (path, text) => {
    mkdirSync(dirname(join(sampleDir, path)), { recursive: true });
    writeFileSync(join(sampleDir, path), clean(text));
  };
  const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
  let report = null;
  if (result !== null) {
    const rendered = result.render.json();
    save("report/report.json", rendered);
    save("report/report.md", result.render.markdown());
    if (result.scan) save("report/scan.json", json(result.scan));
    save("usage.json", json(result.usage));
    save("completion.json", json(result.completion));
    save("dispositions.json", json(result.dispositions));
    save("rounds.json", json(result.rounds));
    report = JSON.parse(rendered);
  }
  save("progress.txt", progress.map((l) => `${l}\n`).join(""));
  const record = serverSampleRecord({ job, attempt, startedAt, wallMs, result, report, error, outside, stopped: stopped(), requested: reviewer.model });
  save("sample.json", json(record));
  return { record, error };
}

// The models the provider named as answering, from the library's usage
// records: every one named, and the one named when every answered call
// named that one (failure 3).
function servedOf(result) {
  const answered = (result?.usage?.calls ?? []).filter((c) => c.outcome === "ok");
  const named = answered.map((c) => (typeof c.servedModel === "string" && c.servedModel !== "" ? c.servedModel : null));
  const servedModels = [...new Set(named.filter((n) => n !== null))];
  const servedModel = named.length > 0 && servedModels.length === 1 && named.every((n) => n === servedModels[0]) ? servedModels[0] : null;
  return { servedModel, servedModels };
}

/** The saved record of one server attempt, whatever happened to it. */
export function serverSampleRecord({ job, attempt, startedAt, wallMs, result, report, error, outside = [], stopped = null, requested }) {
  const status = result === null ? "failed" : result.status === "incomplete" ? "incomplete" : "complete";
  const reasons = [...(error ? [`the review threw: ${String(error?.message ?? error).split("\n")[0]}`] : []), ...(result?.status === "incomplete" ? [result.reason ?? "incomplete"] : []), ...outside.map((o) => `the review wrote outside its workDir: ${o}`)];
  const t = result?.usage?.totals ?? null;
  return {
    jobId: job.jobId ?? null,
    caseId: job.caseId ?? null,
    firstAttempt: attempt === 1,
    case: job.case,
    config: job.config,
    reviewer: job.reviewer,
    path: "server",
    graph: "on",
    repeat: job.repeat,
    attempt,
    started_at: startedAt,
    exit: null,
    signal: null,
    wallMs,
    status,
    // The library's own status: complete, complete_blocking or incomplete.
    resultStatus: result?.status ?? null,
    failure: reasons.length > 0 ? reasons.join("; ") : null,
    stopped: stopped ?? null,
    verdict: report?.verdict ?? null,
    requestedModel: requested ?? null,
    ...servedOf(result),
    findings: report && Array.isArray(report.findings) ? report.findings.length + (report.outside_change?.length ?? 0) : result ? result.findings.length : null,
    usage: t ? { calls: t.attempts, input_tokens: t.inputTokens, output_tokens: t.outputTokens, cache_read_tokens: t.cacheReadTokens, cost_usd: t.costUsd } : null,
    reviewerMs: result?.timings?.reviewer_ms ?? null,
    rounds: result ? result.rounds.length : null,
    graphStatus: report?.impact?.status ?? null,
    graphMs: report?.impact?.build?.durationMs ?? null,
    scanners: scannerRows(result?.scan?.scanners ?? report?.scanners ?? []),
    scope: result?.scope ?? null,
    notes: result?.notes ?? [],
    outside,
    // The product's phase times, as the result gives them.
    timings: result?.timings ?? null,
  };
}
