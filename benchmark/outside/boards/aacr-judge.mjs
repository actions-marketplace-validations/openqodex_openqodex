#!/usr/bin/env node
// The evaluation step of benchmark/outside/boards/aacr.sh: AACR-Bench's own
// evaluator (`python -m pipeline run --stage eval`, at the pinned commit)
// on each folder the converter wrote, with the judge's settings in the
// environment variables their evaluator reads, JUDGE_BASE_URL,
// JUDGE_API_KEY and JUDGE_MODEL. The base URL and key come from
// lib/model-env.mjs; JUDGE_MODEL is the deployment boards.json names as
// AACR's judge (boards.aacr.judge.deployment), which must be probed.
//
//   node benchmark/outside/boards/aacr-judge.mjs <run> --evaluation <their evaluation dir>
//        --python <their venv python> [--rounds N] [--dry-run]
//
// Failure list, written before the code:
// 1. The key or base URL is echoed: they live in this process and in the
//    relay only, never in argv, a shell variable or a file.
//    Everything the evaluator prints passes through a filter that replaces
//    them before it reaches the terminal or eval.log, and every file under
//    outside/aacr/ is checked for them afterwards; a hit fails the step
//    without naming the value. A dry run loads and checks the settings and
//    prints the commands with the values hidden, and starts nothing.
// 2. AACR's mock judge scores a run as if a model judged it: JUDGE_USE_MOCK
//    set in the environment is refused; their checkout must hold no .env
//    (their evaluator reads it and could switch to mock); the evaluator's
//    own mode line must say a model answered, and each failed judge call
//    (which their evaluator counts as no match) is counted. eval.json
//    records both, and score.mjs reports semantic numbers only for a
//    folder with mode llm and no failed call.
// 3. Another commit's evaluator scores the run: the checkout's HEAD must be
//    the commit boards.json pins.
// 4. An evaluation mixes with an earlier one: a run with eval.json is
//    refused, and eval.json names the metrics files each folder's run wrote.
// From the review of PR 155:
// 5. A crash of the evaluator writes a core file holding the key and base
//    URL outside the folder checked for leaks: the evaluator runs with a
//    core file limit of zero (Node cannot set a resource limit, so a shell
//    sets it and then becomes the evaluator); a dry run reports the limit
//    the evaluator would get.
// 6. A modified evaluator runs while eval.json records the pinned commit:
//    every working file must match the pinned tree, including edits
//    hidden from git and ignored files. A dry run checks it too. eval.json
//    records its commit and tree.
// 7. Files leave the run through a symbolic link: everything is written in
//    lib/aacr-board.mjs boardFolder(run).
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AACR_BOARD, AACR_K, AACR_READER, boardFolder } from "../../lib/aacr-board.mjs";
import { checkoutState, leaksIn, redactor } from "../../lib/board-files.mjs";
export { checkoutState, redactor };
import { checkRelay, startRelay } from "../../lib/aacr-relay.mjs";
export { startRelay };
import { endpointSecrets, loadModelEnv, modelEnvPath, probedDeployment } from "../../lib/model-env.mjs";

const BOARDS = JSON.parse(readFileSync(new URL("../boards.json", import.meta.url), "utf8"));
// Their evaluator's own words (evaluate.judge_mode_description, judge.match_semantic's error log).
const MODE_LLM = "LLM（真实裁判模型）";
const MODE_MOCK = "Mock（本地相似度）";
const JUDGE_FAILED = "裁判模型调用失败";

const shown = (p) => (p.startsWith(`${homedir()}/`) ? `~${p.slice(homedir().length)}` : p);

/** The judge's deployment for AACR, from boards.json, refused unless probed. */
export function aacrJudge(boards = BOARDS) {
  const key = boards.boards?.aacr?.judge?.deployment;
  const d = key ? boards.deployments?.[key] : undefined;
  if (!d) throw new Error(`refused: boards.json names no deployment for AACR's judge (boards.aacr.judge.deployment ${JSON.stringify(key ?? null)})`);
  return { key, ...probedDeployment(d.id, { boards }) };
}

/** A command run with core files off: a shell sets the limit to zero, then becomes the command. */
export const withoutCore = (command, args) => ["/bin/sh", ["-c", 'ulimit -c 0 && exec "$0" "$@"', command, ...args]];

const filesUnder = (dir) => readdirSync(dir, { recursive: true }).map((p) => join(dir, String(p))).filter((p) => statSync(p).isFile());

export function run(command, args, { cwd, env, log, secrets }) {
  return new Promise((done) => {
    const file = createWriteStream(log);
    const sink = (t) => {
      process.stdout.write(t);
      file.write(t);
    };
    const out = redactor(secrets, sink);
    const err = redactor(secrets, sink);
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (c) => out.write(c));
    child.stderr.on("data", (c) => err.write(c));
    child.on("close", (code, signal) => {
      out.end();
      err.end();
      file.end(() => done({ code, signal }));
    });
  });
}

export async function main(argv = process.argv.slice(2)) {
  let folder = null;
  let rounds = 3;
  let dry = false;
  let evaluation = null;
  let python = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--rounds") rounds = Number(argv[++i]);
    else if (argv[i] === "--dry-run") dry = true;
    else if (argv[i] === "--evaluation") evaluation = argv[++i];
    else if (argv[i] === "--python") python = argv[++i];
    else if (folder === null && !argv[i].startsWith("--")) folder = resolve(argv[i]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (folder === null || evaluation === null || python === null) throw new Error("usage: aacr-judge.mjs <run> --evaluation <dir> --python <path> [--rounds N] [--dry-run]");
  if (!Number.isInteger(rounds) || rounds < 1) throw new Error("--rounds takes a whole number of at least 1");
  if (process.env.JUDGE_USE_MOCK !== undefined) throw new Error("refused: JUDGE_USE_MOCK is set; the wrapper never runs AACR's mock judge, which scores a run as if a model judged it. Unset it.");
  const out = boardFolder(folder);
  if (!existsSync(join(out, "convert.json"))) throw new Error(`${out} holds no convert.json; aacr.sh converts the run first`);
  const convert = JSON.parse(readFileSync(join(out, "convert.json"), "utf8"));
  if (convert.commit !== AACR_BOARD.commit) throw new Error(`${out}/convert.json was written for AACR-Bench at ${convert.commit}, and boards.json now pins ${AACR_BOARD.commit}; convert the run again`);
  let checkout = null;
  if (existsSync(evaluation)) {
    if (existsSync(join(evaluation, ".env"))) throw new Error(`${shown(join(evaluation, ".env"))} exists; their evaluator would read it and could answer with its mock judge. Move it to the Trash.`);
    const state = checkoutState(dirname(evaluation));
    if (state.problems.length > 0) throw new Error(`their checkout ${shown(dirname(evaluation))} is not the pinned commit as it stands: ${state.problems.join("; ")}. Their code is never patched: move the checkout to the Trash and run aacr.sh --prepare`);
    if (state.commit !== AACR_BOARD.commit) throw new Error(`their checkout is at ${state.commit || "no commit"}, not the commit boards.json pins (${AACR_BOARD.commit})`);
    checkout = state;
  }
  const judge = aacrJudge();
  // Refuses, naming the file or the field and never a value, when the settings are missing.
  const settings = loadModelEnv();
  const secrets = endpointSecrets(settings.baseUrl, settings.apiKey);
  const dataset = join(out, "dataset.jsonl");
  const argsOf = (f) => ["-B", "-m", "pipeline", "run", "--stage", "eval", "--reviewer", AACR_READER, "--dataset", dataset, "--results-dir", join(out, f.dir), "--run-id", f.tool, "--line-k", String(AACR_K), "--eval-rounds", String(rounds)];
  const where = (p) => relative(process.cwd(), p) || ".";

  if (dry) {
    console.log(`Dry run: their evaluator at ${AACR_BOARD.commit.slice(0, 12)} would run ${convert.folders.length} times, from ${shown(evaluation)}${existsSync(join(evaluation, "evaluate.py")) ? "" : " (not fetched yet; aacr.sh fetches it)"}:`);
    for (const f of convert.folders) console.log(`  ${shown(python)} ${argsOf(f).map((a) => (a.startsWith("/") ? shown(a) : a)).join(" ")}`);
    console.log(`with JUDGE_MODEL=${judge.id} (the deployment boards.json names "${judge.key}", probed ${judge.probed}), and a loopback relay for JUDGE_BASE_URL with a random placeholder JUDGE_API_KEY. The relay reads ${shown(modelEnvPath())} (values hidden), sends the key in ${settings.authHeader}, and removes chat_template_kwargs, temperature and top_p, and renames max_tokens to max_completion_tokens. GPT-5.2 uses its default sampling parameters instead of AACR's temperature 0.7 and top_p 0.95.`);
    // The limit the evaluator would get, read by a shell started the same way.
    const [sh, probe] = withoutCore("/bin/sh", ["-c", "ulimit -c"]);
    console.log(`core file limit for the evaluator: ${spawnSync(sh, probe, { encoding: "utf8" }).stdout.trim()}. Nothing was started.`);
    return 0;
  }

  if (existsSync(join(out, "eval.json"))) throw new Error(`${out}/eval.json exists: the run was evaluated before. Move outside/aacr to the Trash and run aacr.sh again to evaluate it anew.`);
  if (!existsSync(dataset)) throw new Error(`${dataset} is missing; aacr.sh writes it from their dataset converter`);
  if (!existsSync(join(evaluation, "evaluate.py")) || !existsSync(python)) throw new Error(`their evaluator or its python is not in ${shown(evaluation)}; run benchmark/outside/boards/aacr.sh --prepare`);

  // The child's environment: ours without any judge or OpenAI setting, plus the three their judge reads.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(JUDGE_|OPENAI_|AZURE_OPENAI_)/.test(k)));
  const relay = await startRelay(settings);
  try {
    try {
      await checkRelay(relay, judge.id);
    } catch (error) {
      let message = "";
      const filter = redactor(secrets, (text) => (message += text));
      filter.write(error.message);
      filter.end();
      throw new Error(message.replace(/[\r\n]+/g, " "));
    }
    Object.assign(env, { JUDGE_BASE_URL: relay.baseUrl, JUDGE_API_KEY: relay.apiKey, JUDGE_MODEL: judge.id, PYTHONDONTWRITEBYTECODE: "1" });
    const version = spawnSync(python, ["--version"], { encoding: "utf8" });
    const startedAt = new Date().toISOString();
    const folders = [];
    for (const f of convert.folders) {
      const dir = join(out, f.dir);
      const before = new Set(readdirSync(dir));
      const log = join(dir, "eval.log");
      console.log(`\n== ${f.tool}: their evaluator, ${rounds} round${rounds === 1 ? "" : "s"} ==`);
      const { code, signal } = await run(...withoutCore(python, argsOf(f)), { cwd: evaluation, env, log, secrets });
      const text = readFileSync(log, "utf8");
      const mode = text.includes(MODE_LLM) ? "llm" : text.includes(MODE_MOCK) ? "mock" : "unknown";
      const metrics = readdirSync(dir).filter((n) => !before.has(n) && /^metrics_ocr_.*\.json$/.test(n) && n !== "metrics_ocr_average.json").sort();
      const requests = /总请求数: (\d+)/.exec(text);
      folders.push({ config: f.config, repeat: f.repeat, tool: f.tool, exit: code, signal, mode, judgeErrors: text.split(JUDGE_FAILED).length - 1, requests: requests ? Number(requests[1]) : null, metrics, log: "eval.log" });
    }
    const leaks = filesUnder(out).filter((p) => leaksIn(readFileSync(p, "latin1"), secrets));
    const record = { version: 1, board: "aacr", repo: AACR_BOARD.repo, commit: AACR_BOARD.commit, checkout: { commit: checkout.commit, tree: checkout.tree }, reader: AACR_READER, lineK: AACR_K, rounds, judge: { deployment: judge.id, boardsKey: judge.key, probed: judge.probed, servedAtProbe: judge.served ?? null }, python: `${version.stdout}${version.stderr}`.trim(), startedAt, endedAt: new Date().toISOString(), relay: relay.counts(), folders };
    writeFileSync(join(out, "eval.json"), `${JSON.stringify(record, null, 2)}\n`);
    const problems = [
      ...folders.filter((f) => f.exit !== 0).map((f) => `${f.tool}: their evaluator exited ${f.exit ?? f.signal}`),
      ...folders.filter((f) => f.mode !== "llm").map((f) => `${f.tool}: the ${f.mode} judge answered, not a model, so its semantic numbers are not reported`),
      ...folders.filter((f) => f.judgeErrors > 0).map((f) => `${f.tool}: ${f.judgeErrors} judge calls failed (see its eval.log); their evaluator counts each as no match, so its semantic numbers are not reported`),
      ...folders.filter((f) => f.metrics.length !== rounds).map((f) => `${f.tool}: ${f.metrics.length} metrics files written, not ${rounds}`),
      ...leaks.map((p) => `${relative(out, p)} holds the judge's key or base URL; move outside/aacr to the Trash`),
    ];
    console.log(`\neval.json written: ${join(out, "eval.json")}. Score it with node benchmark/score.mjs ${where(folder)} --outside aacr.`);
    if (problems.length > 0) {
      console.error(problems.join("\n"));
      return 1;
    }
    return 0;
  } finally {
    await relay.close();
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error.message);
      process.exit(2);
    },
  );
}
