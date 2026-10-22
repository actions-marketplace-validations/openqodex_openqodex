// The code around the change, for every language: the identifiers on the
// changed lines, ranked by how rare they are in the snapshot, and where each
// one is declared and used, with a few lines of context. Written inside the
// snapshot before its hash is taken, so the sealed reviewer can read it, and
// rendered into every brief as "## Code around the change". Built by O1 of
// .private/plan-review-reasoning/PLAN.md; the signatures below are the
// contract the other builders code against, so they throw until built.
import type { Change, ImpactSummary } from "@openqodex/core";

// One place a symbol occurs. `kind` says whether a declaration regex matched
// the line (a label, never a selector). `context` is the lines around it,
// numbered as the snapshot holds them. `from` says who found it.
export type NeighbourhoodSite = { path: string; line: number; kind: "declared" | "used"; context: string; from: "graph" | "text" };

// One symbol: its name, the changed files whose changed lines hold it, how
// many snapshot files hold it, and its sites (declarations first).
export type NeighbourhoodSymbol = { name: string; changedIn: string[]; files: number; sites: NeighbourhoodSite[] };

// The packet: the symbols, where the packet was written inside the snapshot
// (a path relative to the snapshot root, null when nothing was written), and
// whether the time or size cap cut it (`partial` with the reason).
export type Neighbourhood = {
  symbols: NeighbourhoodSymbol[];
  packetPath: string | null;
  partial: string | null;
  durationMs: number;
};

export const NEIGHBOURHOOD_TIME_MS = 10_000;
export const NEIGHBOURHOOD_MAX_BYTES = 64 * 1024;
export const NEIGHBOURHOOD_BLOCK_BYTES = 24 * 1024;
export const NEIGHBOURHOOD_MAX_FILES_PER_SYMBOL = 200;
export const NEIGHBOURHOOD_SITES_PER_SYMBOL = 12;
export const NEIGHBOURHOOD_SYMBOLS_PER_FILE = 30;

// Builds the packet from the change and the snapshot tree and writes it
// inside the snapshot (the caller takes the snapshot's hash afterwards).
// `impact`: the graph's view, whose certain callers are listed first.
// Never throws: a failure is a packet with `partial` set and no symbols.
export function buildNeighbourhood(_args: { change: Change; snapshotDir: string; impact: ImpactSummary | null; now?: () => number }): Neighbourhood {
  throw new Error("buildNeighbourhood is not built yet");
}

// The "## Code around the change" block for a brief: the entries whose
// symbols were changed in `forFiles` (every changed file when left out), at
// most NEIGHBOURHOOD_BLOCK_BYTES, and the packet's path for the rest. Empty
// string when the packet has nothing.
export function renderNeighbourhoodBlock(_packet: Neighbourhood, _forFiles?: readonly string[]): string {
  throw new Error("renderNeighbourhoodBlock is not built yet");
}
