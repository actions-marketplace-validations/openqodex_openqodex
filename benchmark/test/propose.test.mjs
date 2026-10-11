// The only door into the reviewer loop is benchmark/loop/propose.mjs. Two
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
//    guard, and any second record for the same branch or commit. The ledger
//    only grows.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git, repoRoot } from "../lib/cases.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const PROPOSE = fileURLToPath(new URL("../loop/propose.mjs", import.meta.url));
const LENS = "packages/core/lenses/eval-on-user-input.md";
const MODEL_LOOP = "packages/review/src/model-loop.ts";

let work;
let clone;
let base;
let cache;
let made = 0;

beforeAll(() => {
  work = tempDir("oq-bench-propose-");
  clone = join(work, "repo");
  cache = join(work, "cache");
  mkdirSync(cache);
  git(work, "clone", "-q", "--shared", "--no-checkout", repoRoot, clone);
  base = git(repoRoot, "rev-parse", "HEAD").trim();
  git(clone, "checkout", "-q", "--detach", base);
});

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

function cli(args, env = {}) {
  const r = spawnSync(process.execPath, [PROPOSE, ...args], { encoding: "utf8", env: { ...process.env, OPENQODEX_BENCH_CACHE: cache, ...env } });
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

function propose(record, { ledger = join(work, `ledger-${++made}.jsonl`), env = {}, repo = clone } = {}) {
  const file = join(work, `record-${++made}.json`);
  writeFileSync(file, JSON.stringify(record));
  return { ...cli([file, "--repo", repo, "--ledger", ledger], env), ledger };
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
    const missing = propose(fullRecord("lenses", "lens-over-aacr", { parent: withSuite }));
    expect(missing.code, missing.out).toBe(2);
    expect(missing.out).toMatch(/aacr/);
    expect(missing.out).toMatch(/positive_samples\.json/);

    const unknown = branch("parent-with-other", { "benchmark/suites/other/cases.json": "[]\n" });
    branch("lens-over-other", lensLine(GENERIC), unknown);
    const noReader = propose(fullRecord("lenses", "lens-over-other", { parent: unknown }));
    expect(noReader.code, noReader.out).toBe(2);
    expect(noReader.out).toMatch(/no identifier reader for suite other/);
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
});
