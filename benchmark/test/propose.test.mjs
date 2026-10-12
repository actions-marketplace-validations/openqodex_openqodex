// The only door into the reviewer loop is benchmark/loop/propose.mjs. Three
// failures are guarded here, each on scratch branches of a real git clone of
// this repository (real packages/, real planted cases), never a fake git:
//
// 1. A change editing a spec or naming a case identifier in a lens enters the
//    loop, so the loop tunes the product on its own truth. Refused: a path
//    under benchmark/cases, suites, splits or review-queue, the case lock, a
//    folder a planted case builds from, a file outside the lever, an added
//    line naming a case identifier, a variant keyed on a model id or a
//    provider. A real suite whose truth cannot be read stops the check
//    (exit 2) instead of passing its names unchecked.
// 2. A change enters the loop with its acceptable losses unset, or edited
//    after the first run, so the bar is set after the score is seen. Refused:
//    a record without a hypothesis, a primary metric or a loss for every
//    guard, and any second record for the same branch or commit, also when
//    two proposals run at once. The ledger only grows.
// 3. The accepted pointer on origin's main names the loop's base, so a
//    pointer that holds a ref name or a tag id, or a clone that lacks the
//    commit (a shallow clone), must stop the check (exit 2) and never pick
//    another base.
//
// The diff is read from the loop's base, never from a parent the record
// chooses: here the clone's origin is a bare repository whose main the tests
// move, so origin/main is the base the loop trusts.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git, repoRoot } from "../lib/cases.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const PROPOSE = fileURLToPath(new URL("../loop/propose.mjs", import.meta.url));
const LENS = "packages/core/lenses/eval-on-user-input.md";
const MODEL_LOOP = "packages/review/src/model-loop.ts";
const ACCEPTED = "benchmark/index/accepted.json";

let work;
let bare;
let clone;
let base;
let cache;
let made = 0;

beforeAll(() => {
  work = tempDir("oq-bench-propose-");
  clone = join(work, "repo");
  cache = join(work, "cache");
  mkdirSync(cache);
  bare = join(work, "origin.git");
  base = git(repoRoot, "rev-parse", "HEAD").trim();
  git(work, "clone", "-q", "--bare", "--shared", repoRoot, bare);
  git(bare, "update-ref", "refs/heads/main", base);
  git(work, "clone", "-q", "--shared", "--no-checkout", bare, clone);
  git(clone, "checkout", "-q", "--detach", base);
  // A real suite's truth lives in the pinned raw files of the cache, which
  // these tests never fetch, so the base drops the committed real suites;
  // the test that needs one adds its own. The base drops the committed
  // accepted pointer too: a review run accepted on the real main would be
  // the loop's base in every test here, and a shallow checkout (CI) does not
  // even hold its commit. The tests that need a pointer write their own.
  const owned = ["benchmark/suites", ACCEPTED].filter((path) => git(clone, "ls-tree", "--name-only", base, "--", path).trim() !== "");
  if (owned.length > 0) {
    git(clone, "rm", "-r", "-q", "--", ...owned);
    git(clone, "commit", "-q", "-m", "the base without the real suites and the accepted pointer");
    base = git(clone, "rev-parse", "HEAD").trim();
    git(clone, "push", "-q", "origin", `${base}:refs/heads/main`);
  }
});

// Moves origin's main to a commit of the clone (the loop's trusted base).
let pushed = 0;
function originMain(sha) {
  git(clone, "push", "-q", "origin", `${sha}:refs/heads/scratch-${++pushed}`);
  git(bare, "update-ref", "refs/heads/main", sha);
}

// A branch from `from` with each file written over (a function gets the old
// text), committed. Returns the branch tip.
function branch(name, edits, from = base) {
  git(clone, "checkout", "-q", "-B", name, from);
  for (const [path, edit] of Object.entries(edits)) {
    const full = join(clone, path);
    mkdirSync(dirname(full), { recursive: true });
    const old = existsSync(full) ? readFileSync(full, "utf8") : "";
    writeFileSync(full, typeof edit === "function" ? edit(old) : edit);
  }
  git(clone, "add", "-A");
  git(clone, "commit", "-q", "-m", name);
  return git(clone, "rev-parse", "HEAD").trim();
}

const appendLine = (line) => (old) => `${old}${old.endsWith("\n") ? "" : "\n"}${line}\n`;
const lensLine = (line) => ({ [LENS]: appendLine(line) });
const GENERIC = "A value read from a query string, a form field or a header is untrusted input as well.";
// Group keys of benchmark/index/accepted.json (lib/index.mjs groupKeys):
// suite|split|splitHash|mode|path|reviewer|model|config|rulesVersion.
const REVIEW_GROUP = "planted|dev|none|review|laptop|claude|claude-opus-5-5|claude-graph-on|5";
const SCAN_GROUP = "planted|dev|none|scan|laptop|none|none|scan|1";

const cliEnv = (env) => ({ ...process.env, OPENQODEX_BENCH_CACHE: cache, ...env });

function cli(args, env = {}) {
  const r = spawnSync(process.execPath, [PROPOSE, ...args], { encoding: "utf8", env: cliEnv(env) });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function template(lever) {
  const r = cli(["--template", lever]);
  expect(r.code, r.out).toBe(0);
  return JSON.parse(r.out);
}

// The lever's template filled in the way a person would: every field the
// person owns, the defaults left as the registry gives them.
function fullRecord(lever, branchName, over = {}) {
  return {
    ...template(lever),
    title: `test change on ${branchName}`,
    hypothesis: "Naming request headers as input raises recall on the eval class without costing precision.",
    branch: branchName,
    parent: base,
    proposedBy: "propose.test.mjs",
    ...over,
  };
}

function recordFile(record) {
  const file = join(work, `record-${++made}.json`);
  writeFileSync(file, JSON.stringify(record));
  return file;
}

function propose(record, { ledger = join(work, `ledger-${++made}.jsonl`), env = {}, repo = clone } = {}) {
  return { ...cli([recordFile(record), "--repo", repo, "--ledger", ledger], env), ledger };
}

// The same, started without waiting, so two can run at once.
function proposeAsync(record, ledger) {
  const child = spawn(process.execPath, [PROPOSE, recordFile(record), "--repo", clone, "--ledger", ledger], { env: cliEnv({}) });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  return new Promise((done) => child.on("close", (code) => done({ code, out })));
}

const without = (object, key) => Object.fromEntries(Object.entries(object).filter(([k]) => k !== key));
const ledgerLines = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l)) : []);

describe("a change editing a spec or naming a case identifier in a lens enters the loop", () => {
  for (const [i, [what, path, edit]] of [
    ["a planted spec", "benchmark/cases/flask-path-traversal/case.json", (old) => old.replace('"guards": "a', '"guards": "A')],
    ["a test split", "benchmark/splits/aacr-v1.json", '{"version":1,"test":[]}\n'],
    ["a real suite's cases", "benchmark/suites/aacr/cases.json", "[]\n"],
    ["the review queue", "benchmark/review-queue/decisions.jsonl", '{"v":1}\n'],
    ["the case lock", "benchmark/cases.lock.json", (old) => old.replace('"version": 1', '"version": 1 ')],
    ["a folder a planted case builds from outside benchmark/cases", "examples/demo-repo/baseline/requirements.txt", appendLine("# one more line")],
  ].entries()) {
    it(`refuses a lens change that also edits ${what}`, () => {
      const name = `truth-${i}`;
      branch(name, { ...lensLine(GENERIC), [path]: edit });
      const r = propose(fullRecord("lenses", name));
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain(path);
      expect(r.out).toMatch(/loop's truth/);
      expect(ledgerLines(r.ledger)).toEqual([]);
    });
  }

  it("refuses a lens line naming a case identifier, and names the case it came from", () => {
    // The premise: UPLOAD_DIR and the case's name are in the planted case
    // files and nowhere in packages/ at the parent.
    expect(readFileSync(join(clone, "benchmark/cases/flask-path-traversal/change/files/app.py"), "utf8")).toContain("UPLOAD_DIR");
    const grep = spawnSync("git", ["grep", "-i", "-l", "-F", "-e", "upload_dir", "-e", "flask-path-traversal", base, "--", "packages"], { cwd: clone, encoding: "utf8" });
    expect(grep.status, grep.stdout).toBe(1);

    branch("lens-names-case", lensLine("Look hard at os.path.join(UPLOAD_DIR, name) in a download route, as in flask-path-traversal."));
    const r = propose(fullRecord("lenses", "lens-names-case"));
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(new RegExp(`${LENS}:\\d+ names case identifiers`));
    expect(r.out).toContain("upload_dir (planted/flask-path-traversal)");
    expect(r.out).toContain("flask-path-traversal (planted/flask-path-traversal)");
    expect(ledgerLines(r.ledger)).toEqual([]);
  });

  it("refuses a changed file outside the lever's files", () => {
    branch("outside-lever", { ...lensLine(GENERIC), [MODEL_LOOP]: appendLine("export const ANOTHER_LIMIT = 3;") });
    const r = propose(fullRecord("lenses", "outside-lever"));
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(`${MODEL_LOOP} is outside lever lenses`);
  });

  it("refuses a variant keyed on a model id or a provider, and takes one keyed on the reviewer kind", () => {
    branch("keyed-on-model", { [MODEL_LOOP]: appendLine('export const toolHint = (model: string) => (model.startsWith("gpt-6.1") ? "name the five tools" : "");') });
    const refused = propose(fullRecord("tools.told", "keyed-on-model"));
    expect(refused.code, refused.out).toBe(1);
    expect(refused.out).toMatch(new RegExp(`${MODEL_LOOP}:\\d+ compares a model id or a provider name \\(gpt\\)`));

    branch("keyed-on-provider", { [MODEL_LOOP]: appendLine('export const PROVIDER_HINTS: Record<string, string> = { "azure": "name the five tools" };') });
    const provider = propose(fullRecord("tools.told", "keyed-on-provider"));
    expect(provider.code, provider.out).toBe(1);
    expect(provider.out).toMatch(/compares a model id or a provider name \(azure\)/);

    branch("keyed-on-kind", { [MODEL_LOOP]: appendLine('export const toolHint = (kind: string) => (kind === "model" ? "name the five tools" : "");') });
    const taken = propose(fullRecord("tools.told", "keyed-on-kind"));
    expect(taken.code, taken.out).toBe(0);
    expect(ledgerLines(taken.ledger)[0].record.paths).toEqual(["server"]);
  });

  it("stops (exit 2) when a real suite's truth cannot be read, instead of passing its names unchecked", () => {
    const withSuite = branch("parent-with-aacr", { "benchmark/suites/aacr/cases.json": "[]\n" });
    branch("lens-over-aacr", lensLine(GENERIC), withSuite);
    const unknown = branch("parent-with-other", { "benchmark/suites/other/cases.json": "[]\n" });
    branch("lens-over-other", lensLine(GENERIC), unknown);
    try {
      originMain(withSuite);
      const missing = propose(fullRecord("lenses", "lens-over-aacr", { parent: withSuite }));
      expect(missing.code, missing.out).toBe(2);
      expect(missing.out).toMatch(/aacr/);
      expect(missing.out).toMatch(/positive_samples\.json/);

      originMain(unknown);
      const noReader = propose(fullRecord("lenses", "lens-over-other", { parent: unknown }));
      expect(noReader.code, noReader.out).toBe(2);
      expect(noReader.out).toMatch(/no identifier reader for suite other/);
    } finally {
      originMain(base);
    }
  });

  it("checks the diff from the loop's base, not from a parent the record chooses", () => {
    // Commit A edits a split; commit B on top of it adds an allowed lens
    // line; a record naming A as the parent would have only A..B checked.
    const a = branch("split-then-lens", { "benchmark/splits/aacr-v1.json": '{"version":1,"test":[]}\n' });
    branch("split-then-lens", lensLine(GENERIC), a);
    const r = propose(fullRecord("lenses", "split-then-lens", { parent: a }));
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/is not the loop's base/);
    expect(r.out).toContain("benchmark/splits/aacr-v1.json");
    expect(ledgerLines(r.ledger)).toEqual([]);
  });

  it("takes the last accepted commit as the base once benchmark/index/accepted.json names one", () => {
    const accepted = { runId: "2026-10-11-review", commit: base, scoreHash: "a".repeat(64), acceptedAt: "2026-10-11T10:00:00.000Z", acceptedBy: "Sid" };
    const later = branch("main-with-accepted", { "benchmark/index/accepted.json": `${JSON.stringify({ version: 1, ...accepted, groups: { [REVIEW_GROUP]: accepted } })}\n` });
    branch("lens-from-later", lensLine(GENERIC), later);
    branch("lens-from-accepted", lensLine(GENERIC));
    try {
      originMain(later);
      const fromLater = propose(fullRecord("lenses", "lens-from-later", { parent: later }));
      expect(fromLater.code, fromLater.out).toBe(1);
      expect(fromLater.out).toMatch(/is not the loop's base/);
      expect(fromLater.out).toMatch(/accepted\.json/);
      const fromAccepted = propose(fullRecord("lenses", "lens-from-accepted"));
      expect(fromAccepted.code, fromAccepted.out).toBe(0);
    } finally {
      originMain(base);
    }
  });

  // A scanner-only run is accepted in its own group (the bench-scan CI job's
  // baseline). The reviewer loop compares reviews with the accepted review
  // run, built at that run's commit, so a scan accept must not move the base.
  it("keeps the reviewer loop's base when a scanner-only run is accepted last", () => {
    const scanAt = branch("main-scan-base", lensLine("A scan baseline commit."));
    const review = { runId: "2026-10-11-review", commit: base, scoreHash: "a".repeat(64), acceptedAt: "2026-10-11T10:00:00.000Z", acceptedBy: "Sid" };
    const scan = { runId: "2026-10-11-scan", commit: scanAt, scoreHash: "b".repeat(64), acceptedAt: "2026-10-11T11:00:00.000Z", acceptedBy: "Sid" };
    // The scan run is the one accepted last, so the top level names it.
    const both = branch("main-with-scan-accepted", { "benchmark/index/accepted.json": `${JSON.stringify({ version: 1, ...scan, groups: { [REVIEW_GROUP]: review, [SCAN_GROUP]: scan } })}\n` }, scanAt);
    const scanOnly = branch("main-with-scan-only", { "benchmark/index/accepted.json": `${JSON.stringify({ version: 1, ...scan, groups: { [SCAN_GROUP]: scan } })}\n` }, scanAt);
    branch("lens-from-review-base", lensLine(GENERIC));
    branch("lens-from-scan-only-main", lensLine(GENERIC), scanOnly);
    try {
      originMain(both);
      const fromReview = propose(fullRecord("lenses", "lens-from-review-base"));
      expect(fromReview.code, fromReview.out).toBe(0);
      // With no review run accepted, the base is the merge-base with main, as before any accept.
      originMain(scanOnly);
      const fromMain = propose(fullRecord("lenses", "lens-from-scan-only-main", { parent: scanOnly }));
      expect(fromMain.code, fromMain.out).toBe(0);
    } finally {
      originMain(base);
    }
  });

  // The pointer's commit reaches git from a file on origin's main. A ref
  // name there would resolve to whatever that ref holds locally, a tag id
  // would peel to another commit, and a shallow clone (the CI checkout)
  // lacks the commit: each must stop the check, never pick a base.
  it("stops with the base unknown when the accepted pointer is not a full commit id this clone holds", () => {
    const accept = (commit, runId) => {
      const run = { runId, commit, scoreHash: "a".repeat(64), acceptedAt: "2026-10-12T10:00:00.000Z", acceptedBy: "Sid" };
      return { [ACCEPTED]: `${JSON.stringify({ version: 1, ...run, groups: { [REVIEW_GROUP]: run } })}\n` };
    };
    const unknown = (runId) => `names an accepted review run (${runId}) whose commit`;
    try {
      // origin's main is one commit past the accepted run's, as on the real main.
      const tip = branch("main-accepts-base", accept(base, "2026-10-12-review"));
      originMain(tip);
      const shallow = join(work, "shallow");
      git(work, "clone", "-q", "--depth", "1", "--branch", "main", "--no-checkout", `file://${bare}`, shallow);
      expect(spawnSync("git", ["cat-file", "-e", `${base}^{commit}`], { cwd: shallow }).status).not.toBe(0);
      git(shallow, "branch", "shallow-at-tip", tip);
      const atTip = propose(fullRecord("lenses", "shallow-at-tip", { parent: tip }), { repo: shallow });
      expect(atTip.code, atTip.out).toBe(2);
      expect(atTip.out).toContain(unknown("2026-10-12-review"));
      expect(atTip.out).toContain("git fetch --unshallow origin");

      // A full clone holds the commit: the same pointer names the base.
      branch("lens-under-base", lensLine(GENERIC), base);
      const underBase = propose(fullRecord("lenses", "lens-under-base"));
      expect(underBase.code, underBase.out).toBe(0);
      expect(ledgerLines(underBase.ledger)[0].record.parent).toBe(base);

      // A ref name in the pointer resolves locally; a tag id peels to a commit. Neither is a base.
      git(clone, "tag", "-a", "-m", "an annotated tag at the base", "base-tag", base);
      const tagId = git(clone, "rev-parse", "refs/tags/base-tag").trim();
      expect(tagId).not.toBe(base);
      for (const [pointer, runId] of [["refs/heads/lens-under-base", "2026-10-12-ref"], [tagId, "2026-10-12-tag"], ["1".repeat(40), "2026-10-12-nowhere"]]) {
        originMain(branch(`main-accepts-${runId}`, accept(pointer, runId)));
        branch(`lens-under-${runId}`, lensLine(GENERIC));
        const crafted = propose(fullRecord("lenses", `lens-under-${runId}`));
        expect(crafted.code, crafted.out).toBe(2);
        expect(crafted.out).toContain(unknown(runId));
      }
    } finally {
      git(clone, "tag", "-d", "base-tag");
      originMain(base);
    }
  });

  it("refuses a lens replaced by a symbolic link, and a submodule added among the lenses", () => {
    const outside = join(work, "outside-lens.md");
    writeFileSync(outside, "Look at os.path.join(UPLOAD_DIR, name).\n");
    git(clone, "checkout", "-q", "-B", "lens-as-link", base);
    unlinkSync(join(clone, LENS));
    symlinkSync(outside, join(clone, LENS));
    git(clone, "add", "-A");
    git(clone, "commit", "-q", "-m", "lens as a link");
    const link = propose(fullRecord("lenses", "lens-as-link"));
    expect(link.code, link.out).toBe(1);
    expect(link.out).toContain(`${LENS} is a symbolic link or a submodule`);

    git(clone, "checkout", "-q", "-B", "lens-submodule", base);
    git(clone, "update-index", "--add", "--cacheinfo", `160000,${base},packages/core/lenses/vendor`);
    git(clone, "commit", "-q", "-m", "a submodule among the lenses");
    const sub = propose(fullRecord("lenses", "lens-submodule"));
    expect(sub.code, sub.out).toBe(1);
    expect(sub.out).toContain("packages/core/lenses/vendor is a symbolic link or a submodule");
  });

  it("refuses a lens that git reads as binary, and still finds the case identifier in it", () => {
    branch("lens-with-nul", lensLine("Look at os.path.join(UPLOAD_DIR, name).\u0000"));
    const r = propose(fullRecord("lenses", "lens-with-nul"));
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(`${LENS} is not text`);
    expect(r.out).toContain("upload_dir (planted/flask-path-traversal)");
  });

  it("accepts a lens-only branch with a full record and writes one proposed line", () => {
    const tip = branch("lens-only", lensLine(GENERIC));
    const record = fullRecord("lenses", "lens-only");
    const r = propose(record);
    expect(r.code, r.out).toBe(0);
    const lines = ledgerLines(r.ledger);
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line).toMatchObject({ v: 1, id: "RC-0001", event: "proposed" });
    expect(line.record).toMatchObject({ lever: "lenses", branch: "lens-only", parent: base, commit: tip, paths: ["laptop", "server"], target: "server", hypothesis: record.hypothesis });
    expect(line.record.primary).toEqual({ metric: "recall", better: "higher" });
    expect(line.record.acceptableLoss).toEqual(record.acceptableLoss);
  });
});

describe("a change enters the loop with its acceptable losses unset, or edited after the first run", () => {
  it("refuses a record without losses, without one guard's loss, without a hypothesis or without a primary metric", () => {
    branch("incomplete", lensLine(GENERIC));
    const full = fullRecord("lenses", "incomplete");
    const guards = Object.keys(full.acceptableLoss);
    expect(guards.length).toBeGreaterThan(5);

    const none = propose(without(full, "acceptableLoss"));
    expect(none.code, none.out).toBe(1);
    expect(none.out).toMatch(/no acceptable loss/);

    const one = propose({ ...full, acceptableLoss: without(full.acceptableLoss, guards[1]) });
    expect(one.code, one.out).toBe(1);
    expect(one.out).toContain(`no acceptable loss for ${guards[1]}`);

    const noHypothesis = propose({ ...full, hypothesis: "  " });
    expect(noHypothesis.code, noHypothesis.out).toBe(1);
    expect(noHypothesis.out).toMatch(/no hypothesis/);

    const primary = propose(without(full, "primary"));
    expect(primary.code, primary.out).toBe(1);
    expect(primary.out).toMatch(/no primary metric/);

    for (const r of [none, one, noHypothesis, primary]) expect(ledgerLines(r.ledger)).toEqual([]);
  });

  it("refuses an edit to the primary metric or a loss once the record exists, and only ever appends", () => {
    const tip = branch("predeclared", lensLine(GENERIC));
    const ledger = join(work, "shared-ledger.jsonl");
    const record = fullRecord("lenses", "predeclared");
    expect(propose(record, { ledger }).code).toBe(0);
    const first = readFileSync(ledger, "utf8");

    const guard = Object.keys(record.acceptableLoss)[0];
    const widened = propose({ ...record, acceptableLoss: { ...record.acceptableLoss, [guard]: record.acceptableLoss[guard] * 3 } }, { ledger });
    expect(widened.code, widened.out).toBe(1);
    expect(widened.out).toMatch(/after the record exists/);

    const moved = propose({ ...record, primary: { metric: "precision" } }, { ledger });
    expect(moved.code, moved.out).toBe(1);
    expect(moved.out).toMatch(/after the record exists/);

    git(clone, "branch", "-f", "same-commit-new-name", tip);
    const renamed = propose({ ...record, branch: "same-commit-new-name", acceptableLoss: { ...record.acceptableLoss, [guard]: 50 } }, { ledger });
    expect(renamed.code, renamed.out).toBe(1);
    expect(renamed.out).toMatch(/RC-0001/);

    expect(readFileSync(ledger, "utf8")).toBe(first);

    branch("next-change", lensLine("A value from a cookie is untrusted input too."));
    expect(propose(fullRecord("lenses", "next-change"), { ledger }).code).toBe(0);
    const after = readFileSync(ledger, "utf8");
    expect(after.startsWith(first)).toBe(true);
    expect(ledgerLines(ledger).map((l) => l.id)).toEqual(["RC-0001", "RC-0002"]);
  });

  it("lets only one of two proposals for the same branch in when both run at once", async () => {
    branch("raced", lensLine(GENERIC));
    const ledger = join(work, "raced-ledger.jsonl");
    const record = fullRecord("lenses", "raced");
    const wider = { ...record, acceptableLoss: { ...record.acceptableLoss, recall: 10 } };
    const results = await Promise.all([proposeAsync(record, ledger), proposeAsync(wider, ledger)]);
    expect(results.map((r) => r.code).sort(), results.map((r) => r.out).join("\n")).toEqual([0, 1]);
    expect(results.find((r) => r.code === 1).out).toMatch(/RC-0001/);
    expect(ledgerLines(ledger).map((l) => l.id)).toEqual(["RC-0001"]);
    expect(existsSync(`${ledger}.lock`)).toBe(false);
  });

  it("takes the ledger over from a proposal that died holding its lock", () => {
    branch("after-crash", lensLine(GENERIC));
    const ledger = join(work, "crashed-ledger.jsonl");
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    writeFileSync(`${ledger}.lock`, JSON.stringify({ pid: Number(dead.stdout), at: new Date().toISOString() }));
    const r = propose(fullRecord("lenses", "after-crash"), { ledger });
    expect(r.code, r.out).toBe(0);
    expect(ledgerLines(ledger).map((l) => l.id)).toEqual(["RC-0001"]);
    expect(existsSync(`${ledger}.lock`)).toBe(false);
  });
});
