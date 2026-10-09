// Matches a test's literal request path to a route pattern, segment by
// segment, by hand: no pattern is ever compiled from repository text. A
// pattern is split into literal segments, `:param` slots and at most one
// `*glob` slot; optional groups `( )` are expanded into at most eight
// alternatives. Every comparison draws on the caller's budget.
import type { Budget } from "./routes.js";

export const MAX_REQUEST_CHARS = 512;
export const MAX_PATTERN_SEGMENTS = 32;
const MAX_OPTIONAL_GROUPS = 3;

type Seg = { kind: "lit"; v: string } | { kind: "param" } | { kind: "glob" };
export type Compiled = Seg[][]; // alternatives

const segOf = (s: string): Seg => {
  if (s.startsWith("*")) return { kind: "glob" };
  if (s.includes("*")) return { kind: "glob" };
  if (s.includes(":")) return { kind: "param" };
  return { kind: "lit", v: s };
};

// The alternatives of a pattern, or null when it is past a cap.
export function compilePattern(pattern: string): Compiled | null {
  if (pattern.length > MAX_REQUEST_CHARS * 2) return null;
  // Optional groups, outermost only: each kept or dropped.
  const groups: [number, number][] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "(") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === ")") {
      depth--;
      if (depth < 0) return null;
      if (depth === 0) groups.push([start, i]);
    }
  }
  if (depth !== 0 || groups.length > MAX_OPTIONAL_GROUPS) return null;
  const out: Compiled = [];
  for (let mask = 0; mask < 1 << groups.length; mask++) {
    let text = "";
    let from = 0;
    groups.forEach(([a, b], i) => {
      text += pattern.slice(from, a);
      // Inner parentheses of a kept group are dropped with their content kept.
      if (mask & (1 << i)) text += pattern.slice(a + 1, b).split("(").join("").split(")").join("");
      from = b + 1;
    });
    text += pattern.slice(from);
    const segs = text.split("/").filter((s) => s !== "").map(segOf);
    if (segs.length > MAX_PATTERN_SEGMENTS) return null;
    if (segs.filter((s) => s.kind === "glob").length > 1) return null;
    out.push(segs);
  }
  return out;
}

// The segments of a request path as a test writes it: the scheme and host,
// the query and the fragment cut off. Null past the length cap.
export function requestSegments(path: string): string[] | null {
  if (path.length > MAX_REQUEST_CHARS) return null;
  let p = path;
  for (const scheme of ["http://", "https://"]) {
    if (p.startsWith(scheme)) {
      const slash = p.indexOf("/", scheme.length);
      p = slash === -1 ? "/" : p.slice(slash);
    }
  }
  for (const cut of ["?", "#"]) {
    const at = p.indexOf(cut);
    if (at !== -1) p = p.slice(0, at);
  }
  const segs = p.split("/").filter((s) => s !== "");
  return segs.length > MAX_PATTERN_SEGMENTS * 2 ? null : segs;
}

function matchAlt(alt: Seg[], req: readonly string[], budget: Budget): boolean {
  const glob = alt.findIndex((s) => s.kind === "glob");
  const one = (s: Seg, r: string) => s.kind === "param" || (s.kind === "lit" && s.v === r);
  if (glob === -1) {
    if (alt.length !== req.length) return false;
    if (!budget.take(alt.length)) return false;
    for (let i = 0; i < alt.length; i++) if (!one(alt[i] as Seg, req[i] as string)) return false;
    return true;
  }
  // One glob: the segments before it from the start, the ones after it
  // from the end, and at least one segment for the glob itself.
  const after = alt.length - glob - 1;
  if (req.length < glob + after + 1) return false;
  if (!budget.take(alt.length)) return false;
  for (let i = 0; i < glob; i++) if (!one(alt[i] as Seg, req[i] as string)) return false;
  for (let i = 0; i < after; i++) if (!one(alt[alt.length - 1 - i] as Seg, req[req.length - 1 - i] as string)) return false;
  return true;
}

// Whether the request segments match the pattern: as written, or with a
// format extension on the last segment (`/posts/1.json`), which Rails
// patterns accept through their left-out `(.:format)`.
export function matches(compiled: Compiled, req: readonly string[], budget: Budget): boolean {
  for (const alt of compiled) if (matchAlt(alt, req, budget)) return true;
  const last = req[req.length - 1];
  const dot = last ? last.lastIndexOf(".") : -1;
  if (last && dot > 0) {
    const bare = [...req.slice(0, -1), last.slice(0, dot)];
    for (const alt of compiled) if (matchAlt(alt, bare, budget)) return true;
  }
  return false;
}

// The literal first segment of every alternative, or null when one starts
// with a slot (it can match any first segment).
export function firstLiterals(compiled: Compiled): string[] | null {
  const out: string[] = [];
  for (const alt of compiled) {
    const s = alt[0];
    if (!s) out.push("");
    else if (s.kind !== "lit") return null;
    else out.push(s.v);
  }
  return out;
}

// The number of leading segments a mount's prefix pattern has, when the
// request starts with them: the request's rest is matched against the
// mounted engine's routes. Null when it does not start with the prefix.
export function stripPrefix(compiled: Compiled, req: readonly string[], budget: Budget): string[] | null {
  for (const alt of compiled) {
    if (alt.some((s) => s.kind === "glob") || alt.length > req.length) continue;
    if (!budget.take(alt.length)) return null;
    let ok = true;
    for (let i = 0; i < alt.length && ok; i++) {
      const s = alt[i] as Seg;
      ok = s.kind === "param" || (s.kind === "lit" && s.v === req[i]);
    }
    if (ok) return req.slice(alt.length);
  }
  return null;
}
