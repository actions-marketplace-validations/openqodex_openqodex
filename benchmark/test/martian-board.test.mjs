// Martian's offline Code Review Bench as an outside board: a saved run's
// samples on Martian cases as Martian's benchmark_data entries
// (benchmark/outside/convert/martian.mjs), the wrapper that runs Martian's
// own pipeline on them with the judge settings (benchmark/outside/boards/
// martian.sh and martian-judge.mjs), and the evaluation.json it writes for
// lib/score.mjs readMartianEvaluation.
//
// The cases here are Martian-shaped pull requests written for these tests
// (benchmark/outside/fixtures/martian/golden.json), ingested into a suite
// in a temp folder with every GitHub answer in a temp cache: no Martian
// pull request, and nothing reaches the network. The one stand-in is a
// model provider on this machine for Martian's judge. Both are built in
// martian-board-fixture.mjs.
//
// Failures guarded, each test written before the code:
// 1. A run that is not a release run reads Martian's cases, which are all
//    held out.
// 2. A finding without a title, problem, consequence or fix is dropped, so
//    the judge judges less than the review wrote: the sample is held,
//    recorded, and never sent with a hole.
// 3. One finding extracted into two issues, or one candidate matched to two
//    golden comments, loses a match on the way to evaluation.json (and the
//    reader refuses an evaluation that lost one).
// 4. The wrapper echoes the judge's key or base URL.
// 5. The converted entries are not what Martian's evaluator accepts: a
//    saved fixture of three samples converts byte for byte to the saved
//    benchmark_data.json, and Martian's own pipeline at the pinned commit
//    judges it with errors_count 0 (when its checkout is in the cache).
// Also, as for AACR-Bench (PR 155): a held-out access goes unlogged; a case
// whose licence nobody verified is converted for a board; a failed or
// never-started review vanishes from Martian's denominators; two
// configurations go by one tool name; result files leave the run through a
// symbolic link; a modified evaluator runs as the pinned one; the bench
// cache lies in the repository.
// From the review of PR 161 (each test checked red by taking its guard out):
// 6. A forged or local manifest reads the golden comments by naming a
//    release: the run must have reviewed the published package of that
//    release, as the npm registry confirms (a saved answer stands in for it).
// 7. A conversion made outside the gate, or of another manifest, is judged.
// 8. A secret reaches the terminal or a log in pieces, or URL-encoded.
// 9. A file marked assume-unchanged, or an ignored file, hides an edit of
//    the evaluator.
// 10. A link under the bench cache puts their checkout in the repository.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { benchRoot, git, repoRoot } from "../lib/cases.mjs";
import { checkoutState, leaksIn, redactor } from "../lib/board-files.mjs";
import { cacheRoot } from "../lib/licence.mjs";
import { MARTIAN_BOARD, martianBody, martianEvaluations } from "../lib/martian-board.mjs";
import { endpointSecrets } from "../lib/model-env.mjs";
import { findingId, martianFindings, martianGolden, readMartianEvaluation } from "../lib/score.mjs";
import { readCase, truthOf } from "../lib/suites.mjs";
import { convertRun } from "../outside/convert/martian.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";
import { CLAUDE, COMMIT, convertOpts, fakeProvider, finding, FIXTURES, fixturePlan, fixtureReport, GOLDEN, MODEL, PACKAGE, readJson, RELEASE, REPORTS, report, savedRun, suite, write } from "./martian-board-fixture.mjs";

afterAll(removeTempDirs);

const WRAPPER = join(benchRoot, "outside", "boards", "martian.sh");
const JUDGE = join(benchRoot, "outside", "boards", "martian-judge.mjs");
const RECORD = process.env.MARTIAN_BOARD_RECORD === "1";

const filesUnder = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map((p) => join(dir, String(p))).filter((p) => statSync(p).isFile()) : []);
const refusal = async (fn) => {
  try {
    await fn();
  } catch (error) {
    return error.message;
  }
  return null;
};

// ---------- the tests ----------

describe("a run that is not a release run reads Martian's cases", () => {
  it("refuses a run whose manifest names no release, and a smoke run, before any truth is read or any access logged", async () => {
    const ctx = await suite();
    for (const settings of [{ release: null }, { release: undefined }, { release: "" }, { smoke: true }]) {
      const out = await savedRun(ctx, { plan: fixturePlan(), settings });
      const opts = convertOpts(ctx);
      const why = await refusal(() => convertRun(out, opts));
      expect(why, JSON.stringify(settings)).toMatch(settings.smoke ? /smoke/ : /release/);
      expect(existsSync(join(out, "outside"))).toBe(false);
      expect(existsSync(opts.accessLog)).toBe(false);
    }
  });

  it("logs a release run's access to the held-out cases first, one line, and refuses when the log cannot be written", async () => {
    const ctx = await suite();
    const out = await savedRun(ctx, { plan: fixturePlan() });
    const blocked = join(tempDir("oq-martian-board-index-"), "heldout-access.jsonl");
    mkdirSync(blocked);
    expect(await refusal(() => convertRun(out, convertOpts(ctx, { accessLog: blocked })))).toMatch(/held-out access/);
    expect(existsSync(join(out, "outside"))).toBe(false);
    const opts = convertOpts(ctx, { now: () => "2026-10-11T12:00:00.000Z" });
    await convertRun(out, opts);
    const lines = readFileSync(opts.accessLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toEqual([{ at: "2026-10-11T12:00:00.000Z", suite: "martian", caseCount: 3, purpose: "release-run", runId: "martian-board-test", release: RELEASE, by: "tester" }]);
  });

  it("refuses a release that is not the published package the run reviewed, as the npm registry confirms, before anything is read or logged", async () => {
    const ctx = await suite();
    const forged = [
      [{ package: { spec: "local", commit: "a".repeat(40), dirty: false } }, null, /local build/],
      [{ package: undefined }, null, /no package record/],
      [{ package: { ...PACKAGE, version: "0.11.0", spec: "npm:0.11.0" } }, null, /0\.11\.0/],
      [{ release: "0.11.0" }, null, /0\.12\.0/],
      [{ package: { ...PACKAGE, integrity: "sha512-forged", registryIntegrity: "sha512-forged" } }, null, /integrity/],
      [{}, async () => ({ name: "openqodex", version: RELEASE, dist: { integrity: "sha512-another" } }), /registry[^\n]*integrity sha512-another/],
      [
        {},
        async () => {
          throw new Error("it answered 503");
        },
        /registry[^\n]*could not confirm[^\n]*503/,
      ],
    ];
    for (const [settings, registry, why] of forged) {
      const out = await savedRun(ctx, { plan: fixturePlan(), settings });
      const opts = convertOpts(ctx, registry ? { registry } : {});
      expect(await refusal(() => convertRun(out, opts)), JSON.stringify(settings)).toMatch(why);
      expect(existsSync(join(out, "outside"))).toBe(false);
      expect(existsSync(opts.accessLog)).toBe(false);
    }
  });
});

describe("a conversion made outside the gate, or of another manifest, is judged", () => {
  const judgeDry = (out, accessLog) => {
    const home = tempDir("oq-martian-board-gate-");
    writeFileSync(join(home, "azure.env"), "AZURE_OPENAI_BASE_URL=https://judge.example.test/v1\nAZURE_OPENAI_KEY=fake-key\n");
    return spawnSync(process.execPath, [JUDGE, out, "--dry-run", "--checkout", join(home, "offline"), "--python", join(home, "venv", "bin", "python")], { encoding: "utf8", env: { ...process.env, OPENQODEX_BENCH_MODEL_ENV: join(home, "azure.env"), OPENQODEX_BENCH_ACCESS_LOG: accessLog }, timeout: 60_000 });
  };

  it("refuses to judge when the run's manifest changed after the conversion, or the access line is not in the log", async () => {
    const ctx = await suite();
    const out = await savedRun(ctx, { plan: fixturePlan() });
    const opts = convertOpts(ctx);
    await convertRun(out, opts);
    expect(readJson(join(out, "outside", "martian", "convert.json")).manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    const ok = judgeDry(out, opts.accessLog);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/release gate runs again/);
    // An access log without the conversion's line.
    const other = join(tempDir("oq-martian-board-index-"), "heldout-access.jsonl");
    writeFileSync(other, readFileSync(opts.accessLog, "utf8").replace(/"by":"tester"/, '"by":"someone else"'));
    const unlogged = judgeDry(out, other);
    expect(unlogged.status).toBe(2);
    expect(unlogged.stderr).toMatch(/access[^\n]*not in/);
    // A manifest edited after the conversion.
    const manifest = readJson(join(out, "manifest.json"));
    writeFileSync(join(out, "manifest.json"), `${JSON.stringify({ ...manifest, release: "9.9.9" }, null, 2)}\n`);
    const edited = judgeDry(out, opts.accessLog);
    expect(edited.status).toBe(2);
    expect(edited.stderr).toMatch(/manifest is not the one/);
  });
});

describe("a finding without a title, problem, consequence or fix is dropped", () => {
  it("holds the sample and its tool name, names the finding and what it lacks, and sends neither with a hole", async () => {
    const ctx = await suite();
    const plan = fixturePlan();
    plan[`${CLAUDE}/1`] = { "oq-fixture__shop-12": report({ findings: [finding(), finding({ title: "Second", fix: "  " })] }) };
    const out = await savedRun(ctx, { plan, configs: [MODEL, CLAUDE] });
    const { record, data } = await convertRun(out, convertOpts(ctx));
    const caseId = ctx.ids.get("oq-fixture__shop-12");
    expect(record.held).toEqual([{ tool: "openqodex-cli-claude-r1", caseId, case: "oq-fixture__shop-12", goldenUrl: "https://github.com/oq-fixture/shop/pull/12", index: 1, findingId: expect.stringMatching(/^[0-9a-f]{64}$/), lacking: ["fix"] }]);
    expect(record.tools.find((t) => t.tool === "openqodex-cli-claude-r1")).toMatchObject({ held: true, why: expect.stringMatching(/fix/) });
    expect(record.tools.find((t) => t.tool === "openqodex-library-r1")).toMatchObject({ held: false, why: null, reviews: 3 });
    // No review of the held tool name goes to the judge, not even the two without a finding.
    for (const entry of Object.values(data)) expect(entry.reviews.map((r) => r.tool)).toEqual(["openqodex-library-r1"]);
    expect(readJson(join(out, "outside", "martian", "benchmark_data.json"))).toEqual(data);
  });
});

describe("a case whose licence nobody verified, or a sample outside Martian, is converted for the board", () => {
  it("refuses a run holding a case whose licence class is unverified, naming it, and writes and logs nothing", async () => {
    const ctx = await suite(GOLDEN, { "oq-fixture/ledger": "NOASSERTION" });
    const out = await savedRun(ctx, { plan: fixturePlan() });
    const opts = convertOpts(ctx);
    const why = await refusal(() => convertRun(out, opts));
    expect(why).toMatch(/oq-fixture__ledger-7/);
    expect(why).not.toMatch(/oq-fixture__shop-11/);
    expect(why).toMatch(/never converted for a board/);
    expect(existsSync(join(out, "outside"))).toBe(false);
    expect(existsSync(opts.accessLog)).toBe(false);
  });

  it("refuses a run of another suite and a sample folder of a case the run did not plan", async () => {
    const ctx = await suite();
    const other = await savedRun(ctx, { plan: fixturePlan(), settings: { suite: "aacr" } });
    expect(await refusal(() => convertRun(other, convertOpts(ctx)))).toMatch(/aacr/);
    const out = await savedRun(ctx, { plan: fixturePlan() });
    write(join(out, "samples", "flask-path-traversal", MODEL, "1", "sample.json"), JSON.stringify({ case: "flask-path-traversal", config: MODEL, repeat: 1, attempt: 1 }));
    expect(await refusal(() => convertRun(out, convertOpts(ctx)))).toMatch(/flask-path-traversal/);
    expect(existsSync(join(out, "outside"))).toBe(false);
  });
});

describe("a failed or never-started review vanishes from Martian's denominators, or two configurations go by one tool name", () => {
  it("writes a review for every planned review's first attempt, empty when it failed or never started and never the retry, under openqodex-<config>-r<n>", async () => {
    const ctx = await suite();
    const plan = {
      [`${MODEL}/1`]: { "oq-fixture__shop-11": "failed", "oq-fixture__shop-12": fixtureReport("oq-fixture__shop-12") },
      [`${CLAUDE}/1`]: { "oq-fixture__ledger-7": "unstarted" },
      [`${MODEL}/2`]: { "oq-fixture__shop-11": "retried" },
    };
    const out = await savedRun(ctx, { plan, configs: [MODEL, CLAUDE], repeat: 2 });
    const { record, data } = await convertRun(out, convertOpts(ctx));
    expect(record.tools.map((t) => [t.tool, t.config, t.reviews, t.held])).toEqual([
      ["openqodex-cli-claude-r1", CLAUDE, 3, false],
      ["openqodex-cli-claude-r2", CLAUDE, 3, false],
      ["openqodex-library-r1", MODEL, 3, false],
      ["openqodex-library-r2", MODEL, 3, false],
    ]);
    const review = (url, tool) => data[url].reviews.find((r) => r.tool === tool);
    const shop11 = "https://github.com/oq-fixture/shop/pull/11";
    expect(Object.keys(data).sort()).toEqual(GOLDEN.map((r) => r.url).sort());
    for (const url of Object.keys(data)) expect(data[url].reviews).toHaveLength(4);
    expect(review(shop11, "openqodex-library-r1")).toMatchObject({ review_comments: [], openqodex: { status: "failed", attempt: 1 } });
    expect(review("https://github.com/oq-fixture/ledger/pull/7", "openqodex-cli-claude-r1")).toMatchObject({ review_comments: [], openqodex: { status: "unstarted" } });
    expect(review(shop11, "openqodex-library-r2")).toMatchObject({ review_comments: [], openqodex: { status: "failed", attempt: 1 } });
    expect(review("https://github.com/oq-fixture/shop/pull/12", "openqodex-library-r1").review_comments).toHaveLength(2);
    // Each entry carries the pinned golden comments verbatim.
    expect(data[shop11].golden_comments).toEqual(GOLDEN[0].comments);
  });

  it("refuses a configuration the board cannot name (graph off) and two configurations that would share a tool name", async () => {
    const ctx = await suite();
    const off = await savedRun(ctx, { plan: {}, configs: ["claude-graph-off"] });
    expect(await refusal(() => convertRun(off, convertOpts(ctx)))).toMatch(/claude-graph-off[^\n]*graph/);
    const two = await savedRun(ctx, { plan: {}, configs: [MODEL, "model-gpt-6.1-sol-graph-on"] });
    expect(await refusal(() => convertRun(two, convertOpts(ctx)))).toMatch(/openqodex-library-r1/);
    expect(existsSync(join(two, "outside"))).toBe(false);
  });
});

describe("result files leave the run through a symbolic link", () => {
  it("refuses to convert when <run>/outside leads out of the run, and writes nothing there", async () => {
    const ctx = await suite();
    const out = await savedRun(ctx, { plan: fixturePlan() });
    const elsewhere = tempDir("oq-martian-board-elsewhere-");
    symlinkSync(elsewhere, join(out, "outside"));
    expect(await refusal(() => convertRun(out, convertOpts(ctx)))).toMatch(/outside the run/);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("refuses to convert a run twice", async () => {
    const ctx = await suite();
    const out = await savedRun(ctx, { plan: fixturePlan() });
    await convertRun(out, convertOpts(ctx));
    expect(await refusal(() => convertRun(out, convertOpts(ctx)))).toMatch(/already/);
  });
});

describe("the saved fixture converts to entries Martian's evaluator accepts", () => {
  it("renders each finding as one paragraph with no list marker or code fence, so extraction cannot split a fix sentence off", () => {
    const body = martianBody(finding({ title: "Loop overruns.", problem: "The loop\nreads past the end.\n\n- and more", consequence: "It throws.", fix: "```js\nstop early\n```" }));
    expect(body).toBe("Loop overruns. The loop reads past the end. - and more It throws. Fix: `js stop early `");
    expect(body).not.toMatch(/\n|```/);
  });

  it("converts the three saved reviews to the saved benchmark_data.json, byte for byte", async () => {
    const ctx = await suite();
    const out = await savedRun(ctx, { plan: fixturePlan() });
    await convertRun(out, convertOpts(ctx));
    const written = readFileSync(join(out, "outside", "martian", "benchmark_data.json"), "utf8");
    if (RECORD) write(join(FIXTURES, "benchmark_data.json"), written);
    expect(written).toBe(readFileSync(join(FIXTURES, "benchmark_data.json"), "utf8"));
    const data = JSON.parse(written);
    expect(data["https://github.com/oq-fixture/shop/pull/11"].reviews[0].review_comments[0]).toEqual({
      path: "src/checkout.ts",
      line: 40,
      body: "Coupon can be applied twice. The cart total is read before the discount lock is taken. Also, the refund handler logs the full card number. Both put customers at risk. Fix: Take the discount lock before reading the total, and mask the card number before logging.",
      created_at: "2026-10-11T10:00:00.000Z",
    });
    // A finding outside the change is sent too.
    expect(data["https://github.com/oq-fixture/ledger/pull/7"].reviews[0].review_comments).toHaveLength(1);
  });
});

// What Martian's pipeline wrote for the fixture (recorded/), read into
// evaluation.json the way the wrapper does.
function recordedEvaluation() {
  const r = (name) => readJson(join(FIXTURES, "recorded", name));
  return martianEvaluations({ data: readJson(join(FIXTURES, "benchmark_data.json")), candidates: r("candidates.json"), dedup: r("dedup_groups.json"), evaluations: r("evaluations.json"), totals: r("totals.json"), judge: { model: "gpt-5.2", served: "gpt-5.2" }, model: "gpt-5.2" });
}

// Every finding the fixture sent, and the golden comments of its cases, the
// way a scorer of the run reads them.
async function fixtureTruth() {
  const ctx = await suite();
  const findings = [];
  const golden = [];
  for (const name of [...ctx.ids.keys()].sort()) {
    const id = ctx.ids.get(name);
    findings.push(...martianFindings(id, fixtureReport(name)));
    golden.push(...martianGolden(id, truthOf(readCase(id, { root: ctx.root }), { cache: ctx.cache })));
  }
  return { findings, golden };
}

describe("one finding extracted into two issues, or one candidate matched to two golden comments, loses a match", () => {
  it("keeps both issues of one finding and both golden comments of one candidate, and the reader counts each once", async () => {
    const { tools, problems } = recordedEvaluation();
    expect(problems).toEqual([]);
    expect(tools.map((t) => [t.tool, t.problems])).toEqual([["openqodex-library-r1", []]]);
    const e = tools[0].evaluation;
    const shop11 = "https://github.com/oq-fixture/shop/pull/11";
    const ledger = "https://github.com/oq-fixture/ledger/pull/7";
    // The first finding of shop#11 was extracted into two issues, each matched to its own golden comment.
    const first = findingId(readJson(join(FIXTURES, "benchmark_data.json"))[shop11].openqodex.caseId, REPORTS["oq-fixture__shop-11"].findings[0]);
    expect(e.candidates.filter((c) => c.sourceFindingIds.includes(first)).map((c) => [c.candidateId, c.sourceFindingIds.length])).toEqual([[`${shop11}#0`, 1], [`${shop11}#1`, 1]]);
    expect(e.matches.filter((m) => m.candidateId.startsWith(`${shop11}#`)).map((m) => [m.candidateId, m.goldenId.split("#")[1]])).toEqual([[`${shop11}#0`, "g1"], [`${shop11}#1`, "g2"]]);
    // The one candidate of ledger#7 matched both its golden comments.
    expect(e.matches.filter((m) => m.candidateId === `${ledger}#0`).map((m) => m.goldenId.split("#")[1])).toEqual(["g1", "g2"]);
    // A duplicate of the first issue is grouped with it by Martian's dedup step.
    const cand = (n) => e.candidates.find((c) => c.candidateId === `${shop11}#${n}`);
    expect(cand(2).dedupGroup).toBe(cand(0).dedupGroup);
    expect(cand(1).dedupGroup).not.toBe(cand(0).dedupGroup);
    expect(cand(0).extraction).toEqual({ model: "gpt-5.2", step: "step2_extract_comments", file: "work/results/gpt-5.2/candidates.json" });

    const { findings, golden } = await fixtureTruth();
    const read = readMartianEvaluation(e, { findings, golden });
    expect(read.official).toEqual(e.totals);
    expect(e.totals.all).toMatchObject({ tp: 5, fp: 1, fn: 0, prs: 3 });
    expect(read.ours.golden).toEqual({ found: 5, of: 5 });
    expect(read.ours.findings).toEqual({ sent: 5, matched: 3 });
    expect(read.ours.candidates).toEqual({ extracted: 6, findings: 5 });
    // A conversion that kept one golden comment per candidate would lose ledger#7's second match: the reader refuses it.
    const lossy = { ...e, matches: e.matches.filter((m, i, all) => all.findIndex((x) => x.candidateId === m.candidateId) === i) };
    expect(() => readMartianEvaluation(lossy, { findings, golden })).toThrow(/official totals count 5 golden comments found[^\n]*matches name 4/);
  });

  it("refuses to build an evaluation when a match names a candidate Martian's candidates file does not hold, or a review was judged on other candidates", () => {
    const r = (name) => readJson(join(FIXTURES, "recorded", name));
    const evaluations = r("evaluations.json");
    const shop12 = "https://github.com/oq-fixture/shop/pull/12";
    evaluations[shop12]["openqodex-library-r1"].true_positives[0].matched_candidate = "A candidate nobody extracted";
    const bad = martianEvaluations({ data: readJson(join(FIXTURES, "benchmark_data.json")), candidates: r("candidates.json"), dedup: r("dedup_groups.json"), evaluations, totals: r("totals.json"), judge: { model: "gpt-5.2", served: "gpt-5.2" }, model: "gpt-5.2" });
    expect(bad.tools[0].evaluation).toBeNull();
    expect(bad.tools[0].problems.join("\n")).toMatch(/nobody extracted|not among/);
    const candidates = r("candidates.json");
    delete candidates[shop12];
    const fallback = martianEvaluations({ data: readJson(join(FIXTURES, "benchmark_data.json")), candidates, dedup: r("dedup_groups.json"), evaluations: r("evaluations.json"), totals: r("totals.json"), judge: { model: "gpt-5.2", served: "gpt-5.2" }, model: "gpt-5.2" });
    expect(fallback.tools[0].evaluation).toBeNull();
    expect(fallback.tools[0].problems.join("\n")).toMatch(/shop\/pull\/12[^\n]*no extracted candidates/);
  });
});

describe("the wrapper echoes the judge's key or base URL", () => {
  const KEY = `fake-judge-key-${randomBytes(16).toString("hex")}`;
  const BASE = `https://fake-judge-${randomBytes(4).toString("hex")}.example.test/openai/v1`;

  it("keeps a static guard: set -u, core files off, no trace, no environment dump", () => {
    const text = readFileSync(WRAPPER, "utf8");
    expect(text).toMatch(/^set -euo pipefail$/m);
    expect(text).toMatch(/^ulimit -c 0$/m);
    expect(text).not.toMatch(/set -[a-z]*x|set -o xtrace|\bprintenv\b|\bexport -p\b|\bdeclare -p\b|^\s*env\s*$|MARTIAN_API_KEY|MARTIAN_BASE_URL/m);
  });

  it("leaves nothing of the key, the base URL or its host in its output or any file on a dry run, even traced by bash -x", async () => {
    const ctx = await suite();
    const out = await savedRun(ctx, { plan: fixturePlan() });
    const opts = convertOpts(ctx);
    await convertRun(out, opts);
    const home = tempDir("oq-martian-board-wrapper-");
    writeFileSync(join(home, "azure.env"), `AZURE_OPENAI_BASE_URL=${BASE}\nAZURE_OPENAI_KEY=${KEY}\n`);
    mkdirSync(join(home, "tmp"));
    const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, OPENQODEX_BENCH_MODEL_ENV: join(home, "azure.env"), OPENQODEX_BENCH_ACCESS_LOG: opts.accessLog, TMPDIR: join(home, "tmp") };
    const r = spawnSync("bash", ["-x", WRAPPER, out, "--dry-run"], { encoding: "utf8", env, timeout: 120_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/MARTIAN_MODEL=gpt-5\.2/);
    expect(r.stdout).toMatch(/MARTIAN_BASE_URL and MARTIAN_API_KEY[^\n]*hidden/);
    expect(r.stdout).toMatch(/step2_extract_comments[\s\S]*step2_5_dedup_candidates[\s\S]*step3_judge_comments[\s\S]*score_profiles/);
    expect(r.stdout).toMatch(/core file limit for the pipeline: 0\b/);
    const leaks = [];
    for (const [where, text] of [["stdout", r.stdout], ["stderr", r.stderr], ...[...filesUnder(out), ...filesUnder(join(home, "tmp"))].map((p) => [p, readFileSync(p, "utf8")])]) {
      for (const s of endpointSecrets(BASE, KEY)) if (text.includes(s)) leaks.push(`${where} holds ${s === KEY ? "the key" : "the base URL or its host"}`);
    }
    expect(leaks).toEqual([]);
    expect(existsSync(join(out, "outside", "martian", "work"))).toBe(false);
  });
});

describe("a secret reaches the terminal or a log in pieces, or URL-encoded", () => {
  const KEY = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
  const BASE = "https://judge-host.example.test/openai/v1";
  const secrets = endpointSecrets(BASE, KEY);
  const through = (chunks) => {
    let text = "";
    const r = redactor(secrets, (t) => (text += t));
    for (const c of chunks) r.write(Buffer.from(c));
    r.end();
    return text;
  };

  it("replaces a key, a base URL and a host split across chunks, and their URL-encoded forms, and passes the rest unchanged", () => {
    const line = `Base URL: ${BASE}\nkey ${KEY} and host judge-host.example.test\nencoded ${encodeURIComponent(BASE)}\nplain text stays\n`;
    for (const size of [1, 2, 3, 7, 13, 64, line.length]) {
      const chunks = [];
      for (let i = 0; i < line.length; i += size) chunks.push(line.slice(i, i + size));
      const text = through(chunks);
      expect(leaksIn(text, secrets), `chunks of ${size}`).toBe(false);
      expect(text).toBe("Base URL: [hidden]\nkey [hidden] and host [hidden]\nencoded [hidden]\nplain text stays\n");
    }
    // A long line with no line break still flows, and the end flushes what was held.
    const long = `${"x".repeat(5000)}${KEY.slice(0, 10)}`;
    expect(through([long, KEY.slice(10), " tail"])).toBe(`${"x".repeat(5000)}[hidden] tail`);
  });

  it("keeps one buffer per stream, so a key split across two chunks of one stream survives the other stream writing between them", () => {
    let text = "";
    const sink = (t) => (text += t);
    const out = redactor(secrets, sink);
    const err = redactor(secrets, sink);
    out.write(Buffer.from(`token ${KEY.slice(0, 12)}`));
    err.write(Buffer.from("progress 50%\n"));
    out.write(Buffer.from(`${KEY.slice(12)}\n`));
    out.end();
    err.end();
    expect(leaksIn(text, secrets)).toBe(false);
    expect(text).toMatch(/token \[hidden\]/);
  });

  it("finds a secret in a saved file when a line break splits it", () => {
    expect(leaksIn(`key ${KEY.slice(0, 9)}\n${KEY.slice(9)}`, secrets)).toBe(true);
    expect(leaksIn(`url ${encodeURIComponent(BASE)}`, secrets)).toBe(true);
    expect(leaksIn("nothing here", secrets)).toBe(false);
  });
});

// ---------- Martian's own pipeline, when its pinned checkout is in the cache ----------

const CHECKOUT = join(cacheRoot(), "upstream", `code-review-benchmark@${COMMIT}`);
const OFFLINE = join(CHECKOUT, "offline");
const PYTHON = join(`${CHECKOUT}.venv`, "bin", "python");
const live = existsSync(join(OFFLINE, "code_review_benchmark", "step3_judge_comments.py")) && existsSync(PYTHON);

describe("Martian's own pipeline judges the converted fixture", () => {
  it.skipIf(!live)(`runs steps 2, 2.5 and 3 and score_profiles at ${COMMIT.slice(0, 7)} with the judge settings, writes an evaluation.json the reader takes, and leaves the key and base URL nowhere (needs their checkout from martian.sh --prepare, and the npm registry for the release gate; skipped without the checkout)`, async () => {
    const ctx = await suite();
    const out = await savedRun(ctx, { plan: fixturePlan() });
    const opts = convertOpts(ctx);
    await convertRun(out, opts);
    const provider = await fakeProvider();
    const key = `fake-judge-key-${randomBytes(16).toString("hex")}`;
    const home = tempDir("oq-martian-board-judged-");
    writeFileSync(join(home, "azure.env"), `AZURE_OPENAI_BASE_URL=${provider.base}\nAZURE_OPENAI_KEY=${key}\n`);
    chmodSync(join(home, "azure.env"), 0o600);
    const env = { ...process.env, OPENQODEX_BENCH_MODEL_ENV: join(home, "azure.env"), OPENQODEX_BENCH_ACCESS_LOG: opts.accessLog, TMPDIR: home, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" };
    const r = await new Promise((done) => {
      const child = spawn(process.execPath, [JUDGE, out, "--checkout", OFFLINE, "--python", PYTHON], { env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.stderr.on("data", (c) => (stderr += c));
      child.on("close", (status) => done({ status, stdout, stderr }));
    });
    await provider.close();
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const board = join(out, "outside", "martian");
    const record = readJson(join(board, "eval.json"));
    expect(record).toMatchObject({ commit: COMMIT, checkout: { commit: COMMIT, tree: expect.stringMatching(/^[0-9a-f]{40}$/) }, judge: { deployment: "gpt-5.2" }, problems: [] });
    expect(record.steps.map((s) => [s.step, s.exit])).toEqual([["step2_extract_comments", 0], ["step2_5_dedup_candidates", 0], ["step3_judge_comments", 0], ["score_profiles", 0], ["score_profiles totals", 0]]);
    expect(record.judging).toMatchObject({ reviews: 3, errorsCount: 0 });
    // Their client sends the key as a bearer token, to the chat completions path, naming the judge deployment.
    expect(provider.seen.length).toBeGreaterThan(0);
    expect(provider.seen.every((s) => s.path === "/v1/chat/completions" && s.authorization === `Bearer ${key}` && s.apiKey === null && s.model === "gpt-5.2" && s.temperature === 0)).toBe(true);
    expect(new Set(provider.seen.map((s) => s.kind))).toEqual(new Set(["extract", "dedup", "judge"]));
    // Nothing of the endpoint in the output or any file of the run.
    const leaks = [["stdout", r.stdout], ["stderr", r.stderr], ...filesUnder(out).map((p) => [p, readFileSync(p, "utf8")])].filter(([, text]) => endpointSecrets(provider.base, key).some((s) => text.includes(s)));
    expect(leaks.map(([where]) => where)).toEqual([]);
    // score_profiles printed Core precision, recall and F1.
    expect(readFileSync(join(board, "work", "pipeline.log"), "utf8")).toMatch(/Profile: CORE[\s\S]*openqodex-library-r1/);
    const evaluation = readJson(join(board, "openqodex-library-r1", "evaluation.json"));
    const { findings, golden } = await fixtureTruth();
    const read = readMartianEvaluation(evaluation, { findings, golden });
    expect(read.official.all).toMatchObject({ tp: 5, fp: 1, fn: 0, prs: 3 });
    expect(read.ours.golden).toEqual({ found: 5, of: 5 });
    const results = join(board, "work", "results", "gpt-5.2");
    const files = { "candidates.json": "candidates.json", "dedup_groups.json": "dedup_groups.json", "evaluations.json": "evaluations.json", "totals.json": join("..", "..", "totals.json") };
    for (const [name, from] of Object.entries(files)) {
      const text = readFileSync(join(results, from), "utf8");
      if (RECORD) write(join(FIXTURES, "recorded", name), text);
      else expect(JSON.parse(text), name).toEqual(readJson(join(FIXTURES, "recorded", name)));
    }
    // The recorded files give the same evaluation the wrapper wrote.
    expect(recordedEvaluation().tools[0].evaluation).toEqual(evaluation);
  });
});

describe("a modified evaluator runs while eval.json records the pinned commit", () => {
  it("names an edited file, a staged one and an untracked one in the checkout, and gives the commit and tree of a clean one", () => {
    const dir = tempDir("oq-martian-board-checkout-");
    git(dir, "init", "-q");
    write(join(dir, "offline", "code_review_benchmark", "step3_judge_comments.py"), "print('pinned')\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "pinned");
    const clean = { commit: git(dir, "rev-parse", "HEAD").trim(), tree: git(dir, "rev-parse", "HEAD^{tree}").trim(), problems: [] };
    expect(checkoutState(dir)).toEqual(clean);
    write(join(dir, "offline", "code_review_benchmark", "step3_judge_comments.py"), "print('patched')\n");
    expect(checkoutState(dir).problems.join(" ")).toMatch(/step3_judge_comments\.py/);
    git(dir, "add", "-A");
    expect(checkoutState(dir).problems.join(" ")).toMatch(/step3_judge_comments\.py/);
    git(dir, "reset", "-q", "--hard");
    expect(checkoutState(dir)).toEqual(clean);
    write(join(dir, "offline", "json.py"), "raise SystemExit\n");
    expect(checkoutState(dir).problems.join(" ")).toMatch(/offline\/json\.py/);
  });

  it("names a file marked assume-unchanged that was edited, and an ignored file, which git status does not show", () => {
    const dir = tempDir("oq-martian-board-hidden-");
    git(dir, "init", "-q");
    write(join(dir, ".gitignore"), "*.pth\n");
    write(join(dir, "offline", "code_review_benchmark", "step3_judge_comments.py"), "print('pinned')\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "pinned");
    git(dir, "update-index", "--assume-unchanged", "offline/code_review_benchmark/step3_judge_comments.py");
    write(join(dir, "offline", "code_review_benchmark", "step3_judge_comments.py"), "print('patched')\n");
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(checkoutState(dir).problems.join(" ")).toMatch(/differ[^;]*step3_judge_comments\.py/);
    git(dir, "update-index", "--no-assume-unchanged", "offline/code_review_benchmark/step3_judge_comments.py");
    git(dir, "checkout", "--", ".");
    write(join(dir, "offline", "patch.pth"), "import os\n");
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(checkoutState(dir).problems.join(" ")).toMatch(/not in the pinned tree[^;]*offline\/patch\.pth/);
  });
});

describe("the bench cache lies in the repository", () => {
  it("refuses, in one line and creating nothing, a cache whose real path is inside the repository", () => {
    const inside = join(repoRoot, `.oq-martian-cache-test-${randomBytes(4).toString("hex")}`);
    const r = spawnSync("bash", [WRAPPER, "--prepare"], { encoding: "utf8", env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, OPENQODEX_BENCH_CACHE: inside }, timeout: 60_000 });
    expect(r.status).toBe(2);
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
    expect(r.stderr).toMatch(/inside the repository/);
    expect(existsSync(inside)).toBe(false);
  });

  it("refuses a cache outside the repository whose upstream folder is a link into it, creating nothing there", () => {
    const cache = tempDir("oq-martian-board-cache-link-");
    symlinkSync(join(repoRoot, "benchmark", "suites"), join(cache, "upstream"));
    const before = readdirSync(join(repoRoot, "benchmark", "suites"));
    const r = spawnSync("bash", [WRAPPER, "--prepare"], { encoding: "utf8", env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, OPENQODEX_BENCH_CACHE: cache }, timeout: 60_000 });
    expect(r.status).toBe(2);
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
    expect(r.stderr).toMatch(/inside the repository/);
    expect(readdirSync(join(repoRoot, "benchmark", "suites"))).toEqual(before);
  });
});

// The board the converter records is the one boards.json pins.
describe("the pinned board", () => {
  it("names withmartian/code-review-benchmark at the pinned commit", () => {
    expect(MARTIAN_BOARD).toMatchObject({ repo: "withmartian/code-review-benchmark", commit: COMMIT });
  });
});
