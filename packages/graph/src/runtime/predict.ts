// The five-second rule (owner, 2026-10-07 and 2026-10-08): when the build
// the next review needs, from cached facts, is predicted to take under five
// seconds, the graph is built fresh from facts; otherwise the retained
// index of the same capture is used when there is one. The prediction sums
// the stages from their own drivers: missing facts at the measured parse
// rate, cached facts at the measured read rate, and everything else
// (listing, resolving, the review packet) per eligible file. The first
// build uses the defaults below; every build replaces them with what this
// machine measured, so a slower machine re-measures itself.
//
// The mode flips only after two consecutive builds land on the other side
// of the line; a build on the line keeps the current mode.

export const FIVE_SECONDS_MS = 5000;
const MIN_SAMPLE = 20; // a rate is measured only over this many files or more

export type Rates = { coldPerSec: number; warmPerSec: number; otherMsPerFile: number };

export const DEFAULT_RATES: Rates = { coldPerSec: 400, warmPerSec: 2500, otherMsPerFile: 0.25 };

export type Mode = "fresh" | "retained";

export type BuildRecord = { at: string; eligible: number; parsed: number; cached: number; predictedMs: number; actualMs: number; mode: Mode };

export type PredictMeta = {
  version: 1;
  rates: Rates;
  mode: Mode;
  streak: number; // consecutive predictions on the other side of the line
  last: BuildRecord[]; // the last ten builds
};

export function predictMs(meta: PredictMeta | null, n: { eligible: number; cached: number }): number {
  const r = meta?.rates ?? DEFAULT_RATES;
  const missing = Math.max(0, n.eligible - n.cached);
  return Math.round((missing / r.coldPerSec) * 1000 + (n.cached / r.warmPerSec) * 1000 + n.eligible * r.otherMsPerFile);
}

export function decideMode(meta: PredictMeta | null, predictedMs: number): { mode: Mode; streak: number } {
  const side: Mode | null = predictedMs < FIVE_SECONDS_MS ? "fresh" : predictedMs > FIVE_SECONDS_MS ? "retained" : null;
  if (meta === null) return { mode: side ?? "fresh", streak: 0 };
  if (side === null || side === meta.mode) return { mode: meta.mode, streak: 0 };
  const streak = meta.streak + 1;
  return streak >= 2 ? { mode: side, streak: 0 } : { mode: meta.mode, streak };
}

// The meta after a build: its measured rates (each only when the build
// measured enough files for it), its mode and the record of the build. A
// build that only loaded a kept index measured no rate: `rates: false`.
export function recordBuild(
  meta: PredictMeta | null,
  b: { eligible: number; parsed: number; cached: number; stages: { parse: number; facts: number; other: number }; predictedMs: number; actualMs: number; mode: Mode; streak?: number },
  opts: { rates?: boolean } = {},
): PredictMeta {
  const rates: Rates = { ...(meta?.rates ?? DEFAULT_RATES) };
  const measured = opts.rates !== false;
  if (measured && b.parsed >= MIN_SAMPLE && b.stages.parse > 0) rates.coldPerSec = b.parsed / (b.stages.parse / 1000);
  if (measured && b.cached >= MIN_SAMPLE && b.stages.facts > 0) rates.warmPerSec = b.cached / (b.stages.facts / 1000);
  if (measured && b.eligible >= MIN_SAMPLE && b.stages.other >= 0) rates.otherMsPerFile = b.stages.other / b.eligible;
  const record: BuildRecord = { at: new Date().toISOString(), eligible: b.eligible, parsed: b.parsed, cached: b.cached, predictedMs: b.predictedMs, actualMs: b.actualMs, mode: b.mode };
  return { version: 1, rates, mode: b.mode, streak: b.streak ?? 0, last: [...(meta?.last ?? []), record].slice(-10) };
}

// The meta as the store holds it, when it has the expected shape.
export function asPredictMeta(v: unknown): PredictMeta | null {
  if (typeof v !== "object" || v === null) return null;
  const m = v as Partial<PredictMeta>;
  const r = m.rates;
  const ok = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x > 0;
  if (m.version !== 1 || !r || !ok(r.coldPerSec) || !ok(r.warmPerSec) || typeof r.otherMsPerFile !== "number" || r.otherMsPerFile < 0) return null;
  if ((m.mode !== "fresh" && m.mode !== "retained") || typeof m.streak !== "number" || !Array.isArray(m.last)) return null;
  return m as PredictMeta;
}
