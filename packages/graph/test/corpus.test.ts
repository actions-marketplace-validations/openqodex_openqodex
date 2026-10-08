// The correctness corpus (packages/graph/corpus, PLAN.md 3.6): each case is a
// real two-commit repository, built in a temp folder and reviewed through
// getChange, buildGraph and detectImpact, then scored against its
// expected.json. One test per case, named for the real failure it guards;
// a case the graph fails today is marked `knownFailure` in its expected.json
// and runs as `it.fails`, so fixing the graph turns it red until the marker
// goes. The last test holds the gate: certain precision, evidence validity,
// gap disclosure, cut disclosure, recall and the negative controls all 1.
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { findCases, scoreCorpus, totalsOf, value } from "../corpus/score.js";
import type { CaseScore, CorpusScore, Expected } from "../corpus/score.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "corpus");
const readExpected = (dir: string): Expected => {
  try {
    return JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")) as Expected;
  } catch {
    return { guards: "a case without a readable expected.json" };
  }
};
const cases = findCases(root).map((dir) => ({ name: relative(root, dir), expected: readExpected(dir) }));

let scored: CorpusScore;
beforeAll(async () => {
  scored = await scoreCorpus(root);
}, 180_000);

const resultOf = (name: string): CaseScore => {
  const r = scored.cases.find((c) => c.case === name);
  if (!r) throw new Error(`${name} was not scored`);
  return r;
};

describe("the correctness corpus", () => {
  for (const c of cases) {
    const title = `${c.expected.guards} (${c.name})`;
    if (c.expected.knownFailure) {
      it.fails(`known graph failure: ${c.expected.knownFailure}; guards: ${title}`, () => {
        expect(resultOf(c.name).failures).toEqual([]);
      });
    } else {
      it(title, () => {
        const r = resultOf(c.name);
        expect(r.failures).toEqual([]);
        expect(r.pass).toBe(true);
      });
    }
  }

  it("meets the gate on every case not marked as a known graph failure: certain precision, evidence validity, gap and cut disclosure, recall and controls all 1", () => {
    const counted = scored.cases.filter((c) => c.knownFailure === null);
    const t = totalsOf(counted);
    const all = scored.totals;
    const line = (x: typeof t) =>
      `cases ${x.passed}/${x.cases} pass; precision ${x.precision.hit}/${x.precision.of}; recall certain ${x.recall.certain.hit}/${x.recall.certain.of}, likely ${x.recall.likely.hit}/${x.recall.likely.of}, exports ${x.recall.exports.hit}/${x.recall.exports.of}, removed ${x.recall.removed.hit}/${x.recall.removed.of}, moved ${x.recall.moved.hit}/${x.recall.moved.of}; validity ${x.validity.hit}/${x.validity.of}; gaps ${x.gaps.hit}/${x.gaps.of}; cuts ${x.cuts.hit}/${x.cuts.of}; controls ${x.controls.hit}/${x.controls.of}`;
    console.log(`corpus totals, every case: ${line(all)}`);
    console.log(`corpus totals, known failures left out: ${line(t)}`);
    expect(value(t.precision)).toBe(1);
    expect(value(t.validity)).toBe(1);
    expect(value(t.gaps)).toBe(1);
    expect(value(t.cuts)).toBe(1);
    for (const r of Object.values(t.recall)) expect(value(r)).toBe(1);
    expect(value(t.controls)).toBe(1);
    expect(t.passed).toBe(t.cases);
  });
});
