// Bounded walks over the graph for the query layer: callers and callees to
// a depth, the shortest path between two points, and the cycles of the
// import graph. Every walk checks its budget (wall time, and the caller's
// cancellation) between expansions, so a question on a large graph stops
// within moments of its budget and says where it stopped: the frontier it
// had not expanded, never a count of what lies past it.
import { edgeId } from "./ids.js";
import type { Tier } from "../model/records.js";
import type { Graph, GraphEdge, GraphSite } from "../types.js";

export type Budget = {
  deadline: number; // performance.now() time
  signal: AbortSignal | null;
  stopped: boolean;
};

export const DEFAULT_QUERY_MS = 1000;
export const MAX_QUERY_MS = 60_000;

export function budgetOf(ms: number | undefined, signal: AbortSignal | null = null): Budget {
  const span = ms !== undefined && Number.isFinite(ms) ? Math.max(1, Math.min(ms, MAX_QUERY_MS)) : DEFAULT_QUERY_MS;
  return { deadline: performance.now() + span, signal, stopped: false };
}

// True once the budget is spent or the question was cancelled; it stays true.
export function spent(b: Budget): boolean {
  if (!b.stopped && (performance.now() > b.deadline || b.signal?.aborted === true)) b.stopped = true;
  return b.stopped;
}

export type Item = {
  from: string;
  to: string;
  kind: string; // calls, inherits, imports, or a relation a later phase adds
  depth: number;
  site: GraphSite;
  edge: string; // the edge id `explain` takes
  fromName: string | null;
  toName: string | null;
};

export const RANK: Record<Tier, number> = { certain: 0, likely: 1, possible: 2 };

export function toItem(g: Graph, e: { from: string; to: string; kind: string }, site: GraphSite, depth: number): Item {
  return { from: e.from, to: e.to, kind: e.kind, depth, site, edge: edgeId(e, site), fromName: g.nodes.get(e.from)?.name ?? null, toName: g.nodes.get(e.to)?.name ?? null };
}

export function sortItems(items: Item[]): Item[] {
  return items.sort((a, b) => a.depth - b.depth || RANK[a.site.tier] - RANK[b.site.tier] || a.site.file.localeCompare(b.site.file) || a.site.line - b.site.line || a.site.column - b.site.column);
}

// Import edges by the file that imports: the graph keeps them by target.
const importsOut = new WeakMap<Graph, Map<string, GraphEdge[]>>();
export function importsFrom(g: Graph, file: string): GraphEdge[] {
  let byFrom = importsOut.get(g);
  if (!byFrom) {
    byFrom = new Map();
    for (const list of g.importers.values()) for (const e of list) (byFrom.get(e.from) ?? byFrom.set(e.from, []).get(e.from))?.push(e);
    importsOut.set(g, byFrom);
  }
  return byFrom.get(file) ?? [];
}

// Go imports name a package folder (`go:<dir>`): the files of that folder.
const goFolders = new WeakMap<Graph, Map<string, string[]>>();
function goFilesOf(g: Graph, target: string): string[] {
  let byDir = goFolders.get(g);
  if (!byDir) {
    byDir = new Map();
    for (const file of g.defsByFile.keys()) {
      if (!file.endsWith(".go")) continue;
      const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
      (byDir.get(dir) ?? byDir.set(dir, []).get(dir))?.push(file);
    }
    goFolders.set(g, byDir);
  }
  return byDir.get(target.slice(3)) ?? [];
}

// The edges leaving (or entering) a point, of the asked kinds. A file's
// imports are edges out of the file; a Go package import reaches every
// file of the folder.
export function neighbours(g: Graph, at: string, dir: "in" | "out", kinds: ReadonlySet<string> | null): { edge: GraphEdge; other: string }[] {
  const out: { edge: GraphEdge; other: string }[] = [];
  // The default (null) is what `in` and `out` hold: calls and inheritance.
  const want = (k: string) => kinds === null || kinds.has(k);
  for (const e of (dir === "in" ? g.in.get(at) : g.out.get(at)) ?? []) if (want(e.kind)) out.push({ edge: e, other: dir === "in" ? e.from : e.to });
  if (kinds !== null && kinds.has("imports")) {
    if (dir === "out") {
      for (const e of importsFrom(g, at)) {
        if (e.to.startsWith("go:")) for (const f of goFilesOf(g, e.to)) out.push({ edge: e, other: f });
        else out.push({ edge: e, other: e.to });
      }
    } else {
      for (const e of g.importers.get(at) ?? []) out.push({ edge: e, other: e.from });
      if (at.endsWith(".go")) {
        const dir2 = at.includes("/") ? at.slice(0, at.lastIndexOf("/")) : "";
        for (const e of g.importers.get(`go:${dir2}`) ?? []) out.push({ edge: e, other: e.from });
      }
    }
  }
  return out;
}

export type WalkResult = {
  items: Item[];
  stopped: boolean; // the budget ran out
  beyond: boolean; // a point at the last depth has more edges past it
  frontier: string[]; // points not expanded when the walk stopped, or past the last depth
};

// Edges into or out of `start` to `depth` hops; each item keeps its hop.
// The default kinds (null) are the ones `in` and `out` hold: calls and
// inheritance, as the review's walk reads them.
export function walk(g: Graph, start: string, dir: "in" | "out", depth: number, tiers: ReadonlySet<Tier>, budget: Budget, kinds: ReadonlySet<string> | null = null): WalkResult {
  const items: Item[] = [];
  const seen = new Set([start]);
  let frontier = [start];
  for (let d = 1; d <= depth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const [i, at] of frontier.entries()) {
      if (spent(budget)) return { items: sortItems(items), stopped: true, beyond: true, frontier: [...frontier.slice(i), ...next] };
      for (const { edge: e, other } of neighbours(g, at, dir, kinds)) {
        for (const site of e.sites) if (tiers.has(site.tier)) items.push(toItem(g, e, site, d));
        if (!seen.has(other)) {
          seen.add(other);
          next.push(other);
        }
      }
    }
    frontier = next;
  }
  // Points one hop past the last depth: the answer stops at the depth asked.
  const past = frontier.filter((at) => neighbours(g, at, dir, kinds).some(({ other }) => !seen.has(other)));
  return { items: sortItems(items), stopped: false, beyond: past.length > 0, frontier: past };
}

// `beyond`: the search used every hop it may take and still had points to
// expand, so a longer path may exist.
export type PathResult = { hops: Item[] | null; stopped: boolean; beyond: boolean; expanded: number; visited: Set<string> };

// The shortest directed path from `a` to `b` over the asked kinds, at most
// `depth` hops; each hop is one edge with its strongest site.
export function shortestPath(g: Graph, a: string, b: string, kinds: ReadonlySet<string>, depth: number, tiers: ReadonlySet<Tier>, budget: Budget): PathResult {
  const parent = new Map<string, { from: string; edge: GraphEdge; site: GraphSite }>();
  const visited = new Set([a]);
  let frontier = [a];
  let expanded = 0;
  const strongest = (e: GraphEdge) => e.sites.filter((s) => tiers.has(s.tier)).sort((x, y) => RANK[x.tier] - RANK[y.tier] || x.file.localeCompare(y.file) || x.line - y.line)[0];
  for (let d = 1; d <= depth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const at of frontier) {
      if (spent(budget)) return { hops: null, stopped: true, beyond: true, expanded, visited };
      expanded++;
      for (const { edge: e, other } of neighbours(g, at, "out", kinds)) {
        if (visited.has(other)) continue;
        const site = strongest(e);
        if (!site) continue;
        visited.add(other);
        parent.set(other, { from: at, edge: e, site });
        if (other === b) {
          const hops: Item[] = [];
          let cur = b;
          while (cur !== a) {
            const p = parent.get(cur) as { from: string; edge: GraphEdge; site: GraphSite };
            hops.unshift({ ...toItem(g, { from: p.from, to: cur, kind: p.edge.kind }, p.site, 0), edge: edgeId(p.edge, p.site) });
            cur = p.from;
          }
          return { hops: hops.map((h, i) => ({ ...h, depth: i + 1 })), stopped: false, beyond: false, expanded, visited };
        }
        next.push(other);
      }
    }
    frontier = next;
  }
  return { hops: null, stopped: false, beyond: frontier.length > 0, expanded, visited };
}

// Strongly connected components with more than one member (or a member
// that reaches itself), by Tarjan's method without recursion.
export function cycles(nodes: readonly string[], next: (n: string) => readonly string[], budget: Budget): { groups: string[][]; stopped: boolean } {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const groups: string[][] = [];
  let counter = 0;
  for (const root of nodes) {
    if (index.has(root)) continue;
    const work: { n: string; i: number; succ: readonly string[] }[] = [];
    const open = (n: string) => {
      index.set(n, counter);
      low.set(n, counter);
      counter++;
      stack.push(n);
      onStack.add(n);
      work.push({ n, i: 0, succ: next(n) });
    };
    open(root);
    while (work.length > 0) {
      if (spent(budget)) return { groups, stopped: true };
      const top = work[work.length - 1] as { n: string; i: number; succ: readonly string[] };
      if (top.i < top.succ.length) {
        const s = top.succ[top.i++] as string;
        if (!index.has(s)) open(s);
        else if (onStack.has(s)) low.set(top.n, Math.min(low.get(top.n) as number, index.get(s) as number));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.n, Math.min(low.get(parent.n) as number, low.get(top.n) as number));
      if (low.get(top.n) === index.get(top.n)) {
        const group: string[] = [];
        let m: string;
        do {
          m = stack.pop() as string;
          onStack.delete(m);
          group.push(m);
        } while (m !== top.n);
        if (group.length > 1 || next(top.n).includes(top.n)) groups.push(group.sort());
      }
    }
  }
  return { groups, stopped: false };
}
