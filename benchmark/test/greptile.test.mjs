// Failure cases are listed in greptile-failures.md. Every input comes from
// the pinned public datasets. The tree check uses a real fork clone.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ingestGreptile, validateGreptileEntry } from "../ingest/greptile.mjs";
import { verifyMartianMapping, verifyPublishedMartian } from "../ingest/martian.mjs";
import { benchRoot, git } from "../lib/cases.mjs";
import { cacheRoot } from "../lib/licence.mjs";
import { seenTree } from "../lib/materialise.mjs";
import { entryHash, materialise, readCase, splitRewriteProblems, suiteHashOf, truthOf } from "../lib/suites.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);
const cache = cacheRoot();
let result;
let entry;
let c;
let repo;

beforeAll(async () => {
  result = await ingestGreptile({ cache });
  entry = result.suite.cases.find((e) => e.name === "ai-code-review-evaluation__discourse-greptile-1");
  c = readCase(entry.id);
  repo = materialise(c, tempDir("oq-greptile-real-"), { cache, shape: "server" }).dir;
}, 300_000);

it("refuses the upstream fix instead of the defect-bearing change", () => {
  expect(seenTree(repo)).toBe(git(repo, "rev-parse", "HEAD^{tree}").trim());
  expect(git(repo, "diff", "--name-only", "HEAD~1", "HEAD").trim()).not.toBe("");
  const wrong = { ...entry, prUrl: "https://github.com/discourse/discourse/pull/1", headSha: entry.baseSha };
  expect(() => validateGreptileEntry(wrong, entry.change)).toThrow(/defect-bearing/);
  expect(() => materialise({ ...c, materialise: { ...c.materialise, headSha: c.materialise.baseSha } }, tempDir("oq-greptile-refused-"), { cache })).toThrow(/defect-bearing/);
});

it("refuses a case without both truth sets recorded apart", () => {
  const truth = truthOf(c, { cache });
  expect(Object.keys(truth.sets).sort()).toEqual(["augment", "greptile"]);
  expect(truth.sets.greptile.items).toHaveLength(1);
  expect(truth.sets.augment.items.length).toBeGreaterThan(0);
  expect(truth.sets.greptile.source.url).not.toBe(truth.sets.augment.source.url);
  for (const absent of ["augment", "greptile"]) {
    const broken = structuredClone(entry);
    delete broken.truthSets[absent];
    expect(() => validateGreptileEntry(broken, entry.change)).toThrow(/truth sets/);
  }
});

it("changes the suite hash when a case changes", () => {
  expect(suiteHashOf(result.suite.cases)).toBe(result.suite.hash);
  for (const field of ["title", "body", "headSha", "truthHash"]) {
    const changed = structuredClone(result.suite.cases);
    changed[0][field] += " changed";
    expect(entryHash(changed[0])).not.toBe(changed[0].hash);
    expect(suiteHashOf(changed)).not.toBe(result.suite.hash);
  }
});

it("names a mismatched Martian comment against the published revision", async () => {
  const verified = await verifyPublishedMartian({ cache });
  expect(verified.counts).toMatchObject({ cases: 50, comments: 173 });
  const suite = JSON.parse(readFileSync(join(benchRoot, "suites/martian/cases.json"), "utf8"));
  const changed = structuredClone(verified.published);
  const url = suite.cases[0].prUrl;
  changed[url].golden_comments[0].comment += " changed";
  const check = verifyMartianMapping({ suite, published: changed, rows: verified.rows, proofs: verified.proofs });
  expect(check.differences).toContain(`${suite.cases[0].name} comment g1: published comment differs from the pinned golden file`);
});

it("refuses an edited raw source and a missing offline source", async () => {
  const { checkPinned, readPinned } = await import("../lib/suites.mjs");
  const pin = result.suite.dataset.files[0];
  expect(() => checkPinned(Buffer.from("edited"), pin, "edited source")).toThrow(/not the pinned/);
  expect(() => readPinned(tempDir("oq-greptile-empty-"), "greptile", pin)).toThrow(/not in the cache/);
});

it("keeps all fifty case joins unique and both truth totals separate", () => {
  expect(result.suite.cases).toHaveLength(50);
  expect(new Set(result.suite.cases.map((e) => e.prUrl)).size).toBe(50);
  expect(result.suite.cases.reduce((n, e) => n + e.truthSets.greptile.items, 0)).toBe(50);
  expect(result.suite.cases.reduce((n, e) => n + e.truthSets.augment.items, 0)).toBe(137);
});

it("keeps the same hash and split on an unchanged offline re-ingest", async () => {
  const again = await ingestGreptile({ cache, offline: true });
  expect(again.suite).toEqual(result.suite);
  expect(again.split).toEqual(result.split);
});

it("refuses a split rewrite that moves an existing case", () => {
  const changed = structuredClone(result.split);
  const name = changed.cases.dev.shift();
  changed.cases.test.push(name);
  expect(splitRewriteProblems(result.split, changed)).toContain(`${name} would move from dev to test`);
});
