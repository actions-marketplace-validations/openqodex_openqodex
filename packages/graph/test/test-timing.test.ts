// The growth check every graph timing test uses (src/test-timing.ts). Ways
// it could fail, written before the code:
// 1. A ratio is taken on a smaller input that runs for a few milliseconds,
//    where the compiler and the garbage collector decide the time: a linear
//    reader fails on a busy runner (go.mod, 19 ms at 256 KiB against 248 ms
//    at 1 MiB, on a Linux runner on 2026-10-09).
// 2. Growing the input to get above that noise hides a quadratic step.
// 3. Work that stays under the noise however far it may grow is held to a
//    ratio anyway, or to no bound at all.
// 4. The input grows past what the test allows (a product cap it must stay
//    under), so the larger run measures a file the reader refuses.
// The costs here are numbers chosen to have each shape; no reader runs.
import { describe, expect, it } from "vitest";
import { expectLinear, expectLinearScaled, NOISE_MS } from "../src/test-timing.js";

describe("the growth check", () => {
  it("never takes a ratio on a smaller run under the noise floor (1)", () => {
    expect(NOISE_MS).toBe(50);
    expect(() => expectLinear("a linear reader whose small run is noise", 19, 248)).not.toThrow();
    expect(() => expectLinear("a quadratic step above the noise", 60, 960)).toThrow();
  });

  it("grows a small input until its run is above the noise, then compares four times that (1, 2)", async () => {
    const asked: number[] = [];
    // Linear above 1 MiB, with the garbage collector's step below it.
    const linear = (scale: number) => {
      asked.push(scale);
      return scale <= 1 ? 19 : 62 * scale;
    };
    await expectLinearScaled("a reader linear above the noise", linear);
    expect(asked).toEqual([1, 2, 8]);
    const quadratic = (scale: number) => 10 * scale * scale;
    await expect(expectLinearScaled("a quadratic reader", quadratic)).rejects.toThrow();
  });

  it("holds work that stays under the noise to the floor, never to a ratio of noise (3)", async () => {
    await expectLinearScaled("work that stays small", () => 3);
    await expect(expectLinearScaled("work that jumps past the floor", (s) => (s >= 256 ? 500 : 3))).rejects.toThrow();
  });

  it("never grows the input past the largest scale the test allows (4)", async () => {
    const asked: number[] = [];
    await expectLinearScaled("capped", (s) => {
      asked.push(s);
      return 5;
    }, { maxScale: 4 });
    // The larger run is at four times the smaller, so the smaller never grows here.
    expect(asked).toEqual([1, 4]);
  });
});
