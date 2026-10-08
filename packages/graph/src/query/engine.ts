// One query function for every reader of the graph: the review's impact
// walk, the `openqodex graph` commands and the MCP tools (PLAN.md 3.3).
// Typed operations only; no model reads the question. Every answer carries
// what the graph does not know (`unknown`, with `floor` and the causes) and
// which graph answered (`graph`), in one shape (answer.ts).
//
// An ambiguous name returns its candidates and no items: the graph never
// picks one silently. A count that cannot be known is null, never zero.
// Search leads are never counted as callers. A question this build cannot
// answer is a capability boundary (`unsupported`), never an empty success.
// Each question has a time budget (default 1 s) checked between expansions,
// and the caller's cancellation stops it the same way.
import { floorReasons, toImpactUnknown } from "../impact.js";
import { API_VERSION, CERTAIN_KINDS, MODEL_VERSION } from "../model/records.js";
import type { Tier } from "../model/records.js";
import type { GraphNode, GraphSite } from "../types.js";
import { BAD_CURSOR, candidate, counts, empty, fail, onePoint, OPERATIONS, qualified } from "./answer.js";
import type { Answer, Candidate, Extra, Operation, Request, Session } from "./answer.js";
import { frameworkLayer, routes, tests } from "./frameworks.js";
import { edgeId, readEdgeId } from "./ids.js";
import { page } from "./page.js";
import { derivedOverrides, implementers, importCycles, impact, outline, packages, path, references, relationsOf } from "./relations.js";
import { budgetOf, walk } from "./traverse.js";

export { OPERATIONS, resolveTarget } from "./answer.js";
export type { Answer, Candidate, ChangesExtra, ErrorCode, Extra, Operation, Request, Session, Target } from "./answer.js";
export type { Item } from "./traverse.js";
export { edgeId } from "./ids.js";

const LANGUAGES = ["typescript", "tsx", "javascript", "python", "go", "ruby"];

// What this build can answer, and what it cannot yet.
function capabilities(s: Session): Record<string, unknown> {
  const rel = relationsOf(s.graph);
  const layer = frameworkLayer(s.graph);
  const unsupported: Record<string, string> = {};
  if (![...rel].some((k) => ["uses_value", "uses_type", "reads", "writes", "may_invoke", "decorates"].includes(k))) unsupported.references = "uses of a symbol as a value or a type are not resolved";
  if (!layer) unsupported.routes = "no framework layer: routes and handlers are not read";
  if (!rel.has("dispatches_to")) unsupported["implementers of a method"] = "calls through interfaces and base types are not resolved; overrides are found by name from the inheritance";
  if (!layer) unsupported.tests = "no test runner is read: files named like tests are leads only";
  return {
    apiVersion: API_VERSION,
    modelVersion: MODEL_VERSION,
    languages: LANGUAGES,
    operations: OPERATIONS,
    relations: [...rel].sort(),
    certainEvidence: [...CERTAIN_KINDS],
    unsupported,
  };
}

function nameCauses(s: Session, name: string): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const u of s.graph.unknowns) if (u.name === name) out[u.cause] = (out[u.cause] ?? 0) + 1;
  return out;
}

function search(s: Session, req: Request, base: Answer): Answer {
  const g = s.graph;
  const text = (req.text ?? req.target?.name ?? "").trim();
  if (text === "") return fail(s, "search", "bad-request", "search needs a text");
  const lower = text.toLowerCase();
  const scored: Candidate[] = [];
  for (const n of g.nodes.values()) {
    if (n.kind === "file") {
      if (n.file.toLowerCase().includes(lower)) scored.push(candidate(g, n, 0.5));
      continue;
    }
    const q = qualified(n);
    const score = n.name === text || q === text ? 1 : n.name.toLowerCase() === lower ? 0.9 : n.name.toLowerCase().startsWith(lower) ? 0.7 : n.name.toLowerCase().includes(lower) ? 0.5 : 0;
    if (score > 0) scored.push(candidate(g, n, score));
  }
  scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line);
  const p = page(s.generation, req, scored);
  if (p === "bad") return fail(s, "search", "generation-unavailable", BAD_CURSOR);
  // Search results are leads: never counted as callers or anything else.
  return { ...base, leads: p.items, truncated: p.truncated };
}

function unknowns(s: Session, req: Request, base: Answer): Answer {
  const g = s.graph;
  const t = req.target ?? {};
  const project = t.file && !t.name ? g.projectOf(t.file) : null;
  const all = g.unknowns.filter((u) => (t.name ? u.name === t.name : true) && (t.file ? u.file === t.file || (u.scope === "project" && project !== null && g.projectOf(u.file) === project) : true));
  const notRead = t.file ? g.status.notRead.filter((n) => n.file === t.file).map((n) => ({ file: n.file, line: null, name: null, cause: "file-not-parsed", scope: "file", note: n.reason, candidates: null })) : [];
  const p = page(s.generation, req, [...notRead, ...all.map(toImpactUnknown)]);
  if (p === "bad") return fail(s, "unknowns", "generation-unavailable", BAD_CURSOR);
  const causes: Record<string, number | null> = {};
  for (const u of all) causes[u.cause] = (causes[u.cause] ?? 0) + 1;
  if (notRead.length > 0) causes["file-not-parsed"] = notRead.length;
  return { ...base, items: p.items, truncated: p.truncated, unknown: { ...base.unknown, causes } };
}

function explain(s: Session, req: Request, base: Answer, extra: Extra): Answer {
  const g = s.graph;
  const id = req.target?.id ?? "";
  const parsed = readEdgeId(id);
  if (!parsed) return fail(s, "explain", "bad-request", "explain takes an edge id as the items of an answer print it");
  const { kind, from, to, file, line, column } = parsed;
  const why = (site: GraphSite) => (site.tier === "certain" ? `${site.evidence} proves it${site.via ? `: ${site.via.spec !== null ? "the import" : "the line"} at ${site.via.file}:${site.via.line}` : ""}` : site.note);
  const edges = kind === "imports" ? (g.importers.get(to) ?? []) : (g.out.get(from) ?? []);
  const e = edges.find((x) => x.kind === kind && x.from === from && x.to === to);
  const site = e?.sites.find((x) => x.file === file && x.line === line && x.column === column);
  if (e && site) return { ...base, items: [{ edge: id, from: e.from, to: e.to, kind: e.kind, site, why: why(site) }] };
  // An override the query derived from the inheritance: derived again.
  if (kind === "overrides") {
    const m = g.nodes.get(to);
    const hit = m ? derivedOverrides(g, m, 8, budgetOf(undefined, extra.signal ?? null)).items.find((i) => i.edge === id) : undefined;
    if (hit) return { ...base, items: [{ edge: id, from: hit.from, to: hit.to, kind: hit.kind, site: hit.site, premises: hit.premises, why: hit.site.note }] };
  }
  // A framework edge: its evidence record as the plugin wrote it.
  const layer = frameworkLayer(g);
  const fw = layer?.edges.find((x) => x.kind === kind && x.from === from && x.to === to && x.evidence.site.file === file && x.evidence.site.line === line && x.evidence.site.column === column);
  if (fw) return { ...base, items: [{ edge: id, from: fw.from, to: fw.to, kind: fw.kind, plugin: fw.plugin, app: fw.app, evidence: fw.evidence, why: fw.evidence.note ?? `${fw.evidence.kind} proves it` }] };
  return fail(s, "explain", "not-found", `no edge ${id} in this graph`);
}

function callersOrCallees(s: Session, req: Request, base: Answer, n: GraphNode, tiers: ReadonlySet<Tier>, extra: Extra): Answer {
  const g = s.graph;
  const kind = req.kind as "callers" | "callees";
  const depth = Math.min(Math.max(1, req.depth ?? 1), 3);
  const budget = budgetOf(req.budget?.ms, extra.signal ?? null);
  const w = walk(g, n.id, kind === "callers" ? "in" : "out", depth, tiers, budget);
  const p = page(s.generation, req, w.items);
  if (p === "bad") return fail(s, kind, "generation-unavailable", BAD_CURSOR);
  let reasons: string[];
  let causes: Record<string, number | null>;
  let examples: Answer["unknown"]["examples"];
  if (kind === "callers") {
    reasons = floorReasons(g, { id: n.id, name: n.name, file: n.file }, new Set());
    causes = nameCauses(s, n.name);
    examples = g.unknowns.filter((u) => u.name === n.name).slice(0, 5).map(toImpactUnknown);
  } else {
    // What it calls is a floor when a call inside it could not be bound.
    const inside = g.unknowns.filter((u) => u.caller === n.id && u.cause !== "external");
    reasons = inside.length > 0 ? [`${inside.length} ${inside.length === 1 ? "call" : "calls"} inside it could not be bound`] : [];
    causes = {};
    for (const u of inside) causes[u.cause] = (causes[u.cause] ?? 0) + 1;
    examples = inside.slice(0, 5).map(toImpactUnknown);
  }
  if (w.stopped) reasons.push("the walk stopped at its time budget");
  const partial = g.status.status === "partial";
  const front = { frontier: w.frontier.slice(0, 50), frontierTotal: w.frontier.length };
  const truncated: Answer["truncated"] = w.stopped
    ? { by: "budget", omitted: null, omittedExact: false, cursor: null, ...front }
    : p.truncated.by !== null
      ? p.truncated
      : w.beyond
        ? { by: "depth", omitted: null, omittedExact: false, cursor: null, ...front }
        : p.truncated;
  return {
    ...base,
    target: candidate(g, n, 1),
    items: p.items,
    counts: counts(w.items),
    unknown: { floor: reasons.length > 0 || partial, reasons: [...reasons, ...(partial ? g.status.reasons : [])], causes, examples },
    truncated,
  };
}

export function query(s: Session, req: Request, extra: Extra = {}): Answer {
  const g = s.graph;
  const kind = req.kind;
  if (!(OPERATIONS as readonly string[]).includes(kind)) return fail(s, kind, "bad-request", `unknown operation ${String(kind)}`);
  if (req.apiVersion !== API_VERSION) return fail(s, kind, "bad-request", `this graph answers apiVersion ${API_VERSION}, not ${req.apiVersion}`);
  if (req.generation && s.generation && req.generation !== s.generation) return fail(s, kind, "generation-unavailable", `this session holds build ${s.generation}, not ${req.generation}`);
  const tiers = new Set<Tier>(req.tiers ?? ["certain", "likely", "possible"]);
  const base = empty(s, kind);
  const budget = () => budgetOf(req.budget?.ms, extra.signal ?? null);

  switch (kind as Operation) {
    case "status":
      return { ...base, items: [{ ...g.status, eligible: g.status.eligibleFiles, inGraph: g.status.filesParsed }] };
    case "capabilities":
      return { ...base, items: [capabilities(s)] };
    case "search":
      return search(s, req, base);
    case "unknowns":
      return unknowns(s, req, base);
    case "changes": {
      const c = extra.changes;
      if (!c) return fail(s, kind, "bad-request", "no base was compared for this graph; ask `changes` with a change against its base");
      const all = [...c.exports.map((e) => ({ type: "export", ...e })), ...c.removed.map((r) => ({ type: "removed", ...r })), ...c.moved.map((m) => ({ type: "moved", ...m }))];
      const p = page(s.generation, req, all);
      if (p === "bad") return fail(s, kind, "generation-unavailable", BAD_CURSOR);
      return { ...base, items: p.items, truncated: p.truncated };
    }
    case "explain":
      return explain(s, req, base, extra);
    case "implementers":
      return implementers(s, req, budget(), tiers);
    case "references":
      return references(s, req, budget(), tiers);
    case "routes":
      return routes(s, req);
    case "tests":
      return tests(s, req, budget(), tiers);
    case "path":
      return path(s, req, budget(), tiers);
    case "impact":
      return impact(s, req, extra);
    case "outline":
      return outline(s, req);
    case "packages":
      return packages(s, req);
    case "cycles":
      return importCycles(s, req, budget());
    default:
      break;
  }

  // The operations on one symbol or file.
  const n = onePoint(s, kind, req.target);
  if ("apiVersion" in n) return n;
  const target = candidate(g, n, 1);
  if (kind === "symbol") {
    const callers = (g.in.get(n.id) ?? []).reduce((k, e) => k + e.sites.length, 0);
    const callees = (g.out.get(n.id) ?? []).reduce((k, e) => k + e.sites.length, 0);
    return { ...base, target, items: [{ ...n, project: g.projectOf(n.file), callerSites: callers, calleeSites: callees }] };
  }
  if (kind === "importers") {
    const file = n.file;
    const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
    const edges = [...(g.importers.get(file) ?? []), ...(file.endsWith(".go") ? (g.importers.get(`go:${dir}`) ?? []) : [])];
    const items = edges.map((e) => ({ from: e.from, to: e.to, kind: e.kind, depth: 1, site: e.sites[0] as GraphSite, edge: edgeId(e, e.sites[0] as GraphSite), fromName: null, toName: null }));
    const p = page(s.generation, req, items);
    if (p === "bad") return fail(s, kind, "generation-unavailable", BAD_CURSOR);
    return { ...base, target, items: p.items, counts: counts(items), truncated: p.truncated };
  }
  return callersOrCallees(s, req, base, n, tiers, extra);
}
