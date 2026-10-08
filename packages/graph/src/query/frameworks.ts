// Routes and tests: the two questions the framework layer answers (PLAN.md
// 3.2.3, phase 4). The layer's output is read here and nowhere else in the
// query, by its documented shape (frameworks/plugin.ts: registrations as
// entities, `handles` and `tests` edges, each with its evidence, and the
// plugins' unknowns), from `graph.frameworks`. A build with no framework
// layer answers `routes` with a capability boundary.
//
// Before that layer exists, `tests` still answers with what the graph can
// prove without a test runner: calls into the symbol from files named like
// tests. Those are leads, never counted and never called tests or coverage,
// and the answer is a floor: a test that requests a route or renders a
// component reaches the symbol without a call.
import { isTestPath } from "../impact.js";
import type { Tier } from "../model/records.js";
import type { Graph, GraphSite } from "../types.js";
import { BAD_CURSOR, candidate, counts, empty, fail, onePoint } from "./answer.js";
import type { Answer, Candidate, Request, Session } from "./answer.js";
import { edgeId } from "./ids.js";
import { page } from "./page.js";
import { RANK, walk } from "./traverse.js";
import type { Budget } from "./traverse.js";

type FwSite = { file: string; line: number; column: number };
type FwEvidence = { kind: string; tier: Tier; site: FwSite; via: { file: string; line: number; spec: string | null } | null; premises: string[]; note: string | null; rule: { id: string; version: number } };
type FwRegistration = {
  kind: "registration";
  id: string;
  plugin: string;
  app: string | null;
  methods: string[];
  pattern: string | null;
  written: string | null;
  name: string | null;
  site: FwSite;
  mounted: boolean;
  handler: { written: string; status: string; targets: string[] };
};
type FwEdge = { from: string; to: string; kind: string; plugin: string; app: string | null; evidence: FwEvidence; category?: string };
type FwUnknown = { plugin: string; site: FwSite | null; affects: string[]; cause: string; name: string | null; note: string; count: number | null; exact: boolean };
type FwLayer = { registrations: FwRegistration[]; edges: FwEdge[]; unknowns: FwUnknown[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

// The framework layer of a build, when it has one in the documented shape.
export function frameworkLayer(g: Graph): FwLayer | null {
  const f = (g as unknown as { frameworks?: unknown }).frameworks;
  if (!isObj(f) || !Array.isArray(f.entities) || !Array.isArray(f.edges) || !Array.isArray(f.unknowns)) return null;
  const registrations = f.entities.filter((e): e is FwRegistration => isObj(e) && e.kind === "registration" && isObj(e.site) && isObj(e.handler) && Array.isArray(e.methods));
  const edges = f.edges.filter((e): e is FwEdge => isObj(e) && typeof e.from === "string" && typeof e.to === "string" && typeof e.kind === "string" && isObj(e.evidence) && isObj(e.evidence.site));
  const unknowns = f.unknowns.filter((u): u is FwUnknown => isObj(u) && Array.isArray(u.affects) && typeof u.cause === "string");
  return { registrations, edges, unknowns };
}

function fwSite(e: FwEvidence): GraphSite {
  return { file: e.site.file, line: e.site.line, column: e.site.column, tier: e.tier, evidence: e.kind, via: e.via, note: e.note, rule: e.rule.id };
}

function gapsOf(layer: FwLayer, affects: string): { reasons: string[]; causes: Record<string, number | null> } {
  const hit = layer.unknowns.filter((u) => u.affects.includes(affects));
  const causes: Record<string, number | null> = {};
  for (const u of hit) {
    const prev = causes[u.cause];
    causes[u.cause] = prev === null || u.count === null ? null : (prev ?? 0) + u.count;
  }
  const reasons = hit.slice(0, 10).map((u) => `${u.plugin}: ${u.note}${u.site ? ` (${u.site.file}:${u.site.line})` : ""}`);
  if (hit.length > 10) reasons.push(`and ${hit.length - 10} more gaps of the framework layer`);
  return { reasons, causes };
}

export function routes(s: Session, req: Request): Answer {
  const g = s.graph;
  const layer = frameworkLayer(g);
  if (!layer) return fail(s, "routes", "unsupported", "this build has no framework layer, so it knows no routes; `callers` and `importers` still answer for the handler code");
  const base = empty(s, "routes");
  const t = req.target ?? {};
  let regs = layer.registrations;
  let target: Answer["target"] = null;
  if (t.id || t.name || (t.file && t.line !== undefined)) {
    const n = onePoint(s, "routes", t);
    if ("apiVersion" in n) return n;
    target = candidate(g, n, 1);
    const handled = new Set(layer.edges.filter((e) => e.kind === "handles" && e.to === n.id).map((e) => e.from));
    regs = regs.filter((r) => handled.has(r.id) || r.handler.targets.includes(n.id));
  } else if (req.text) {
    const text = req.text;
    regs = regs.filter((r) => (r.pattern ?? r.written ?? "").includes(text) || r.name === text);
  }
  const items = regs
    .map((r) => {
      const handles = layer.edges.filter((e) => e.kind === "handles" && e.from === r.id);
      return {
        id: r.id,
        plugin: r.plugin,
        app: r.app,
        methods: r.methods,
        pattern: r.pattern,
        name: r.name,
        mounted: r.mounted,
        site: r.site,
        handler: r.handler,
        handles: handles.map((e) => ({ to: e.to, site: fwSite(e.evidence), premises: e.evidence.premises, edge: edgeId(e, e.evidence.site) })),
      };
    })
    .sort((a, b) => a.site.file.localeCompare(b.site.file) || a.site.line - b.site.line);
  const p = page(s.generation, req, items);
  if (p === "bad") return fail(s, "routes", "generation-unavailable", BAD_CURSOR);
  const gaps = gapsOf(layer, "handles");
  const unknown = { ...base.unknown, floor: base.unknown.floor || gaps.reasons.length > 0, reasons: [...gaps.reasons, ...base.unknown.reasons], causes: gaps.causes };
  return { ...base, target, items: p.items, unknown, truncated: p.truncated };
}

export function tests(s: Session, req: Request, budget: Budget, tiers: ReadonlySet<Tier>): Answer {
  const g = s.graph;
  const base = empty(s, "tests");
  const n = onePoint(s, "tests", req.target);
  if ("apiVersion" in n) return n;
  const target = candidate(g, n, 1);
  const layer = frameworkLayer(g);
  if (layer) {
    // A test edge into the symbol, or into a route it handles.
    const handled = new Set(layer.edges.filter((e) => e.kind === "handles" && e.to === n.id).map((e) => e.from));
    const links = layer.edges
      .filter((e) => e.kind === "tests" && (e.to === n.id || handled.has(e.to)) && tiers.has(e.evidence.tier))
      .map((e) => ({ from: e.from, to: e.to, kind: "tests", category: e.category ?? null, depth: 1, site: fwSite(e.evidence), premises: e.evidence.premises, edge: edgeId(e, e.evidence.site), fromName: g.nodes.get(e.from)?.name ?? null, toName: g.nodes.get(e.to)?.name ?? null }))
      .sort((a, b) => RANK[a.site.tier] - RANK[b.site.tier] || a.site.file.localeCompare(b.site.file) || a.site.line - b.site.line);
    const p = page(s.generation, req, links);
    if (p === "bad") return fail(s, "tests", "generation-unavailable", BAD_CURSOR);
    const gaps = gapsOf(layer, "tests");
    const unknown = { ...base.unknown, floor: base.unknown.floor || gaps.reasons.length > 0, reasons: [...gaps.reasons, ...base.unknown.reasons], causes: gaps.causes };
    return { ...base, target, items: p.items, counts: counts(links), unknown, truncated: p.truncated };
  }
  // No framework layer: calls from files named like tests, as leads.
  const w = walk(g, n.id, "in", 2, tiers, budget);
  const seen = new Set<string>();
  const leads: Candidate[] = [];
  for (const i of w.items) {
    if (!isTestPath(i.site.file) || seen.has(i.from)) continue;
    seen.add(i.from);
    const from = g.nodes.get(i.from);
    leads.push(from ? { ...candidate(g, from, i.depth === 1 ? 1 : 0.5) } : { id: i.from, name: i.from, kind: "file", file: i.site.file, line: i.site.line, project: g.projectOf(i.site.file), score: i.depth === 1 ? 1 : 0.5 });
  }
  const p = page(s.generation, req, leads);
  if (p === "bad") return fail(s, "tests", "generation-unavailable", BAD_CURSOR);
  const reasons = [
    "no test runner was read in this build, so files are taken for tests by their names only: these are leads, not test links",
    "a test that requests a route, renders a component or reaches the code through a value calls nothing here",
    ...(w.stopped ? ["the walk stopped at its time budget"] : []),
    ...base.unknown.reasons,
  ];
  return { ...base, target, leads: p.items, unknown: { ...base.unknown, floor: true, reasons, causes: { "unsupported-rule": null } }, truncated: w.stopped ? { by: "budget", omitted: null, omittedExact: false, cursor: null } : p.truncated };
}
