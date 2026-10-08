#!/usr/bin/env node
// The optional wording pass: a model reads each finding that the script
// already matched to a planted bug and says, for its problem, consequence
// and fix sentences, whether each is plain and whether it is correct
// against the planted truth. It judges wording only. Its verdict is
// reported and never blocks: score.mjs never reads it, and this script
// exits 0 whatever the verdicts are.
//
//   node benchmark/judge.mjs <results folder> [--model claude-sonnet-5]
//                            [--configs a,b] [--limit <reviews>] [--resume]
//                            [--specs <folder of <case>.json>]
//
// The findings judged are those the scorer matches to a planted bug, by the
// run's own specs unless --specs names others (as score.mjs does).
//
// Writes judge.json into the results folder (raw answers in judge-raw/).
//
// Failure list, written before the code:
// 1. The verdict ends up gating a release: nothing reads judge.json, and the
//    exit code is 0 after any judged run (2 for bad input, 1 only when a
//    limit or a login wall stopped it).
// 2. The model judges whether the bug was found, which the script already
//    decided: it gets only findings matched to a planted bug, with that
//    bug's truth, and answers about the sentences only.
// 3. The answer is not JSON, or names a finding that was not asked about:
//    it is parsed by script; an answer that does not parse is recorded as
//    unparsed and never guessed at.
// 4. The model reads the user's settings, tools or memory: it runs with the
//    reviewer's isolation flags and no tools.
// 5. The reviewer's own model marks its own wording: the judge model is a
//    flag, recorded beside the reviewer's model in judge.json.
// 6. A usage limit or a login wall: the run stops at once and keeps what
//    is judged.
// 7. The pass costs more than meant: one call per review, --limit caps the
//    reviews, and the plan is printed before the first call.
// 8. A second pass judges everything again: --resume keeps every review
//    already judged.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classify, ratio, value } from "./lib/score.mjs";
import { BLOCKED, claudeEnv } from "./lib/reviewers.mjs";

const SENTENCES = ["problem", "consequence", "fix"];

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};
const dirs = (path) => (existsSync(path) ? readdirSync(path, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : []);

function prompt(items) {
  return [
    "You judge the wording of code review findings. A script has already matched each finding below to a planted bug; the planted truth says what the bug is and how to fix it.",
    "You have no tools and no access to the code. Judge from the text below only, and answer at once.",
    "For each finding, judge its three sentences apart:",
    "- plain: short sentences in the active voice, one fact per sentence, every technical word either common or explained, no filler.",
    "- correct: true to the planted truth; for the fix, it would remove the planted bug. A sentence that contradicts the truth or adds a claim the truth makes false is not correct.",
    "Do not judge whether the bug was found or how severe it is.",
    'Answer with JSON only, in this shape: {"verdicts":[{"id":"f1","problem":{"plain":true,"correct":true},"consequence":{"plain":true,"correct":true},"fix":{"plain":true,"correct":true},"note":"one short sentence"}]}',
    "",
    ...items.map((it) => [`Finding ${it.id}`, `Planted truth: ${it.truth}`, `Title: ${it.finding.title}`, `Problem: ${it.finding.problem ?? ""}`, `Consequence: ${it.finding.consequence ?? ""}`, `Fix: ${it.finding.fix ?? ""}`, ""].join("\n")),
  ].join("\n");
}

function ask(model, text) {
  const args = [
    "-p",
    "--output-format", "json",
    "--model", model,
    "--setting-sources", "",
    "--settings", JSON.stringify({ autoMemoryEnabled: false, hooks: {}, disableAllHooks: true }),
    "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} }),
    "--disable-slash-commands",
    "--no-session-persistence",
    "--tools", "",
  ];
  return new Promise((done) => {
    const child = spawn("claude", args, { env: claudeEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 300_000);
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    // claude missing or not startable: an answer with the reason, not a crash.
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ code: null, stdout: "", stderr: `could not start claude: ${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
    child.stdin.end(text);
  });
}

// The verdicts in the model's answer, by finding id; null when it does not parse.
export function parseVerdicts(answer, ids) {
  const text = String(answer ?? "");
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const body = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  let doc;
  try {
    doc = JSON.parse(body);
  } catch {
    return null;
  }
  if (!Array.isArray(doc?.verdicts)) return null;
  const out = {};
  for (const v of doc.verdicts) {
    if (!ids.includes(v?.id)) continue;
    const ok = SENTENCES.every((s) => typeof v[s]?.plain === "boolean" && typeof v[s]?.correct === "boolean");
    if (ok) out[v.id] = { ...Object.fromEntries(SENTENCES.map((s) => [s, { plain: v[s].plain, correct: v[s].correct }])), note: typeof v.note === "string" ? v.note : null };
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  let model = "claude-sonnet-5";
  let configs = null;
  let limit = Infinity;
  let resumeRun = false;
  let specsDir = null;
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--model") model = args[++i];
    else if (args[i] === "--configs") configs = args[++i].split(",");
    else if (args[i] === "--limit") limit = Number(args[++i]);
    else if (args[i] === "--resume") resumeRun = true;
    else if (args[i] === "--specs") specsDir = resolve(args[++i]);
    else pos.push(args[i]);
  }
  if (pos.length !== 1 || !model || !(limit > 0)) {
    console.error("usage: node benchmark/judge.mjs <results folder> [--model claude-sonnet-5] [--configs a,b] [--limit <reviews>] [--resume]");
    process.exit(2);
  }
  const folder = resolve(pos[0]);
  const manifest = readJson(join(folder, "manifest.json"));
  if (!manifest) {
    console.error(`${folder} has no manifest.json; it is not a benchmark run`);
    process.exit(2);
  }
  const outPath = join(folder, "judge.json");
  const earlier = resumeRun ? readJson(outPath) : null;
  const doc = earlier ?? { version: 1, specs: specsDir ?? "the run's own cases/", model, reviewerModel: manifest.reviewer?.model ?? null, at: new Date().toISOString(), samples: [] };
  const judged = new Set(doc.samples.map((s) => `${s.case}/${s.config}/${s.repeat}`));

  const work = [];
  for (const c of dirs(join(folder, "samples"))) {
    const spec = readJson(join(specsDir ?? join(folder, "cases"), `${c}.json`));
    if (!spec) continue;
    for (const config of dirs(join(folder, "samples", c))) {
      if (configs && !configs.includes(config)) continue;
      for (const n of dirs(join(folder, "samples", c, config))) {
        if (judged.has(`${c}/${config}/${n}`)) continue;
        const report = readJson(join(folder, "samples", c, config, n, "report", "report.json"));
        if (!report) continue;
        const items = [];
        for (const f of [...(report.findings ?? []), ...(report.outside_change ?? [])]) {
          const m = classify(f, spec);
          if (m.outcome !== "hit") continue;
          const bug = spec.bugs.find((b) => b.id === m.bug);
          items.push({ id: `f${items.length + 1}`, bug: bug.id, truth: bug.truth, finding: f });
        }
        if (items.length > 0) work.push({ case: c, config, repeat: Number(n), items });
      }
    }
  }
  const todo = work.slice(0, limit);
  console.log(`Wording pass with ${model}: ${todo.length} reviews, ${todo.reduce((n, w) => n + w.items.length, 0)} findings matched to planted bugs. The verdict is reported and never blocks.`);

  mkdirSync(join(folder, "judge-raw"), { recursive: true });
  let stopped = null;
  for (const w of todo) {
    const r = await ask(model, prompt(w.items));
    writeFileSync(join(folder, "judge-raw", `${w.case}-${w.config}-${w.repeat}.json`), r.stdout || r.stderr);
    let result = null;
    try {
      result = JSON.parse(r.stdout);
    } catch {
      result = null;
    }
    const text = String(result?.result ?? r.stderr ?? "");
    if (!result || result.is_error === true) {
      if (BLOCKED.test(text)) {
        stopped = `the judge model stopped: ${text.slice(0, 200)}`;
        break;
      }
    }
    const verdicts = result && result.is_error !== true ? parseVerdicts(result.result, w.items.map((i) => i.id)) : null;
    doc.samples.push({
      case: w.case,
      config: w.config,
      repeat: w.repeat,
      costUsd: result?.total_cost_usd ?? null,
      parsed: verdicts !== null,
      findings: w.items.map((i) => ({ bug: i.bug, title: i.finding.title, verdict: verdicts?.[i.id] ?? null })),
    });
    writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`);
  }

  // Totals per configuration: each sentence's plain and correct share.
  const totals = {};
  for (const s of doc.samples) {
    totals[s.config] ??= { findings: 0, unparsed: 0, costUsd: 0, ...Object.fromEntries(SENTENCES.map((k) => [k, { plain: ratio(), correct: ratio() }])) };
    const t = totals[s.config];
    t.costUsd += s.costUsd ?? 0;
    for (const f of s.findings) {
      t.findings++;
      if (!f.verdict) {
        t.unparsed++;
        continue;
      }
      for (const k of SENTENCES) {
        t[k].plain.of++;
        t[k].correct.of++;
        if (f.verdict[k].plain) t[k].plain.hit++;
        if (f.verdict[k].correct) t[k].correct.hit++;
      }
    }
  }
  doc.totals = totals;
  writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`);
  const pct = (r) => `${r.hit}/${r.of}${r.of ? ` (${Math.round(value(r) * 100)}%)` : ""}`;
  console.log(`\n| Configuration | Findings | Problem plain / correct | Consequence plain / correct | Fix plain / correct | Unparsed | Judge cost |`);
  console.log(`|---|---|---|---|---|---|---|`);
  for (const [config, t] of Object.entries(totals)) {
    console.log(`| ${config} | ${t.findings} | ${pct(t.problem.plain)} / ${pct(t.problem.correct)} | ${pct(t.consequence.plain)} / ${pct(t.consequence.correct)} | ${pct(t.fix.plain)} / ${pct(t.fix.correct)} | ${t.unparsed} | $${t.costUsd.toFixed(2)} |`);
  }
  console.log(`\nSaved: ${outPath} (judged by ${model}; the reviewer was ${JSON.stringify(doc.reviewerModel)}). This verdict never blocks.`);
  if (stopped) {
    console.error(`Stopped: ${stopped}`);
    process.exit(1);
  }
}

// Run as a script, not imported: Node gives import.meta.url the real path, so argv[1] is compared by its real path.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
