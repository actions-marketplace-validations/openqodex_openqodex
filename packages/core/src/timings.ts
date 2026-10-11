// The stopwatch behind a report's `timings` (RunTimings in types.ts).
import type { RunTimings } from "./types.js";

export type RunPhase = "change" | "scan" | "graph" | "brief" | "reviewer" | "finalize";

// A run's phases on the run's clock. From one enter() to the next, the time
// goes to the phase entered; before the first enter() and after
// enter(null), to no phase. timings() reads the clock: the time each phase
// the run entered took, and total_ms since `start`. The run goes on in the
// same phase after a reading.
export type PhaseClock = {
  enter(phase: RunPhase | null): void;
  timings(): RunTimings;
};

export function phaseClock(now: () => number, start: number = now()): PhaseClock {
  const spent = new Map<RunPhase, number>();
  let current: RunPhase | null = null;
  let since = start;
  const lap = (): number => {
    const at = now();
    if (current !== null) spent.set(current, (spent.get(current) ?? 0) + (at - since));
    since = at;
    return at;
  };
  return {
    enter(phase) {
      lap();
      current = phase;
    },
    timings() {
      const end = lap();
      const ran = (phase: RunPhase, key: keyof RunTimings): Partial<RunTimings> => (spent.has(phase) ? { [key]: spent.get(phase) } : {});
      return {
        change_ms: spent.get("change") ?? 0,
        scan_ms: spent.get("scan") ?? 0,
        ...ran("graph", "graph_ms"),
        ...ran("brief", "brief_ms"),
        ...ran("reviewer", "reviewer_ms"),
        ...ran("finalize", "finalize_ms"),
        total_ms: end - start,
      };
    },
  };
}
