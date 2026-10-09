// Routes and tests: the two questions the framework layer answers (PLAN.md
// 3.2.3, phase 4). The layer's output is read here and nowhere else in the
// query, by its documented shape (frameworks/plugin.ts: registrations as
// entities, `handles` and `tests` edges, each with its evidence, and the
// plugins' unknowns), from `graph.frameworks`. Every build runs the
// framework plugins; a build where none of them found an application in
// the repository has no layer to read, and answers `routes` with a
// capability boundary.
//
// Without a layer, `tests` still answers with what the graph can prove
// without a test runner: calls into the symbol from files named like
// tests. Those are leads, never counted and never called tests or coverage,
// and the answer is a floor: a test that requests a route or renders a
// component reaches the symbol without a call.
//
// Each is a job (answer.ts): the layer's edges, registrations and gaps are
// read one at a time with the question's budget checked at each, and a
// stopped job goes on where it stopped.
import { isTestPath } from "../impact.js";
import type { Tier } from "../model/records.js";
import type { Graph, GraphNode, GraphSite } from "../types.js";
import { candidate, counts, empty, fail, isAnswer, listing, Point, stoppedAt } from "./answer.js";
import type { Answer, Candidate, Job, Request, Session } from "./answer.js";
import { edgeId } from "./ids.js";
import { Pass, RANK, sortWithin, Walk } from "./traverse.js";
import type { Item } from "./traverse.js";

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
type FwRun = { id: string; status: string; reason: string | null };
type FwLayer = { registrations: FwRegistration[]; edges: FwEdge[]; unknowns: FwUnknown[]; runs: FwRun[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

// Each framework plugin's run in a build (frameworks/stage.ts, PluginRun).
function runsOf(g: Graph): FwRun[] {
  const f = (g as unknown as { frameworks?: unknown }).frameworks;
  if (!isObj(f) || !Array.isArray(f.plugins)) return [];
  return f.plugins.filter((p): p is FwRun => isObj(p) && typeof p.id === "string" && typeof p.status === "string" && (p.reason === null || typeof p.reason === "string"));
}

// Why a build has no framework layer to read, for a capability boundary.
export function noLayerReason(g: Graph): string {
  const ids = runsOf(g).map((r) => r.id);
  return ids.length > 0 ? `no framework plugin of this build (${ids.join(", ")}) found an application in this repository` : "this build has no framework layer";
}

// The framework layer of a build, when it has one in the documented shape
// and a plugin found something to read: a build where every plugin found
// no application has none.
export function frameworkLayer(g: Graph): FwLayer | null {
  const f = (g as unknown as { frameworks?: unknown }).frameworks;
  if (!isObj(f) || !Array.isArray(f.entities) || !Array.isArray(f.edges) || !Array.isArray(f.unknowns)) return null;
  const runs = runsOf(g);
  if (runs.length > 0 && runs.every((r) => r.status === "not-detected")) return null;
  const registrations = f.entities.filter((e): e is FwRegistration => isObj(e) && e.kind === "registration" && isObj(e.site) && isObj(e.handler) && Array.isArray(e.methods));
  const edges = f.edges.filter((e): e is FwEdge => isObj(e) && typeof e.from === "string" && typeof e.to === "string" && typeof e.kind === "string" && isObj(e.evidence) && isObj(e.evidence.site));
  const unknowns = f.unknowns.filter((u): u is FwUnknown => isObj(u) && Array.isArray(u.affects) && typeof u.cause === "string");
  return { registrations, edges, unknowns, runs };
}

function fwSite(e: FwEvidence): GraphSite {
  return { file: e.site.file, line: e.site.line, column: e.site.column, tier: e.tier, evidence: e.kind, via: e.via, note: e.note, rule: e.rule.id };
}

// The layer's gaps for one relation, gathered gap by gap, and the plugins
// that failed or ran out of budget, whose part of the layer is missing.
class Gaps {
  private readonly hit: FwUnknown[] = [];
  private readonly missing: string[];
  readonly pass: Pass<FwUnknown>;
  constructor(layer: FwLayer, affects: string) {
    // A gap that names no relation may hide any of them.
    this.pass = new Pass(layer.unknowns, (u) => {
      if (u.affects.length === 0 || u.affects.includes(affects)) this.hit.push(u);
    });
    this.missing = layer.runs.filter((r) => r.status === "failed" || r.status === "stopped").map((r) => `${r.id}: ${r.reason ?? r.status}, so nothing of it is listed`);
  }
  // After the pass is whole: the answer's unknown block with the gaps.
  unknown(base: Answer): Answer["unknown"] {
    const causes: Record<string, number | null> = {};
    for (const u of this.hit) {
      const prev = causes[u.cause];
      causes[u.cause] = prev === null || u.count === null ? null : (prev ?? 0) + u.count;
    }
    const reasons = [...this.missing, ...this.hit.slice(0, 10).map((u) => `${u.plugin}: ${u.note}${u.site ? ` (${u.site.file}:${u.site.line})` : ""}`)];
    if (this.hit.length > 10) reasons.push(`and ${this.hit.length - 10} more gaps of the framework layer`);
    return { ...base.unknown, floor: base.unknown.floor || reasons.length > 0, reasons: [...reasons, ...base.unknown.reasons], causes };
  }
}

type Route = {
  id: string;
  plugin: string;
  app: string | null;
  methods: string[];
  pattern: string | null;
  name: string | null;
  mounted: boolean;
  site: FwSite;
  handler: FwRegistration["handler"];
  handles: { to: string; site: GraphSite; premises: string[]; edge: string }[];
};

// A target that names one point (an id, a name, a file and line), as
// against a whole listing narrowed by text.
const namesPoint = (t: Request["target"]) => Boolean(t && (t.id || t.name || (t.file && t.line !== undefined)));

export function routes(s: Session, req: Request): Job | Answer {
  const g = s.graph;
  const layer = frameworkLayer(g);
  if (!layer) return fail(s, "routes", "unsupported", `${noLayerReason(g)}, so the graph knows no routes; \`callers\` and \`importers\` still answer for the handler code`);
  const point = namesPoint(req.target) ? new Point(g, req.target) : null;
  const text = point ? undefined : req.text;
  let n: GraphNode | null = null;
  // The handles edges by the registration they leave, and the registrations
  // whose handler is the point.
  const handlesOf = new Map<string, FwEdge[]>();
  const handlesPoint = new Set<string>();
  let edges: Pass<FwEdge> | null = null;
  const items: Route[] = [];
  let regs: Pass<FwRegistration> | null = null;
  let sorted = false;
  const gaps = new Gaps(layer, "handles");
  return (budget) => {
    const base = empty(s, "routes");
    if (point && !n) {
      if (!point.run(budget)) return stoppedAt(base, [], [], null);
      const o = point.outcome(s, "routes");
      if (isAnswer(o)) return o;
      n = o;
    }
    const at = n;
    const target = at ? candidate(g, at, 1) : null;
    edges ??= new Pass(layer.edges, (e) => {
      if (e.kind !== "handles") return;
      (handlesOf.get(e.from) ?? handlesOf.set(e.from, []).get(e.from))?.push(e);
      if (at && e.to === at.id) handlesPoint.add(e.from);
    });
    if (!edges.run(budget)) return stoppedAt({ ...base, target }, [], [], edges.left);
    regs ??= new Pass(layer.registrations, (r) => {
      if (at && !handlesPoint.has(r.id) && !r.handler.targets.includes(at.id)) return;
      if (text && !(r.pattern ?? r.written ?? "").includes(text) && r.name !== text) return;
      const handles = (handlesOf.get(r.id) ?? []).map((e) => ({ to: e.to, site: fwSite(e.evidence), premises: e.evidence.premises, edge: edgeId(e, e.evidence.site) }));
      items.push({ id: r.id, plugin: r.plugin, app: r.app, methods: r.methods, pattern: r.pattern, name: r.name, mounted: r.mounted, site: r.site, handler: r.handler, handles });
    });
    if (!regs.run(budget)) return stoppedAt({ ...base, target }, items, [], regs.left);
    if (!sorted) {
      if (!sortWithin(items, (a, b) => a.site.file.localeCompare(b.site.file) || a.site.line - b.site.line, budget)) return stoppedAt({ ...base, target }, items, [], null);
      sorted = true;
    }
    if (!gaps.pass.run(budget)) return stoppedAt({ ...base, target }, items, [], gaps.pass.left);
    return listing({ ...base, target, unknown: gaps.unknown(base) }, items);
  };
}

type TestLink = { from: string; to: string; kind: "tests"; category: string | null; depth: number; site: GraphSite; premises: string[]; edge: string; fromName: string | null; toName: string | null };

// The leads-only floor of `tests` when the build has no framework layer.
const LEAD_REASONS = (g: Graph) => [
  `${noLayerReason(g)}, so files are taken for tests by their names only: these are leads, not test links`,
  "a test that requests a route, renders a component or reaches the code through a value calls nothing here",
];

export function tests(s: Session, req: Request, tiers: ReadonlySet<Tier>): Job {
  const g = s.graph;
  const layer = frameworkLayer(g);
  const point = new Point(g, req.target);
  let n: GraphNode | null = null;
  // With a layer: the routes the point handles, then the test edges into
  // the point or into one of them, sorted.
  const handled = new Set<string>();
  let handles: Pass<FwEdge> | null = null;
  const links: TestLink[] = [];
  let tested: Pass<FwEdge> | null = null;
  let sorted = false;
  const gaps = layer ? new Gaps(layer, "tests") : null;
  // Without one: callers two hops out, from files named like tests.
  let walk: Walk | null = null;
  const seen = new Set<string>();
  const leads: Candidate[] = [];
  let picked: Pass<Item> | null = null;
  return (budget) => {
    const base = empty(s, "tests");
    if (!n) {
      if (!point.run(budget)) return stoppedAt(base, [], [], null);
      const o = point.outcome(s, "tests");
      if (isAnswer(o)) return o;
      n = o;
    }
    const at = n;
    const target = candidate(g, at, 1);
    if (layer && gaps) {
      handles ??= new Pass(layer.edges, (e) => {
        if (e.kind === "handles" && e.to === at.id) handled.add(e.from);
      });
      if (!handles.run(budget)) return stoppedAt({ ...base, target }, [], [], handles.left);
      tested ??= new Pass(layer.edges, (e) => {
        if (e.kind !== "tests" || (e.to !== at.id && !handled.has(e.to)) || !tiers.has(e.evidence.tier)) return;
        links.push({ from: e.from, to: e.to, kind: "tests", category: e.category ?? null, depth: 1, site: fwSite(e.evidence), premises: e.evidence.premises, edge: edgeId(e, e.evidence.site), fromName: g.nodes.get(e.from)?.name ?? null, toName: g.nodes.get(e.to)?.name ?? null });
      });
      if (!tested.run(budget)) return stoppedAt({ ...base, target }, links, [], tested.left);
      if (!sorted) {
        if (!sortWithin(links, (a, b) => RANK[a.site.tier] - RANK[b.site.tier] || a.site.file.localeCompare(b.site.file) || a.site.line - b.site.line, budget)) return stoppedAt({ ...base, target }, links, [], null);
        sorted = true;
      }
      if (!gaps.pass.run(budget)) return stoppedAt({ ...base, target }, links, [], gaps.pass.left);
      return listing({ ...base, target, counts: counts(links), unknown: gaps.unknown(base) }, links);
    }
    const floor = { ...base.unknown, floor: true, reasons: [...LEAD_REASONS(g), ...base.unknown.reasons], causes: { "unsupported-rule": null } };
    walk ??= new Walk(g, at.id, "in", 2, tiers);
    if (!walk.run(budget)) return stoppedAt({ ...base, target, unknown: floor }, [], walk.pending(), walk.pending().length, "leads");
    picked ??= new Pass(walk.items, (i) => {
      if (!isTestPath(i.site.file) || seen.has(i.from)) return;
      seen.add(i.from);
      const from = g.nodes.get(i.from);
      const score = i.depth === 1 ? 1 : 0.5;
      leads.push(from ? candidate(g, from, score) : { id: i.from, name: i.from, kind: "file", file: i.site.file, line: i.site.line, project: g.projectOf(i.site.file), score });
    });
    if (!picked.run(budget)) return stoppedAt({ ...base, target, unknown: floor }, leads, [], picked.left, "leads");
    return listing({ ...base, target, unknown: floor }, leads, { into: "leads" });
  };
}
