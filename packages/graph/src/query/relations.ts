// The questions of phase 3 that read relations beyond one symbol's direct
// edges: what implements or overrides it, who uses it as a value, how two
// points are connected, what a change reaches, what a file or folder
// holds, which packages depend on a package, and which import cycles exist.
//
// Each reads the graph through its public shape only (nodes, edges, the
// importers index, the unknown records, the project of a file); none
// binds anything the resolver did not bind. A relation this build does not
// produce is a capability boundary, never an empty success.
import { detectImpact, toImpactUnknown } from "../impact.js";
import type { Tier } from "../model/records.js";
import { weakest } from "../model/records.js";
import type { Graph, GraphEdge, GraphNode, GraphSite } from "../types.js";
import { BAD_CURSOR, candidate, counts, empty, fail, onePoint, qualified } from "./answer.js";
import type { Answer, Extra, Request, Session } from "./answer.js";
import { edgeId } from "./ids.js";
import { page } from "./page.js";
import { RANK, cycles, importsFrom, shortestPath, sortItems, spent, toItem, walk } from "./traverse.js";
import type { Budget, Item } from "./traverse.js";

// The relations the resolver of this build produces. A later phase that
// adds a relation adds it here; a relation found on an edge of the graph
// counts as produced too.
export const RESOLVED_RELATIONS = ["calls", "inherits", "imports"] as const;
const REFERENCE_KINDS = ["uses_value", "uses_type", "reads", "writes", "may_invoke", "decorates"];
const KNOWN_KINDS = new Set([...RESOLVED_RELATIONS, "implements", "overrides", "dispatches_to", ...REFERENCE_KINDS]);

const produced = new WeakMap<Graph, Set<string>>();
export function relationsOf(g: Graph): Set<string> {
  let set = produced.get(g);
  if (!set) {
    set = new Set<string>(RESOLVED_RELATIONS);
    for (const e of g.edges) set.add(e.kind);
    produced.set(g, set);
  }
  return set;
}

const ALL_TIERS = new Set<Tier>(["certain", "likely", "possible"]);

// Files of a project the graph did not read.
function notReadIn(g: Graph, project: string): number {
  return g.status.notRead.filter((n) => g.projectOf(n.file) === project).length;
}

// The truncated block of a walk: stopped by the budget (no count past the
// frontier, no cursor: a page of an unfinished list would not hold still),
// cut by the page, or stopped at the depth asked.
function walkTruncation(stopped: boolean, beyond: boolean, frontier: string[], paged: Answer["truncated"]): Answer["truncated"] {
  const front = { frontier: frontier.slice(0, 50), frontierTotal: frontier.length };
  if (stopped) return { by: "budget", omitted: null, omittedExact: false, cursor: null, ...front };
  if (paged.by !== null) return paged;
  if (beyond) return { by: "depth", omitted: null, omittedExact: false, cursor: null, ...front };
  return paged;
}

function withFloor(base: Answer, reasons: string[], causes: Record<string, number | null> = {}): Answer["unknown"] {
  const all = [...reasons, ...base.unknown.reasons];
  return { floor: all.length > 0 || base.unknown.floor, reasons: all, causes: { ...base.unknown.causes, ...causes }, examples: base.unknown.examples };
}

// ---------- implementers ----------

type Override = Item & { premises: string[] };

// The class a method belongs to: the definition in the same file whose
// qualified name is the method's owner path.
function ownerClass(g: Graph, m: GraphNode): GraphNode | null {
  const q = qualified(m);
  const dot = q.lastIndexOf(".");
  if (dot === -1) return null;
  const owner = q.slice(0, dot);
  return (g.defsByFile.get(m.file) ?? []).find((d) => (d.kind === "class" || d.kind === "type" || d.kind === "module") && qualified(d) === owner) ?? null;
}

// Overrides of a method found from the inheritance the graph resolved: a
// method of the same name on a class that inherits the owner, directly or
// through others. The inheritance is proved; the override rests on the
// name and on a lookup order the graph does not resolve, so it is likely
// at most and names the inheritance it rests on.
export function derivedOverrides(g: Graph, m: GraphNode, depth: number, budget: Budget): { items: Override[]; stopped: boolean } {
  const owner = ownerClass(g, m);
  if (!owner) return { items: [], stopped: false };
  const subs = walk(g, owner.id, "in", depth, ALL_TIERS, budget, new Set(["inherits"]));
  // The inheritance chain of each subclass back to the owner, strongest site per hop.
  const up = new Map<string, Item>();
  for (const i of subs.items) {
    const have = up.get(i.from);
    if (!have || i.depth < have.depth || (i.depth === have.depth && RANK[i.site.tier] < RANK[have.site.tier])) up.set(i.from, i);
  }
  const out: Override[] = [];
  const name = m.name;
  for (const [sub, link] of up) {
    const cls = g.nodes.get(sub);
    if (!cls) continue;
    const prefix = `${qualified(cls)}.${name}`;
    const own = (g.defsByFile.get(cls.file) ?? []).filter((d) => d.kind === "method" && qualified(d) === prefix);
    if (own.length === 0) continue;
    const premises: string[] = [];
    let tier: Tier = "likely";
    let at: Item | undefined = link;
    while (at) {
      premises.push(at.edge);
      tier = weakest(tier, at.site.tier);
      at = at.to === owner.id ? undefined : up.get(at.to);
    }
    for (const d of own) {
      const site: GraphSite = {
        file: d.file,
        line: d.startLine,
        column: 0,
        tier,
        evidence: "override-by-name",
        via: { file: link.site.file, line: link.site.line, spec: null },
        note: `a method of the same name on a class that inherits ${qualified(owner)} (${link.site.file}:${link.site.line}); method lookup order is not resolved`,
        rule: "query-override-by-name",
      };
      const e = { from: d.id, to: m.id, kind: "overrides" };
      out.push({ ...toItem(g, e, site, link.depth), edge: edgeId(e, site), premises });
    }
  }
  return { items: sortItems(out) as Override[], stopped: subs.stopped };
}

export function implementers(s: Session, req: Request, budget: Budget, tiers: ReadonlySet<Tier>): Answer {
  const g = s.graph;
  const base = empty(s, "implementers");
  const n = onePoint(s, "implementers", req.target);
  if ("apiVersion" in n) return n;
  if (n.kind !== "class" && n.kind !== "type" && n.kind !== "method" && n.kind !== "module") {
    return fail(s, "implementers", "bad-request", `implementers takes a class, an interface, a type or a method; ${n.name} is a ${n.kind}`);
  }
  const rel = relationsOf(g);
  const depth = Math.min(Math.max(1, req.depth ?? 3), 8);
  const reasons: string[] = [];
  const causes: Record<string, number | null> = {};
  let items: Item[];
  let stopped = false;
  let beyond = false;
  let frontier: string[] = [];
  if (n.kind === "method") {
    if (rel.has("overrides")) {
      const w = walk(g, n.id, "in", depth, tiers, budget, new Set(["overrides"]));
      ({ items, stopped, beyond, frontier } = w);
    } else {
      const d = derivedOverrides(g, n, depth, budget);
      items = d.items.filter((i) => tiers.has(i.site.tier));
      stopped = d.stopped;
    }
    if (!rel.has("dispatches_to")) {
      reasons.push("calls through an interface or a base type are not resolved in this build, so a method that implements an interface method is not listed here");
      causes["unsupported-rule"] = null;
    }
  } else {
    const kinds = new Set(["inherits", ...(rel.has("implements") ? ["implements"] : [])]);
    const w = walk(g, n.id, "in", depth, tiers, budget, kinds);
    ({ items, stopped, beyond, frontier } = w);
    if (n.kind === "type" && !rel.has("implements")) {
      reasons.push("this build does not read `implements` clauses or Go method sets, so the classes that implement it are not listed");
      causes["unsupported-rule"] = null;
    }
  }
  const project = g.projectOf(n.file);
  const skipped = notReadIn(g, project);
  if (skipped > 0) reasons.push(`${skipped} ${skipped === 1 ? "file" : "files"} of its project ${skipped === 1 ? "was" : "were"} not read`);
  if (stopped) reasons.push("the walk stopped at its time budget");
  const p = page(s.generation, req, items);
  if (p === "bad") return fail(s, "implementers", "generation-unavailable", BAD_CURSOR);
  return { ...base, target: candidate(g, n, 1), items: p.items, counts: counts(items), unknown: withFloor(base, reasons, causes), truncated: walkTruncation(stopped, beyond, frontier, p.truncated) };
}

// ---------- references ----------

export function references(s: Session, req: Request, budget: Budget, tiers: ReadonlySet<Tier>): Answer {
  const g = s.graph;
  const rel = relationsOf(g);
  const kinds = REFERENCE_KINDS.filter((k) => rel.has(k));
  if (kinds.length === 0) {
    return fail(s, "references", "unsupported", "this build does not resolve uses of a symbol as a value or a type; `callers` lists the calls, and `unknowns` the calls through values it could not bind");
  }
  const base = empty(s, "references");
  const n = onePoint(s, "references", req.target);
  if ("apiVersion" in n) return n;
  const w = walk(g, n.id, "in", 1, tiers, budget, new Set(kinds));
  const reasons: string[] = [];
  const skipped = notReadIn(g, g.projectOf(n.file));
  if (skipped > 0) reasons.push(`${skipped} ${skipped === 1 ? "file" : "files"} of its project ${skipped === 1 ? "was" : "were"} not read`);
  if (w.stopped) reasons.push("the walk stopped at its time budget");
  const p = page(s.generation, req, w.items);
  if (p === "bad") return fail(s, "references", "generation-unavailable", BAD_CURSOR);
  return { ...base, target: candidate(g, n, 1), items: p.items, counts: counts(w.items), unknown: withFloor(base, reasons), truncated: walkTruncation(w.stopped, false, w.frontier, p.truncated) };
}

// ---------- path ----------

export const PATH_DEPTH = 8;

export function path(s: Session, req: Request, budget: Budget, tiers: ReadonlySet<Tier>): Answer {
  const g = s.graph;
  const base = empty(s, "path");
  if (!req.to) return fail(s, "path", "bad-request", "path needs a second point: `to`");
  const a = onePoint(s, "path", req.target);
  if ("apiVersion" in a) return a;
  const b = onePoint(s, "path", req.to);
  if ("apiVersion" in b) return b;
  const kinds = req.edges && req.edges.length > 0 ? req.edges : ["calls", "inherits"];
  const unknownKind = kinds.find((k) => !KNOWN_KINDS.has(k));
  if (unknownKind) return fail(s, "path", "bad-request", `no relation named ${unknownKind}`);
  const rel = relationsOf(g);
  const missing = kinds.find((k) => !rel.has(k));
  if (missing) return fail(s, "path", "unsupported", `this build does not resolve ${missing} edges`);
  const set = new Set(kinds);
  // Imports join files: a symbol stands for its file when only imports are walked.
  const onlyImports = kinds.every((k) => k === "imports");
  const from = onlyImports ? a.file : a.id;
  const to = onlyImports ? b.file : b.id;
  const depth = Math.min(Math.max(1, req.depth ?? PATH_DEPTH), PATH_DEPTH);
  const target = [candidate(g, a, 1), candidate(g, b, 1)];
  if (from === to) return { ...base, target, counts: { certain: 0, likely: 0, possible: 0 } };
  const fwd = shortestPath(g, from, to, set, depth, tiers, budget);
  let hops = fwd.hops;
  let direction: "forward" | "reverse" = "forward";
  let rev: typeof fwd | null = null;
  if (!hops && !fwd.stopped) {
    rev = shortestPath(g, to, from, set, depth, tiers, budget);
    if (rev.hops) {
      hops = rev.hops;
      direction = "reverse";
    }
  }
  const stopped = fwd.stopped || rev?.stopped === true;
  if (hops) {
    const items = hops.map((h) => ({ ...h, direction }));
    return { ...base, target, items, counts: counts(items) };
  }
  // No path among the known edges: a floor when an unbound call in the code
  // the search visited, a file not read, or the budget could hide one.
  const visited = new Set([...fwd.visited, ...(rev?.visited ?? [])]);
  const unbound = g.unknowns.filter((u) => u.cause !== "external" && visited.has(u.caller));
  const reasons: string[] = [];
  const causes: Record<string, number | null> = {};
  for (const u of unbound) causes[u.cause] = (causes[u.cause] ?? 0) + 1;
  if (unbound.length > 0) reasons.push(`${unbound.length} ${unbound.length === 1 ? "call" : "calls"} in the code the search visited could not be bound, and could lead from one to the other`);
  if (g.status.notRead.length > 0) reasons.push(`${g.status.notRead.length} ${g.status.notRead.length === 1 ? "file was" : "files were"} not read`);
  if (stopped) reasons.push("the search stopped at its time budget");
  const beyond = !stopped && (fwd.beyond || rev?.beyond === true);
  const unknown = withFloor(base, reasons, causes);
  unknown.examples = unbound.slice(0, 5).map(toImpactUnknown);
  return {
    ...base,
    target,
    counts: { certain: 0, likely: 0, possible: 0 },
    unknown,
    truncated: stopped ? { by: "budget", omitted: null, omittedExact: false, cursor: null } : beyond ? { by: "depth", omitted: null, omittedExact: false, cursor: null } : base.truncated,
  };
}

// ---------- impact ----------

// The review's own walk (impact.ts), seeded by the diff the caller passes
// or by one symbol as if its first line changed. Items: each caller path
// with its hops, each callee, each importer of a changed file, each changed
// public name.
export function impact(s: Session, req: Request, extra: Extra): Answer {
  const g = s.graph;
  const base = empty(s, "impact");
  let change = extra.change;
  let target: Answer["target"] = null;
  if (req.target && (req.target.id || req.target.name || req.target.file)) {
    const n = onePoint(s, "impact", req.target);
    if ("apiVersion" in n) return n;
    target = candidate(g, n, 1);
    change = { files: [{ path: n.file, status: "modified", oldPath: null, binary: false }], coverage: new Map([[n.file, new Set([n.startLine])]]) };
  }
  if (!change) return fail(s, "impact", "bad-request", "impact needs a symbol, or a change compared with its base (`openqodex graph impact` with no symbol)");
  const sum = detectImpact(g, change);
  const hop = (e: { from: string; to: string; kind: string; sites: GraphSite[] }, depth: number): Item => toItem(g, e, e.sites[0] as GraphSite, depth);
  const all: unknown[] = [
    ...sum.callers.map((p) => ({ type: "caller", seed: p.seed, hops: p.edges.map((e, i) => hop(e, i + 1)) })),
    ...sum.callees.map((p) => ({ type: "callee", seed: p.seed, hops: p.edges.map((e, i) => hop(e, i + 1)) })),
    ...sum.importers.map((e) => ({ type: "importer", hops: [hop(e, 1)] })),
    ...sum.exports.map((e) => ({ type: "export", ...e })),
  ];
  const p = page(s.generation, req, all);
  if (p === "bad") return fail(s, "impact", "generation-unavailable", BAD_CURSOR);
  const lastSites = sum.callers.map((c) => c.edges[c.edges.length - 1]?.sites[0]).filter((x): x is GraphSite => x !== undefined);
  return {
    ...base,
    target: target ?? sum.symbols.filter((x) => sum.touched.includes(x.id) || sum.removed.includes(x.id)).map((x) => ({ id: x.id, name: x.name, kind: x.kind, file: x.file, line: x.startLine, project: g.projectOf(x.file), score: 1 })),
    items: p.items,
    counts: counts(lastSites.map((site) => ({ site }))),
    unknown: {
      floor: sum.unknown.floor,
      reasons: [...new Set([...sum.unknown.seeds.flatMap((x) => x.reasons), ...(sum.status === "partial" ? sum.reasons : [])])],
      causes: sum.unknown.causes,
      examples: sum.unknown.near.slice(0, 5),
    },
    truncated: p.truncated,
  };
}

// ---------- outline ----------

export function outline(s: Session, req: Request): Answer {
  const g = s.graph;
  const base = empty(s, "outline");
  const at = (req.target?.file ?? "").replace(/\/+$/, "");
  if (at === "") return fail(s, "outline", "bad-request", "outline takes a file or a folder of the repository");
  const files = g.defsByFile.has(at) ? [at] : [...g.defsByFile.keys()].filter((f) => f.startsWith(`${at}/`)).sort();
  if (files.length === 0) return fail(s, "outline", "not-found", `no file of the graph is ${at} or under it`);
  const sites = (list: GraphEdge[] | undefined) => (list ?? []).reduce((k, e) => k + e.sites.length, 0);
  const all = files.flatMap((f) =>
    (g.defsByFile.get(f) ?? [])
      .slice()
      .sort((x, y) => x.startLine - y.startLine)
      .map((d) => ({ id: d.id, name: d.name, qualified: qualified(d), kind: d.kind, file: d.file, line: d.startLine, endLine: d.endLine, exported: d.exported, callerSites: sites(g.in.get(d.id)), calleeSites: sites(g.out.get(d.id)) })),
  );
  const p = page(s.generation, req, all);
  if (p === "bad") return fail(s, "outline", "generation-unavailable", BAD_CURSOR);
  const notRead = g.status.notRead.filter((n) => n.file === at || n.file.startsWith(`${at}/`));
  const reasons = notRead.length > 0 ? [`${notRead.length} ${notRead.length === 1 ? "file" : "files"} here ${notRead.length === 1 ? "was" : "were"} not read: ${notRead.slice(0, 5).map((n) => `${n.file} (${n.reason})`).join(", ")}`] : [];
  return { ...base, items: p.items, unknown: withFloor(base, reasons), truncated: p.truncated };
}

// ---------- packages and cycles ----------

type Dependency = { from: string; to: string; edges: GraphEdge[] };

// Import edges between files of two different projects, by project pair.
const projectDeps = new WeakMap<Graph, Map<string, Dependency>>();
function dependencies(g: Graph): Map<string, Dependency> {
  let deps = projectDeps.get(g);
  if (deps) return deps;
  deps = new Map();
  for (const list of g.importers.values()) {
    for (const e of list) {
      const from = g.projectOf(e.from);
      const to = e.to.startsWith("go:") ? g.projectOf(`${e.to.slice(3)}/x.go`) : g.projectOf(e.to);
      if (from === to) continue;
      const key = `${from}\0${to}`;
      const d = deps.get(key) ?? { from, to, edges: [] };
      d.edges.push(e);
      deps.set(key, d);
    }
  }
  projectDeps.set(g, deps);
  return deps;
}

function projectsOf(g: Graph): string[] {
  return [...new Set([...g.defsByFile.keys()].map((f) => g.projectOf(f)))].sort();
}

const EDGES_SHOWN = 50;

function importItems(g: Graph, edges: GraphEdge[]): Item[] {
  return sortItems(edges.flatMap((e) => e.sites.map((site) => toItem(g, e, site, 1))));
}

export function packages(s: Session, req: Request): Answer {
  const g = s.graph;
  const base = empty(s, "packages");
  const deps = [...dependencies(g).values()];
  const projects = projectsOf(g);
  const t = req.target ?? {};
  const asked = t.project ?? (t.file ? g.projectOf(t.file) : t.name);
  const reasons: string[] = [];
  const gaps = g.model.unreadable.filter((x) => x.affects.includes("imports"));
  for (const x of gaps) reasons.push(x.note);
  if (g.status.notRead.length > 0) reasons.push(`${g.status.notRead.length} ${g.status.notRead.length === 1 ? "file was" : "files were"} not read, and their imports are not here`);
  let all: unknown[];
  if (asked === undefined) {
    all = projects.map((p) => ({
      project: p,
      files: [...g.defsByFile.keys()].filter((f) => g.projectOf(f) === p).length,
      dependsOn: deps.filter((d) => d.from === p).map((d) => d.to).sort(),
      dependents: deps.filter((d) => d.to === p).map((d) => d.from).sort(),
    }));
  } else {
    if (!projects.includes(asked)) return fail(s, "packages", "not-found", `no project ${asked === "" ? "at the repository root" : asked} in this graph; the projects are ${projects.map((p) => (p === "" ? "(root)" : p)).join(", ")}`);
    all = deps
      .filter((d) => d.to === asked)
      .sort((a, b) => a.from.localeCompare(b.from))
      .map((d) => {
        const items = importItems(g, d.edges);
        return { project: d.from, importSites: items.length, sites: items.slice(0, EDGES_SHOWN).map((i) => `${i.site.file}:${i.site.line}`), edges: items.slice(0, EDGES_SHOWN) };
      });
  }
  const p = page(s.generation, req, all);
  if (p === "bad") return fail(s, "packages", "generation-unavailable", BAD_CURSOR);
  return { ...base, items: p.items, unknown: withFloor(base, reasons), truncated: p.truncated };
}

export function importCycles(s: Session, req: Request, budget: Budget): Answer {
  const g = s.graph;
  const base = empty(s, "cycles");
  const level = req.level ?? "files";
  if (level !== "files" && level !== "projects") return fail(s, "cycles", "bad-request", "cycles takes the level files or projects");
  let groups: string[][];
  let stopped: boolean;
  let between: (members: Set<string>) => Item[];
  if (level === "files") {
    const next = (f: string): string[] => [...new Set(importsFrom(g, f).flatMap((e) => (e.to.startsWith("go:") ? [] : [e.to])))];
    const files = [...new Set([...g.importers.values()].flatMap((l) => l.map((e) => e.from)))].sort();
    ({ groups, stopped } = cycles(files, next, budget));
    between = (m) => importItems(g, [...m].flatMap((f) => importsFrom(g, f).filter((e) => m.has(e.to))));
  } else {
    const deps = [...dependencies(g).values()];
    const next = (p: string): string[] => deps.filter((d) => d.from === p).map((d) => d.to);
    ({ groups, stopped } = cycles(projectsOf(g), next, budget));
    between = (m) => importItems(g, deps.filter((d) => m.has(d.from) && m.has(d.to)).flatMap((d) => d.edges));
  }
  if (spent(budget)) stopped = true;
  const all = groups
    .sort((a, b) => b.length - a.length || (a[0] ?? "").localeCompare(b[0] ?? ""))
    .map((members) => {
      const edges = between(new Set(members));
      return { level, members, size: members.length, edgeCount: edges.length, edges: edges.slice(0, EDGES_SHOWN) };
    });
  const p = page(s.generation, req, all);
  if (p === "bad") return fail(s, "cycles", "generation-unavailable", BAD_CURSOR);
  const reasons = stopped ? ["the search stopped at its time budget; cycles past it are not listed"] : [];
  if (g.status.notRead.length > 0) reasons.push(`${g.status.notRead.length} ${g.status.notRead.length === 1 ? "file was" : "files were"} not read, and their imports are not here`);
  return { ...base, items: p.items, unknown: withFloor(base, reasons), truncated: stopped ? { by: "budget", omitted: null, omittedExact: false, cursor: null } : p.truncated };
}
