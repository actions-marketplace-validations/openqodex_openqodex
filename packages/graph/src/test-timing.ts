// How the graph's tests hold work to a time: CPU time, never the wall clock,
// and the growth between two input sizes, never one absolute number. A busy
// runner makes this process wait for a core, which adds wall time and no CPU
// time; a step that rescans its input costs sixteen times as much at four
// times the input on any machine, where a linear one costs about four. The
// bound is the middle of the two, as in the scanners' YAML key test. A loose
// absolute bound beside it fails only a gross slowdown.
// Test code only: nothing src/index.ts exports reaches this file.
import { expect } from "vitest";
import type { Node } from "web-tree-sitter";
import { parserFor } from "./parser.js";
import type { Graph, Lang } from "./types.js";

// A larger input takes less than this many times the CPU of the smaller.
export const MAX_GROWTH = 8;
// The larger input takes less CPU time than this, in milliseconds.
export const LOOSE_BOUND_MS = 4000;
// Below this many milliseconds of CPU time a run's time is the compiler's
// and the garbage collector's as much as the work's. No ratio is taken on a
// smaller run under it: the runs are repeated until the smaller passes it
// (expectLinearRepeated), and a run that is not repeated is counted as this
// long, which leaves the larger run a bound of eight times it.
export const NOISE_MS = 50;
// The most times expectLinearRepeated repeats a run, by default.
const MAX_REPEATS = 1024;

function cpuNow(): number {
  const used = process.cpuUsage();
  return (used.user + used.system) / 1000;
}

// The CPU milliseconds of the fastest of three runs of `run`, after one run
// that is not counted (it loads the grammars and warms the compiler).
export async function cpuMs(run: () => unknown): Promise<number> {
  return fastest(async () => {
    const before = cpuNow();
    await run();
    return cpuNow() - before;
  });
}

// One run of `run`, its result and its CPU milliseconds: for work stopped by
// a time limit, which a second run would only repeat.
export async function onceOnCpu<T>(run: () => Promise<T>): Promise<{ value: T; cpuMs: number }> {
  const before = cpuNow();
  const value = await run();
  return { value, cpuMs: cpuNow() - before };
}

// The fastest of three readings of `measure`, after one that is not counted.
// A reading is CPU milliseconds: the time a run took, or a time a build
// recorded on the CPU clock below.
export async function fastest(measure: () => Promise<number> | number): Promise<number> {
  await measure();
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 3; i++) best = Math.min(best, await measure());
  return best;
}

// Runs `run` with performance.now reading this process's CPU time, so the
// times a build records for its stages and plugins (status.stages, a
// plugin's ms) are CPU milliseconds. The code under test runs unchanged;
// only its clock is another one.
export async function onCpuClock<T>(run: () => Promise<T>): Promise<T> {
  const wall = performance.now;
  performance.now = cpuNow;
  try {
    return await run();
  } finally {
    performance.now = wall;
  }
}

// The CPU milliseconds a build records for one plugin (its run's ms), the
// fastest of three builds after one that is not counted.
export function pluginCpuMs(build: () => Promise<Graph>, plugin: string): Promise<number> {
  return fastest(async () => (await onCpuClock(build)).frameworks?.plugins.find((p) => p.id === plugin)?.ms ?? Number.POSITIVE_INFINITY);
}

// The CPU milliseconds a build records for one of its stages, the fastest of
// three builds after one that is not counted.
export function stageCpuMs(build: () => Promise<Graph>, stage: string): Promise<number> {
  return fastest(async () => (await onCpuClock(build)).status.stages[stage] ?? Number.POSITIVE_INFINITY);
}

// The CPU time of `read` over every source, each parsed beforehand, so only
// the reading is timed.
export async function readerCpuMs(lang: Lang, sources: readonly string[], read: (root: Node) => unknown): Promise<number> {
  const parser = await parserFor(lang);
  const trees = sources.map((source) => {
    const tree = parser.parse(source);
    if (!tree) throw new Error(`no ${lang} tree`);
    return tree;
  });
  try {
    return await cpuMs(() => {
      for (const tree of trees) read(tree.rootNode);
    });
  } finally {
    for (const tree of trees) tree.delete();
  }
}

// `small` is the CPU time at the smaller input, `large` at four times it:
// for inputs that cannot grow (a product cap stops them at the larger one).
export function expectLinear(what: string, small: number, large: number): void {
  const said = `${what}: ${small.toFixed(1)} ms of CPU time at the smaller input, ${large.toFixed(1)} ms at four times it`;
  expect(large / Math.max(small, NOISE_MS), said).toBeLessThan(MAX_GROWTH);
  expect(large, said).toBeLessThan(LOOSE_BOUND_MS);
}

// `smallAt(repeats)` and `largeAt(repeats)` are the CPU times of a run on
// the smaller input and on four times it, each repeated `repeats` times:
// for inputs a product cap keeps small (a manifest is read up to 1 MiB),
// where a larger input would leave the range the product reads. The count
// doubles until the smaller input's runs pass NOISE_MS, and both inputs are
// run as many times, so a step inside that range (a cost per byte that
// jumps between 256 KiB and 1 MiB) is still seen.
export async function expectLinearRepeated(what: string, smallAt: (repeats: number) => number | Promise<number>, largeAt: (repeats: number) => number | Promise<number>, opts: { maxRepeats?: number } = {}): Promise<void> {
  const maxRepeats = opts.maxRepeats ?? MAX_REPEATS;
  let repeats = 1;
  let small = await smallAt(repeats);
  while (small < NOISE_MS && repeats * 2 <= maxRepeats) {
    repeats *= 2;
    small = await smallAt(repeats);
  }
  const large = await largeAt(repeats);
  const said = `${what}: ${small.toFixed(1)} ms of CPU time for ${repeats} runs on the smaller input, ${large.toFixed(1)} ms for as many on four times it`;
  expect(large / Math.max(small, NOISE_MS), said).toBeLessThan(MAX_GROWTH);
  expect(large / repeats, said).toBeLessThan(LOOSE_BOUND_MS);
}

// `run` repeated `repeats` times, as a CPU time for expectLinearRepeated.
export const repeatedCpuMs = (run: () => unknown) => (repeats: number): Promise<number> =>
  cpuMs(() => {
    for (let i = 0; i < repeats; i++) run();
  });
