// What a change reaches: the symbols it touches or removes, their callers
// two hops out over calls and inheritance, what they call one hop out, and
// the files that import a changed file. Every call site is kept.
import { dirname } from "node:path";
import type { Change, ImpactEdge, ImpactPath, ImpactSummary, ImpactSymbol } from "@openqodex/core";
import type { Graph, GraphEdge, GraphNode, HotSymbol, Miss } from "./types.js";

export const HUB_CALLERS = 40; // a symbol with more direct callers is a hub
export const HUB_SHOWN = 20; // callers kept for a hub
export const WALK_LIMIT = 200; // symbols the whole walk may reach
export const INLINE_SITES = 60; // call sites the brief shows

const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs|testdata|fixtures?)\/|[._-](test|spec)\.[^/]+$|_test\.go$|(^|\/)test_[^/]+\.py$|_spec\.rb$/;

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path);
}

// Folders between two files: 0 for the same folder.
function distance(a: string, b: string): number {
  const pa = dirname(a).split("/");
  const pb = dirname(b).split("/");
  let common = 0;
  while (common < pa.length && common < pb.length && pa[common] === pb[common]) common++;
  return pa.length - common + (pb.length - common);
}

function toImpactEdge(e: GraphEdge): ImpactEdge {
  return { from: e.from, to: e.to, kind: e.kind, sites: e.sites };
}

function toSymbol(n: GraphNode): ImpactSymbol {
  return { id: n.id, file: n.file, name: n.name, kind: n.kind, startLine: n.startLine, endLine: n.endLine, snapshot: n.snapshot };
}

// Production files before tests, then the nearest folder, then by path and line.
function byCloseness(seedFile: string) {
  return (a: GraphEdge, b: GraphEdge): number => {
    const fa = a.sites[0]?.file ?? a.from;
    const fb = b.sites[0]?.file ?? b.from;
    return (
      Number(isTestPath(fa)) - Number(isTestPath(fb)) ||
      distance(seedFile, fa) - distance(seedFile, fb) ||
      fa.localeCompare(fb) ||
      (a.sites[0]?.line ?? 0) - (b.sites[0]?.line ?? 0)
    );
  };
}

export function emptyImpact(status: "off" | "skipped" | "failed", reason: string): ImpactSummary {
  return {
    version: 1,
    status,
    reasons: [reason],
    risk: null,
    build: { durationMs: 0, cacheHits: 0, eligibleFiles: 0, parsedFiles: 0, omittedFiles: 0, unresolvedSites: 0 },
    symbols: [],
    touched: [],
    removed: [],
    callers: [],
    callees: [],
    importers: [],
    hubs: [],
    truncated: { walk: false, inline: false, omittedSites: null },
  };
}

function riskFor(touched: number, callers: number, removedStillCalled: boolean): ImpactSummary["risk"] {
  if (touched === 0) return "none";
  if (removedStillCalled || callers > 8 || touched > 12) return "high";
  if (callers >= 1 || touched > 4) return "medium";
  return "low";
}

// Miss targets that point at a removed symbol: its file (old or new path),
// its Go package, or its class.
function missTargets(node: GraphNode, path: string): Set<string> {
  const owner = node.id.slice(node.id.indexOf("#") + 1, node.id.lastIndexOf("@")).split(".").slice(0, -1).join(".");
  const out = new Set<string>();
  for (const file of new Set([node.file, path])) {
    const dir = dirname(file) === "." ? "" : dirname(file);
    if (owner) {
      out.add(`${file}::${owner}`);
      out.add(`go:${dir}::${owner}`);
      out.add(`rb::${owner}`);
    } else {
      out.add(file);
      out.add(`go:${dir}`);
    }
  }
  return out;
}

export function detectImpact(graph: Graph, change: Pick<Change, "files" | "coverage">): ImpactSummary {
  const s = graph.status;
  const symbols = new Map<string, ImpactSymbol>();
  const note = (id: string) => {
    if (symbols.has(id)) return;
    const n = graph.nodes.get(id);
    if (n) symbols.set(id, toSymbol(n));
  };

  // Touched: the innermost symbol around each changed line, and any symbol
  // whose first line changed.
  const touched: string[] = [];
  const touchedSet = new Set<string>();
  for (const f of change.files) {
    if (f.status === "deleted") continue;
    const lines = change.coverage.get(f.path);
    const defs = graph.defsByFile.get(f.path);
    if (!lines || !defs) continue;
    for (const line of lines) {
      let inner: GraphNode | null = null;
      for (const d of defs) {
        if (line < d.startLine || line > d.endLine) continue;
        if (line === d.startLine && !touchedSet.has(d.id)) {
          touchedSet.add(d.id);
          touched.push(d.id);
        }
        if (!inner || d.endLine - d.startLine < inner.endLine - inner.startLine) inner = d;
      }
      if (inner && !touchedSet.has(inner.id)) {
        touchedSet.add(inner.id);
        touched.push(inner.id);
      }
    }
  }
  touched.forEach(note);

  // Removed: in the base version of a changed file and gone now; callers are
  // the current call sites whose evidence still points at them.
  const removed: string[] = [];
  const missesByName = new Map<string, Miss[]>();
  for (const m of graph.misses) {
    const list = missesByName.get(m.name);
    if (list) list.push(m);
    else missesByName.set(m.name, [m]);
  }
  const removedEdges = new Map<string, GraphEdge[]>();
  for (const f of change.files) {
    for (const node of graph.removed.get(f.path) ?? []) {
      removed.push(node.id);
      symbols.set(node.id, toSymbol(node));
      const targets = missTargets(node, f.path);
      const byFrom = new Map<string, GraphEdge>();
      for (const m of missesByName.get(node.name) ?? []) {
        if (!targets.has(m.target)) continue;
        let e = byFrom.get(m.from);
        if (!e) byFrom.set(m.from, (e = { from: m.from, to: node.id, kind: "calls", confidence: "high", sites: [] }));
        e.sites.push(m.site);
      }
      if (byFrom.size > 0) removedEdges.set(node.id, [...byFrom.values()]);
    }
  }

  // Callers: two hops back over calls and inheritance.
  const callers: ImpactPath[] = [];
  const hubs: ImpactSummary["hubs"] = [];
  const reached = new Set<string>([...touched, ...removed]);
  let walkCut = false;
  const incoming = (id: string): GraphEdge[] => removedEdges.get(id) ?? graph.in.get(id) ?? [];
  const seedFile = (id: string) => symbols.get(id)?.file ?? graph.nodes.get(id)?.file ?? "";

  const firstHop: { seed: string; edge: GraphEdge }[] = [];
  for (const seed of [...touched, ...removed]) {
    let edges = incoming(seed).filter((e) => e.from !== seed);
    if (edges.length > HUB_CALLERS) {
      const sites = edges.reduce((n, e) => n + e.sites.length, 0);
      const files = new Set(edges.flatMap((e) => e.sites.map((x) => x.file))).size;
      hubs.push({ symbol: seed, callers: edges.length, sites, files });
      edges = [...edges].sort(byCloseness(seedFile(seed))).slice(0, HUB_SHOWN);
    } else edges = [...edges].sort(byCloseness(seedFile(seed)));
    for (const edge of edges) {
      if (reached.size >= WALK_LIMIT && !reached.has(edge.from)) {
        walkCut = true;
        break;
      }
      reached.add(edge.from);
      note(edge.from);
      firstHop.push({ seed, edge });
      callers.push({ seed, edges: [toImpactEdge(edge)] });
    }
  }
  for (const { seed, edge } of firstHop) {
    if (walkCut) break;
    if (graph.nodes.get(edge.from)?.kind === "file") continue; // a file's top level has no callers
    const next = incoming(edge.from)
      .filter((e) => !reached.has(e.from))
      .sort(byCloseness(seedFile(edge.from)))
      .slice(0, HUB_SHOWN);
    for (const e2 of next) {
      if (reached.size >= WALK_LIMIT) {
        walkCut = true;
        break;
      }
      reached.add(e2.from);
      note(e2.from);
      callers.push({ seed, edges: [toImpactEdge(edge), toImpactEdge(e2)] });
    }
  }

  // Callees: one hop out of the touched code.
  const callees: ImpactPath[] = [];
  for (const seed of touched) {
    for (const e of graph.out.get(seed) ?? []) {
      if (touchedSet.has(e.to)) continue;
      note(e.to);
      callees.push({ seed, edges: [toImpactEdge(e)] });
    }
  }

  // Importers of each changed file; for Go, of its package from other folders.
  const importers: ImpactEdge[] = [];
  const seenImporter = new Set<string>();
  for (const f of change.files) {
    const dir = dirname(f.path) === "." ? "" : dirname(f.path);
    for (const e of [...(graph.importers.get(f.path) ?? []), ...(f.path.endsWith(".go") ? (graph.importers.get(`go:${dir}`) ?? []) : [])]) {
      const key = `${e.from}\0${e.to}`;
      if (seenImporter.has(key)) continue;
      seenImporter.add(key);
      importers.push(toImpactEdge(e));
      note(e.from);
    }
  }

  // Nearest first across all seeds: one hop before two, production before tests.
  const rank = (p: ImpactPath) => {
    const last = p.edges[p.edges.length - 1] as ImpactEdge;
    return p.edges.length * 2 + Number(isTestPath(last.sites[0]?.file ?? last.from));
  };
  callers.sort((a, b) => rank(a) - rank(b));

  const callerIds = new Set(callers.map((p) => (p.edges[p.edges.length - 1] as ImpactEdge).from));
  const removedStillCalled = removed.some((id) => removedEdges.has(id));
  const totalSites = callers.reduce((n, p) => n + (p.edges[p.edges.length - 1] as ImpactEdge).sites.length, 0);

  return {
    version: 1,
    status: s.status,
    reasons: s.reasons,
    risk: riskFor(touched.length + removed.length, callerIds.size, removedStillCalled),
    build: {
      durationMs: s.durationMs,
      cacheHits: s.cacheHits,
      eligibleFiles: s.eligibleFiles,
      parsedFiles: s.filesParsed,
      omittedFiles: s.filesSkipped,
      unresolvedSites: s.unresolvedSites,
    },
    symbols: [...symbols.values()],
    touched,
    removed,
    callers,
    callees,
    importers,
    hubs,
    truncated: {
      walk: walkCut || hubs.length > 0,
      inline: totalSites > INLINE_SITES,
      omittedSites: totalSites > INLINE_SITES ? totalSites - INLINE_SITES : null,
    },
  };
}

// The most called symbols, for a review of the whole repo.
export function hotSymbols(graph: Graph, n: number): HotSymbol[] {
  const out: HotSymbol[] = [];
  for (const [id, edges] of graph.in) {
    const symbol = graph.nodes.get(id);
    if (!symbol || symbol.kind === "file") continue;
    const callers = new Set(edges.map((e) => e.from)).size;
    const sites = edges.reduce((k, e) => k + e.sites.length, 0);
    const files = new Set(edges.flatMap((e) => e.sites.map((x) => x.file))).size;
    out.push({ symbol, callers, sites, files });
  }
  return out.sort((a, b) => b.callers - a.callers || b.sites - a.sites || a.symbol.id.localeCompare(b.symbol.id)).slice(0, n);
}
