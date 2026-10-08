// Pages and cuts of an answer's list. A cursor names the build it was made
// on, the request it belongs to and the position after the last item, so a
// cursor from another request or another build is refused, never answered
// from a newer graph. A token budget cuts items, never counts: the counts
// stay the true totals, and the cut says how many items it left out.
//
// Pagination is apart from analysis: `truncated` says what the page left
// out of a list the graph knows; `unknown` says what the graph could not see.
import { createHash } from "node:crypto";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;
// A rough count of tokens in an item: JSON characters over four.
const CHARS_PER_TOKEN = 4;

export type Truncated = {
  by: "limit" | "depth" | "budget" | null;
  omitted: number | null; // exact when omittedExact; null when it cannot be counted
  omittedExact: boolean;
  cursor: string | null;
  // The symbols a traversal had not expanded when it stopped (budget or
  // depth), up to 50; their count is `frontierTotal`.
  frontier?: string[];
  frontierTotal?: number;
};

// What of a request a cursor is bound to: everything but the position and
// the page size and budget, which a client may change between pages.
type Bindable = { cursor?: string; limit?: number; budget?: unknown };

function fingerprint(req: Bindable): string {
  const { cursor: _c, limit: _l, budget: _b, ...rest } = req as Record<string, unknown>;
  return createHash("sha1").update(JSON.stringify(rest)).digest("hex").slice(0, 16);
}

export function cursorFor(generation: string | null, req: Bindable, offset: number): string {
  return Buffer.from(JSON.stringify({ g: generation, f: fingerprint(req), o: offset })).toString("base64url");
}

const MAX_CURSOR = 4096;

// The position a cursor names; "bad" when it belongs to another request or build.
export function offsetOf(generation: string | null, req: Bindable): number | "bad" {
  if (!req.cursor) return 0;
  if (req.cursor.length > MAX_CURSOR) return "bad";
  try {
    const c = JSON.parse(Buffer.from(req.cursor, "base64url").toString("utf8")) as { g: unknown; f: unknown; o: unknown };
    return c.g === generation && c.f === fingerprint(req) && Number.isInteger(c.o) && (c.o as number) >= 0 ? (c.o as number) : "bad";
  } catch {
    return "bad";
  }
}

export function limitOf(req: { limit?: number; budget?: { items?: number } }): number {
  const asked = Number.isFinite(req.limit) ? (req.limit as number) : DEFAULT_LIMIT;
  const items = req.budget?.items !== undefined && Number.isFinite(req.budget.items) ? req.budget.items : MAX_LIMIT;
  return Math.max(1, Math.min(Math.floor(asked), Math.floor(items), MAX_LIMIT));
}

// One page of `all`, cut further by the token budget. At least one item is
// returned when any is left, so a client paging with a tiny budget still
// moves forward.
export function page<T>(generation: string | null, req: Bindable & { limit?: number; budget?: { items?: number; tokens?: number } }, all: readonly T[]): { items: T[]; truncated: Truncated } | "bad" {
  const offset = offsetOf(generation, req);
  if (offset === "bad") return "bad";
  let items = all.slice(offset, offset + limitOf(req));
  let byTokens = false;
  const tokens = req.budget?.tokens;
  if (tokens !== undefined && Number.isFinite(tokens)) {
    let used = 0;
    let kept = 0;
    for (const item of items) {
      used += Math.ceil(JSON.stringify(item).length / CHARS_PER_TOKEN);
      if (used > tokens && kept > 0) break;
      kept++;
    }
    if (kept < items.length) {
      items = items.slice(0, kept);
      byTokens = true;
    }
  }
  const rest = all.length - offset - items.length;
  const next = rest > 0 ? cursorFor(generation, req, offset + items.length) : null;
  return { items, truncated: { by: rest > 0 ? (byTokens ? "budget" : "limit") : null, omitted: Math.max(0, rest), omittedExact: true, cursor: next } };
}
