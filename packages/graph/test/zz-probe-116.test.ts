// Temporary probe for issue 116, removed before the pull request is ready:
// it prints the CPU time per character of the two readers that failed the
// ratio test on the Linux runner, at four sizes, and the test's own ratio at
// three size pairs. It asserts nothing.
import { describe, it } from "vitest";
import { cpus } from "node:os";
import { readFileSync } from "node:fs";
import { PerformanceObserver } from "node:perf_hooks";
import { goModRequires, goModule, requirementsDeps } from "../src/discovery/manifests.js";

const KiB = 1024;
const MiB = 1024 * KiB;
const shape = (head: string, unit: string, tail = "") => (size: number) => head + unit.repeat(Math.ceil((size - head.length - tail.length) / unit.length)) + tail;
const cpuNow = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};
let gcCount = 0;
let gcMs = 0;
const observer = new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    gcCount++;
    gcMs += e.duration;
  }
});
observer.observe({ entryTypes: ["gc"] });
const flush = () => new Promise((r) => setImmediate(r));

const inputs: [string, (size: number) => string, (t: string) => unknown][] = [
  ["requirements input 3", shape("a[", "x"), requirementsDeps],
  ["go.mod input 1", shape("require ", "a.", " "), (t) => [goModRequires(t), goModule(t)]],
  ["requirements input 1", shape("a", " ", "#"), requirementsDeps],
];
const sizes = [MiB / 16, MiB / 4, MiB, 4 * MiB];
const label = (s: number) => (s >= MiB ? `${s / MiB}M` : `${s / KiB}K`);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;

function sys(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "-";
  }
}

describe("probe 116", () => {
  it("machine", () => {
    const caches = [0, 1, 2, 3].map((i) => `${sys(`/sys/devices/system/cpu/cpu0/cache/index${i}/level`)}:${sys(`/sys/devices/system/cpu/cpu0/cache/index${i}/type`)}:${sys(`/sys/devices/system/cpu/cpu0/cache/index${i}/size`)}`);
    console.log(`PROBE machine: ${cpus()[0]?.model} x${cpus().length}, node ${process.version}, caches ${caches.join(" ")}, smt ${sys("/sys/devices/system/cpu/smt/active")}`);
  });

  for (const [name, make, read] of inputs) {
    it(`cost per character, interleaved: ${name}`, async () => {
      const texts = sizes.map((s) => make(s));
      for (const t of texts) read(t);
      const per: number[][] = sizes.map(() => []);
      const gcs: number[] = sizes.map(() => 0);
      const gcTimes: number[] = sizes.map(() => 0);
      for (let round = 0; round < 10; round++) {
        for (const [i, size] of sizes.entries()) {
          const text = texts[i] as string;
          const repeats = Math.max(1, Math.round((16 * MiB) / size));
          await flush();
          const c0 = gcCount;
          const g0 = gcMs;
          const before = cpuNow();
          for (let r = 0; r < repeats; r++) read(text);
          const ms = cpuNow() - before;
          await flush();
          gcs[i] = (gcs[i] as number) + gcCount - c0;
          gcTimes[i] = (gcTimes[i] as number) + gcMs - g0;
          if (round > 0) (per[i] as number[]).push((ms * 1e6) / (repeats * text.length));
        }
      }
      const rows = sizes.map((s, i) => `${label(s)} min ${Math.min(...(per[i] as number[])).toFixed(3)} med ${median(per[i] as number[]).toFixed(3)} max ${Math.max(...(per[i] as number[])).toFixed(3)} ns/char, gc ${gcs[i]} (${(gcTimes[i] as number).toFixed(1)} ms)`);
      const pairs = sizes.slice(1).map((s, i) => {
        const a = per[i] as number[];
        const b = per[i + 1] as number[];
        return `${label(sizes[i] as number)}->${label(s)} ratio of mins ${((4 * Math.min(...b)) / Math.min(...a)).toFixed(2)}, of medians ${((4 * median(b)) / median(a)).toFixed(2)}`;
      });
      console.log(`PROBE per-char ${name}: ${rows.join(" | ")}\nPROBE pairs ${name}: ${pairs.join(" | ")}`);
    }, 300_000);
  }

  // The test's own procedure (expectLinearRepeated with repeatedCpuMs), its
  // ratio printed instead of asserted, at three size pairs.
  async function procedure(read: (t: string) => unknown, small: string, large: string): Promise<{ ratio: number; repeats: number; s: number; l: number }> {
    const at = (text: string) => async (repeats: number) => {
      const run = () => {
        for (let i = 0; i < repeats; i++) read(text);
      };
      run();
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 3; i++) {
        const before = cpuNow();
        run();
        best = Math.min(best, cpuNow() - before);
      }
      return best;
    };
    let repeats = 1;
    let s = await at(small)(repeats);
    while (s < 50 && repeats * 2 <= 1024) {
      repeats *= 2;
      s = await at(small)(repeats);
    }
    const l = await at(large)(repeats);
    return { ratio: l / Math.max(s, 50), repeats, s, l };
  }

  for (const [name, make, read] of inputs.slice(0, 2)) {
    it(`the test's procedure at three pairs: ${name}`, async () => {
      for (const [a, b] of [
        [MiB / 16, MiB / 4],
        [MiB / 4, MiB],
        [MiB, 4 * MiB],
      ] as const) {
        const small = make(a);
        const large = make(b);
        const out: string[] = [];
        for (let k = 0; k < 4; k++) {
          const r = await procedure(read, small, large);
          out.push(`${r.ratio.toFixed(2)} (${r.s.toFixed(1)}/${r.l.toFixed(1)} ms x${r.repeats})`);
        }
        console.log(`PROBE procedure ${name} ${label(a)}->${label(b)}: ${out.join(", ")}`);
      }
    }, 600_000);
  }
});
