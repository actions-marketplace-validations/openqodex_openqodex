// The growth check every graph timing test uses (src/test-timing.ts). Ways
// it could fail, written before the code:
// 1. A ratio is taken on a smaller run of a few milliseconds, where the
//    compiler and the garbage collector decide the time as much as the
//    work does (go.mod, 19 ms at 256 KiB against 248 ms at 1 MiB, on a
//    Linux runner on 2026-10-09).
// 2. Getting above that noise hides a step in the cost per byte inside the
//    range the product reads (a larger input moves past the step; repeating
//    the runs does not).
// 3. Work that stays under the noise however often it runs is held to a
//    ratio anyway, or to no bound at all.
// 4. A run is repeated without end.
// 5. A busy stretch of a shared runner slows some readings of one input and
//    not the other's (the Linux runner's CPU time per byte of one input
//    varied 2.1 times between readings, issue #116): a linear reader reads
//    as eight times and more, and a quadratic reader or a step read once in
//    the stretch reads as under eight (16 read as 7.6, 8.4 as 4.2).
// The costs here are numbers chosen to have each shape; no reader runs.
import { describe, expect, it } from "vitest";
import { expectLinear, expectLinearRepeated, NOISE_MS } from "../src/test-timing.js";

describe("the growth check", () => {
  it("never takes a ratio on a smaller run under the noise floor (1)", () => {
    expect(NOISE_MS).toBe(50);
    expect(() => expectLinear("a linear reader whose small run is noise", 19, 248)).not.toThrow();
    expect(() => expectLinear("a quadratic step above the noise", 60, 960)).toThrow();
  });

  it("repeats both runs until the smaller passes the noise, and compares them at as many repeats (1, 2)", async () => {
    const asked: number[] = [];
    await expectLinearRepeated(
      "a linear reader",
      (r) => {
        asked.push(r);
        return 19 * r;
      },
      (r) => 76 * r,
    );
    expect(asked).toEqual([1, 2, 4]);
    // A cost per byte eight times as high at four times the input: a step the repeats keep in view.
    await expect(expectLinearRepeated("a reader with a step", (r) => 5 * r, (r) => 42 * r)).rejects.toThrow();
  });

  it("holds work that stays under the noise to the floor, and never repeats past the most it allows (3, 4)", async () => {
    const asked: number[] = [];
    await expectLinearRepeated(
      "work that stays small",
      (r) => {
        asked.push(r);
        return 0.01 * r;
      },
      (r) => 0.04 * r,
      { maxRepeats: 64 },
    );
    expect(Math.max(...asked)).toBe(64);
    await expect(expectLinearRepeated("work that jumps past the floor", (r) => 0.01 * r, () => 500, { maxRepeats: 64 })).rejects.toThrow();
  });

  it("reads both inputs in turn before it fails, and compares the medians of their readings (5)", async () => {
    // Each input's readings per run, in the order the check takes them; the last repeats.
    const readings = (...ms: number[]) => {
      let next = 0;
      return (r: number) => (ms[Math.min(next++, ms.length - 1)] ?? 0) * r;
    };
    // A linear reader whose larger input is read once in a busy stretch: nine times the smaller.
    await expectLinearRepeated("a linear reader, its larger input read once in a busy stretch", readings(60), readings(540, 240, 240));
    // A linear reader in a stretch that starts after the smaller input's first reading and outlasts the rest.
    await expectLinearRepeated("a linear reader in a stretch that outlasts the readings", readings(60, 120), readings(540));
    // A quadratic reader and a step in the cost per byte, their smaller input read once in a busy stretch.
    await expect(expectLinearRepeated("a quadratic reader, its smaller input read once in a busy stretch", readings(60, 126, 60), readings(960))).rejects.toThrow();
    await expect(expectLinearRepeated("a step, its smaller input read once in a busy stretch", readings(60, 120, 60), readings(504))).rejects.toThrow();
    // A quadratic reader on a quiet runner.
    await expect(expectLinearRepeated("a quadratic reader", readings(60), readings(960))).rejects.toThrow();
  });
});
