// The five-second rule's predictor. Ways it could fail, one test each:
// 1. The first build, with nothing measured, predicts from rates nobody
//    stated, or the defaults are not the ones docs/graph.md names (400
//    parses a second, 2,500 cached facts a second, 0.25 s per 1,000 files
//    for everything else).
// 2. A measured build does not replace the defaults, so a slow machine keeps
//    being predicted as a fast one.
// 3. Cached facts are counted at the cold rate (or missing ones at the warm
//    rate), so a warm django-size repository is sent to the retained path.
// 4. The mode flips on one build on the other side of the line (flapping),
//    or never flips after two consecutive ones.
// 5. A build's predicted and actual times are not kept, so nobody can check
//    the predictor against what happened.
// 6. A build that only loaded a kept index changes the measured rates (it
//    parsed and resolved nothing), or is not recorded at all, so the mode
//    never flips back to fresh while kept indexes keep being loaded.
import { describe, expect, it } from "vitest";
import { DEFAULT_RATES, FIVE_SECONDS_MS, decideMode, predictMs, recordBuild } from "../src/runtime/predict.js";
import type { PredictMeta } from "../src/runtime/predict.js";

describe("the five-second predictor", () => {
  it("predicts the first build from the stated defaults (1)", () => {
    expect(DEFAULT_RATES).toEqual({ coldPerSec: 400, warmPerSec: 2500, otherMsPerFile: 0.25 });
    // 4,000 files, none cached: 10 s of parsing plus 1 s for the rest.
    expect(predictMs(null, { eligible: 4000, cached: 0 })).toBe(11_000);
    // All cached: 1.6 s of facts plus 1 s.
    expect(predictMs(null, { eligible: 4000, cached: 4000 })).toBe(2_600);
  });

  it("replaces the defaults with what this machine measured (2)", () => {
    const meta = recordBuild(null, { eligible: 1000, parsed: 1000, cached: 0, stages: { parse: 500, facts: 0, other: 100 }, predictedMs: 2750, actualMs: 600, mode: "fresh" });
    expect(meta.rates.coldPerSec).toBe(2000);
    expect(meta.rates.otherMsPerFile).toBeCloseTo(0.1, 5);
    // The warm rate was not measured by this build: it keeps the default.
    expect(meta.rates.warmPerSec).toBe(2500);
    expect(predictMs(meta, { eligible: 1000, cached: 0 })).toBe(600);
  });

  it("counts cached facts at the warm rate and the rest at the cold rate (3)", () => {
    // django on the Mac the plan measured: 4.0 s cold, 0.66 s warm for 2,978 files.
    let meta: PredictMeta | null = null;
    meta = recordBuild(meta, { eligible: 2978, parsed: 2978, cached: 0, stages: { parse: 3400, facts: 0, other: 600 }, predictedMs: 8000, actualMs: 4000, mode: "fresh" });
    meta = recordBuild(meta, { eligible: 2978, parsed: 0, cached: 2978, stages: { parse: 0, facts: 360, other: 300 }, predictedMs: 4000, actualMs: 660, mode: "fresh" });
    const warm = predictMs(meta, { eligible: 2978, cached: 2978 });
    expect(warm).toBeLessThan(FIVE_SECONDS_MS);
    expect(decideMode(meta, warm).mode).toBe("fresh");
    // The same repository with nothing cached is over the line.
    expect(predictMs(meta, { eligible: 2978, cached: 0 })).toBeGreaterThan(warm);
  });

  it("flips the mode only after two consecutive builds on the other side of the line (4)", () => {
    let meta: PredictMeta | null = null;
    const build = (predictedMs: number) => {
      const d = decideMode(meta, predictedMs);
      meta = recordBuild(meta, { eligible: 100, parsed: 0, cached: 100, stages: { parse: 0, facts: 10, other: 10 }, predictedMs, actualMs: predictedMs, mode: d.mode, streak: d.streak });
      return d.mode;
    };
    expect(build(1000)).toBe("fresh");
    expect(build(9000)).toBe("fresh"); // one build over the line: no flip
    expect(build(1000)).toBe("fresh"); // the streak is broken
    expect(build(9000)).toBe("fresh");
    expect(build(9000)).toBe("retained"); // the second in a row flips it
    expect(build(1000)).toBe("retained");
    expect(build(FIVE_SECONDS_MS)).toBe("retained"); // on the line: stays
  });

  it("keeps each build's predicted and actual time, the last ten (5)", () => {
    let meta: PredictMeta | null = null;
    for (let i = 0; i < 12; i++) meta = recordBuild(meta, { eligible: 10, parsed: 10, cached: 0, stages: { parse: 10, facts: 0, other: 1 }, predictedMs: 100 + i, actualMs: 50 + i, mode: "fresh" });
    expect(meta?.last).toHaveLength(10);
    expect(meta?.last[9]).toMatchObject({ predictedMs: 111, actualMs: 61, mode: "fresh", eligible: 10 });
  });

  it("records a build that loaded an index for the mode, never for the rates (6)", () => {
    let meta: PredictMeta | null = recordBuild(null, { eligible: 3000, parsed: 3000, cached: 0, stages: { parse: 4000, facts: 0, other: 900 }, predictedMs: 8000, actualMs: 4900, mode: "retained" });
    const rates = { ...meta.rates };
    for (let i = 0; i < 2; i++) {
      const d = decideMode(meta, 1000);
      meta = recordBuild(meta, { eligible: 3000, parsed: 0, cached: 0, stages: { parse: 0, facts: 0, other: 600 }, predictedMs: 1000, actualMs: 600, mode: d.mode, streak: d.streak }, { rates: false });
    }
    expect(meta?.rates).toEqual(rates);
    expect(meta?.mode).toBe("fresh");
    expect(meta?.last).toHaveLength(3);
  });
});
