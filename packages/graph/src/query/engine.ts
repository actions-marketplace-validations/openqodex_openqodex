// One query function for every reader of the graph: the hidden `openqodex
// graph` commands now, the MCP server in phase 3. Typed operations only; no
// model reads the question. Every answer carries what the graph does not
// know (`unknown`, with `floor` and the causes) and which graph answered
// (`graph`), in one shape (PLAN.md 3.3).
//
// An ambiguous name returns its candidates and no items: the graph never
// picks one silently. A count that cannot be known is null, never zero.
// Search leads are never counted as callers.
import { createHash } from "node:crypto";
import type { ImpactExportChange, ImpactSymbol } from "@openqodex/core";
import { floorReasons, toImpactUnknown } from "../impact.js";
import { API_VERSION, CERTAIN_KINDS, MODEL_VERSION } from "../model/records.js";
import type { Tier } from "../model/records.js";
import type { Graph, GraphEdge, GraphNode, GraphSite, GraphStatus } from "../types.js";

export const OPERATIONS = ["search", "symbol", "callers", "callees", "importers", "changes", "unknowns", "explain", "status", "capabilities"] as const;
export type Operation = (typeof OPERATIONS)[number];

export type Target = { id?: string; name?: string; file?: string; line?: number };

export type Request = {
  apiVersion: number;
  kind: Operation;
  target?: Target;
  text?: string; // search
  tiers?: Tier[];
  depth?: number; // callers and callees: 1 to 3
  limit?: number;
  cursor?: string;
  generation?: string;
};

export type Item = {
  from: string;
  to: string;
  kind: GraphEdge["kind"];
  depth: number;
  site: GraphSite;
  edge: string; // the edge id `explain` takes
  fromName: string | null;
  toName: string | null;
};

export type Candidate = { id: string; name: string; kind: string; file: string; line: number; project: string; score: number };

export type Answer = {
  apiVersion: number;
  kind: Operation;
  error: null | { code: "ambiguous" | "not-found" | "bad-request" | "generation-unavailable"; message: string };
  target: Candidate | Candidate[] | null;
  items: unknown[];
  counts: { certain: number | null; likely: number | null; possible: number | null };
  leads: Candidate[];
  unknown: { floor: boolean; reasons: string[]; causes: Record<string, number | null>; examples: ReturnType<typeof toImpactUnknown>[] };
  truncated: { by: "limit" | "depth" | "budget" | null; omitted: number | null; omittedExact: boolean; cursor: string | null };
  graph: { generation: string | null; treeSha: string | null; builtAt: string | null; status: "ok" | "partial"; reasons: string[]; mode: "fresh" | "retained"; freshness: { laterEditsKnown: boolean } };
};

export type Session = {
  graph: Graph;
  generation: string | null;
  treeSha: string | null;
  builtAt: string | null;
  laterEditsKnown: boolean;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function graphBlock(s: Session): Answer["graph"] {
  const st: GraphStatus = s.graph.status;
  return { generation: s.generation, treeSha: s.treeSha, builtAt: s.builtAt, status: st.status, reasons: st.reasons, mode: st.mode, freshness: { laterEditsKnown: s.laterEditsKnown } };
}

function empty(s: Session, kind: Operation): Answer {
  return {
    apiVersion: API_VERSION,
    kind,
    error: null,
    target: null,
    items: [],
    counts: { certain: null, likely: null, possible: null },
    leads: [],
    unknown: { floor: s.graph.status.status === "partial", reasons: s.graph.status.status === "partial" ? s.graph.status.reasons : [], causes: {}, examples: [] },
    truncated: { by: null, omitted: 0, omittedExact: true, cursor: null },
    graph: graphBlock(s),
  };
}

function fail(s: Session, kind: Operation, code: NonNullable<Answer["error"]>["code"], message: string): Answer {
  return { ...empty(s, kind), error: { code, message } };
}

function candidate(g: Graph, n: GraphNode, score: number): Candidate {
  return { id: n.id, name: n.name, kind: n.kind, file: n.file, line: n.startLine, project: g.projectOf(n.file), score };
}

// "Owner.name" when the symbol has an owner, else the name.
function qualified(n: GraphNode): string {
  const inner = n.id.slice(n.id.indexOf("#") + 1, n.id.lastIndexOf("@"));
  return inner || n.name;
}

// The symbols a target names: an id, a file and line (the innermost
// definition around it), or a name (`name` or `Owner.name`), narrowed by file.
export function resolveTarget(g: Graph, t: Target): GraphNode[] {
  if (t.id) {
    const n = g.nodes.get(t.id);
    return n ? [n] : [];
  }
  if (t.file && t.line !== undefined) {
    let inner: GraphNode | null = null;
    for (const d of g.defsByFile.get(t.file) ?? []) {
      if (t.line < d.startLine || t.line > d.endLine) continue;
      if (!inner || d.endLine - d.startLine < inner.endLine - inner.startLine) inner = d;
    }
    return inner ? [inner] : [];
  }
  if (t.file && !t.name) {
    const n = g.nodes.get(t.file);
    return n ? [n] : [];
  }
  if (!t.name) return [];
  const out: GraphNode[] = [];
  for (const n of g.nodes.values()) {
    if (n.kind === "file") continue;
    if (n.name !== t.name && qualified(n) !== t.name) continue;
    if (t.file && n.file !== t.file) continue;
    out.push(n);
  }
  return out;
}

// An edge id: opaque, so no part of a path or a name can be read as a
// separator, and read back with one JSON.parse, never a pattern.
export function edgeId(e: Pick<GraphEdge, "from" | "to" | "kind">, site: GraphSite): string {
  return `e.${Buffer.from(JSON.stringify([e.kind, e.from, e.to, site.file, site.line, site.column])).toString("base64url")}`;
}

const MAX_EDGE_ID = 64 * 1024;

function readEdgeId(id: string): { kind: string; from: string; to: string; file: string; line: number; column: number } | null {
  if (!id.startsWith("e.") || id.length > MAX_EDGE_ID) return null;
  try {
    const v = JSON.parse(Buffer.from(id.slice(2), "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(v) || v.length !== 6) return null;
    const [kind, from, to, file, line, column] = v as unknown[];
    if (typeof kind !== "string" || typeof from !== "string" || typeof to !== "string" || typeof file !== "string" || !Number.isInteger(line) || !Number.isInteger(column)) return null;
    return { kind, from, to, file, line: line as number, column: column as number };
  } catch {
    return null;
  }
}

function cursorFor(s: Session, req: Request, offset: number): string {
  const fingerprint = createHash("sha1").update(JSON.stringify({ ...req, cursor: undefined, limit: undefined })).digest("hex").slice(0, 16);
  return Buffer.from(JSON.stringify({ g: s.generation, f: fingerprint, o: offset })).toString("base64url");
}

function offsetOf(s: Session, req: Request): number | "bad" {
  if (!req.cursor) return 0;
  try {
    const c = JSON.parse(Buffer.from(req.cursor, "base64url").toString("utf8")) as { g: string | null; f: string; o: number };
    const want = JSON.parse(Buffer.from(cursorFor(s, req, 0), "base64url").toString("utf8")) as { g: string | null; f: string };
    return c.g === want.g && c.f === want.f && Number.isInteger(c.o) && c.o >= 0 ? c.o : "bad";
  } catch {
    return "bad";
  }
}

function page<T>(s: Session, req: Request, all: T[]): { items: T[]; truncated: Answer["truncated"] } | "bad" {
  const offset = offsetOf(s, req);
  if (offset === "bad") return "bad";
  const limit = Math.min(Math.max(1, req.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const items = all.slice(offset, offset + limit);
  const rest = all.length - offset - items.length;
  return { items, truncated: { by: rest > 0 ? "limit" : null, omitted: Math.max(0, rest), omittedExact: true, cursor: rest > 0 ? cursorFor(s, req, offset + items.length) : null } };
}

function nameCauses(g: Graph, name: string): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const u of g.unknowns) if (u.name === name) out[u.cause] = (out[u.cause] ?? 0) + 1;
  return out;
}

// Edges in or out of `start`, walked to `depth` hops; each item keeps its hop.
function walk(g: Graph, start: string, dir: "in" | "out", depth: number, tiers: ReadonlySet<Tier>): Item[] {
  const items: Item[] = [];
  const seen = new Set([start]);
  let frontier = [start];
  for (let d = 1; d <= depth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const at of frontier) {
      const edges = (dir === "in" ? g.in.get(at) : g.out.get(at)) ?? [];
      for (const e of edges) {
        const other = dir === "in" ? e.from : e.to;
        for (const site of e.sites) {
          if (!tiers.has(site.tier)) continue;
          items.push({ from: e.from, to: e.to, kind: e.kind, depth: d, site, edge: edgeId(e, site), fromName: g.nodes.get(e.from)?.name ?? null, toName: g.nodes.get(e.to)?.name ?? null });
        }
        if (!seen.has(other)) {
          seen.add(other);
          next.push(other);
        }
      }
    }
    frontier = next;
  }
  const rank = (t: Tier) => (t === "certain" ? 0 : t === "likely" ? 1 : 2);
  return items.sort((a, b) => a.depth - b.depth || rank(a.site.tier) - rank(b.site.tier) || a.site.file.localeCompare(b.site.file) || a.site.line - b.site.line);
}

function counts(items: Item[]): Answer["counts"] {
  const c = { certain: 0, likely: 0, possible: 0 };
  for (const i of items) c[i.site.tier]++;
  return c;
}

export function query(s: Session, req: Request, extra: { changes?: { exports: ImpactExportChange[]; removed: ImpactSymbol[]; moved: ImpactSymbol[] } } = {}): Answer {
  const g = s.graph;
  if (req.apiVersion !== API_VERSION) return fail(s, req.kind, "bad-request", `this graph answers apiVersion ${API_VERSION}, not ${req.apiVersion}`);
  if (req.generation && s.generation && req.generation !== s.generation) return fail(s, req.kind, "generation-unavailable", `this session holds build ${s.generation}, not ${req.generation}`);
  const tiers = new Set<Tier>(req.tiers ?? ["certain", "likely", "possible"]);
  const kind = req.kind;
  const base = empty(s, kind);

  if (kind === "status") return { ...base, items: [{ ...g.status, eligible: g.status.eligibleFiles, inGraph: g.status.filesParsed }] };
  if (kind === "capabilities") {
    return {
      ...base,
      items: [
        {
          apiVersion: API_VERSION,
          modelVersion: MODEL_VERSION,
          languages: ["typescript", "tsx", "javascript", "python", "go", "ruby"],
          operations: OPERATIONS,
          relations: ["calls", "inherits", "imports"],
          certainEvidence: [...CERTAIN_KINDS],
          notYet: ["implementers and calls through interfaces (phase 2)", "references to functions used as values (phase 2)", "routes, handlers and tests (phase 4)"],
        },
      ],
    };
  }
  if (kind === "search") {
    const text = (req.text ?? req.target?.name ?? "").trim();
    if (text === "") return fail(s, kind, "bad-request", "search needs a text");
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
    const p = page(s, req, scored);
    if (p === "bad") return fail(s, kind, "generation-unavailable", "the cursor belongs to another request or build");
    // Search results are leads: never counted as callers or anything else.
    return { ...base, leads: p.items, truncated: p.truncated };
  }
  if (kind === "unknowns") {
    const t = req.target ?? {};
    const project = t.file && !t.name ? g.projectOf(t.file) : null;
    const all = g.unknowns.filter((u) => (t.name ? u.name === t.name : true) && (t.file ? u.file === t.file || (u.scope === "project" && project !== null && g.projectOf(u.file) === project) : true));
    const p = page(s, req, all.map(toImpactUnknown));
    if (p === "bad") return fail(s, kind, "generation-unavailable", "the cursor belongs to another request or build");
    const causes: Record<string, number | null> = {};
    for (const u of all) causes[u.cause] = (causes[u.cause] ?? 0) + 1;
    return { ...base, items: [...p.items, ...(t.file ? g.status.notRead.filter((n) => n.file === t.file).map((n) => ({ file: n.file, cause: "file-not-parsed", note: n.reason })) : [])], truncated: p.truncated, unknown: { ...base.unknown, causes } };
  }
  if (kind === "changes") {
    const c = extra.changes;
    if (!c) return fail(s, kind, "bad-request", "no base was compared for this graph; run `openqodex graph changes` with a change against its base");
    return { ...base, items: [...c.exports.map((e) => ({ type: "export", ...e })), ...c.removed.map((r) => ({ type: "removed", ...r })), ...c.moved.map((m) => ({ type: "moved", ...m }))] };
  }
  if (kind === "explain") {
    const id = req.target?.id ?? "";
    const parsed = readEdgeId(id);
    if (!parsed) return fail(s, kind, "bad-request", "explain takes an edge id as the items of callers and callees print it");
    const { kind: k, from, to, file, line, column } = parsed;
    const edges = k === "imports" ? (g.importers.get(to) ?? []) : (g.out.get(from) ?? []);
    const e = edges.find((x) => x.kind === k && x.from === from && x.to === to);
    const site = e?.sites.find((x) => x.file === file && x.line === line && x.column === column);
    if (!e || !site) return fail(s, kind, "not-found", `no edge ${id} in this graph`);
    return { ...base, items: [{ edge: id, from: e.from, to: e.to, kind: e.kind, site, why: site.tier === "certain" ? `${site.evidence} proves it${site.via ? `: the import at ${site.via.file}:${site.via.line}` : ""}` : site.note }] };
  }

  // The operations on one symbol or file.
  const found = resolveTarget(g, req.target ?? {});
  if (found.length === 0) return fail(s, kind, "not-found", "no symbol or file of that name in this graph; try `search`");
  if (found.length > 1) {
    return { ...fail(s, kind, "ambiguous", `${found.length} definitions match; name one by its id or file and line`), target: found.map((n) => candidate(g, n, 1)) };
  }
  const n = found[0] as GraphNode;
  const target = candidate(g, n, 1);
  if (kind === "symbol") {
    const callers = (g.in.get(n.id) ?? []).reduce((k, e) => k + e.sites.length, 0);
    const callees = (g.out.get(n.id) ?? []).reduce((k, e) => k + e.sites.length, 0);
    return { ...base, target, items: [{ ...n, project: g.projectOf(n.file), callerSites: callers, calleeSites: callees }] };
  }
  if (kind === "importers") {
    const file = n.kind === "file" ? n.file : n.file;
    const edges = [...(g.importers.get(file) ?? []), ...(file.endsWith(".go") ? (g.importers.get(`go:${file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ""}`) ?? []) : [])];
    const items = edges.map((e) => ({ from: e.from, to: e.to, kind: e.kind, depth: 1, site: e.sites[0] as GraphSite, edge: edgeId(e, e.sites[0] as GraphSite), fromName: null, toName: null }));
    const p = page(s, req, items);
    if (p === "bad") return fail(s, kind, "generation-unavailable", "the cursor belongs to another request or build");
    return { ...base, target, items: p.items, counts: counts(items), truncated: p.truncated };
  }
  if (kind === "callers" || kind === "callees") {
    const depth = Math.min(Math.max(1, req.depth ?? 1), 3);
    const all = walk(g, n.id, kind === "callers" ? "in" : "out", depth, tiers);
    const p = page(s, req, all);
    if (p === "bad") return fail(s, kind, "generation-unavailable", "the cursor belongs to another request or build");
    const reasons = kind === "callers" ? floorReasons(g, { id: n.id, name: n.name, file: n.file }, new Set()) : [];
    const causes = nameCauses(g, n.name);
    const examples = g.unknowns.filter((u) => u.name === n.name).slice(0, 5).map(toImpactUnknown);
    const partial = g.status.status === "partial";
    return {
      ...base,
      target,
      items: p.items,
      counts: counts(all),
      unknown: { floor: reasons.length > 0 || partial, reasons: [...reasons, ...(partial ? g.status.reasons : [])], causes, examples },
      truncated: p.truncated,
    };
  }
  return fail(s, kind, "bad-request", `unknown operation ${kind}`);
}
