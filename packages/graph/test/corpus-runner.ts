// The corpus runner both corpus test files share (corpus.test.ts for the
// language cases, frameworks-corpus.test.ts for each framework plugin's):
// one scoring per group in its own hook, one test per case named for the
// failure it guards, and the gate. A case the graph fails today is marked
// `knownFailure` in its expected.json and runs as `it.fails`.
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { scoreCases, totalsOf, value } from "../corpus/score.js";
import type { CaseScore, CorpusScore, Expected } from "../corpus/score.js";

const readExpected = (dir: string): Expected => {
  try {
    return JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")) as Expected;
  } catch {
    return { guards: "a case without a readable expected.json" };
  }
};

export function defineCorpus(title: string, root: string, dirs: readonly string[], timeoutMs: number): void {
  const cases = dirs.map((dir) => ({ name: relative(root, dir), expected: readExpected(dir) }));
  describe(title, () => {
    let scored: CorpusScore;
    beforeAll(async () => {
      scored = await scoreCases(root, dirs);
    }, timeoutMs);

    const resultOf = (name: string): CaseScore => {
      const r = scored.cases.find((c) => c.case === name);
      if (!r) throw new Error(`${name} was not scored`);
      return r;
    };

    for (const c of cases) {
      const caseTitle = `${c.expected.guards} (${c.name})`;
      if (c.expected.knownFailure) {
        it.fails(`known graph failure: ${c.expected.knownFailure}; guards: ${caseTitle}`, () => {
          expect(resultOf(c.name).failures).toEqual([]);
        });
      } else {
        it(caseTitle, () => {
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
      console.log(`${title} totals, every case: ${line(all)}`);
      console.log(`${title} totals, known failures left out: ${line(t)}`);
      expect(value(t.precision)).toBe(1);
      expect(value(t.validity)).toBe(1);
      expect(value(t.gaps)).toBe(1);
      expect(value(t.cuts)).toBe(1);
      for (const r of Object.values(t.recall)) expect(value(r)).toBe(1);
      expect(value(t.controls)).toBe(1);
      expect(t.passed).toBe(t.cases);
    });
  });
}
