// The framework layer's read side: what the brief and the query layer ask
// of the framework data on a graph. Built once per graph, lazily, from the
// plain data the stage produced (or a retained index read back).
//
// Answers keep the registration apart from its handler, carry the tier of
// the weakest step on the way, and say "references, calls or may request"
// for tests, never "covers".
import { weakest } from "../model/records.js";
import type { Tier } from "../model/records.js";
import type { Graph, GraphEdge } from "../types.js";
import type { Entity, FrameworkEdge, FrameworkUnknown, Registration, RoleAssignment, TestCategory } from "./plugin.js";
import type { FrameworkData } from "./stage.js";

// The call-like relations a route reaches code through (PLAN.md 3.2.5, the
// `calls` profile): later phases add dispatch and value invocation kinds.
const CALL_KINDS: ReadonlySet<string> = new Set(["calls", "dispatches_to", "may_invoke"]);
export const REACH_DEPTH = 3;
export const REACH_VISITS = 2000;

// A registration that reaches a symbol: through its own handler (hops 0)
// or through calls from the handler. `path` lists the symbols from the
// handler to the target; `tier` is the weakest step.
export type RouteReach = { registration: Registration; handler: string; path: string[]; hops: number; tier: Tier; note: string | null };

// A test that references, calls or may request a symbol: directly, through
// a route that reaches it, or by naming its class.
export type TestLink = { test: string; target: string; category: TestCategory; tier: Tier; via: string | null; site: { file: string; line: number }; note: string | null };

export type FrameworkLayer = {
  data: FrameworkData;
  registrations(): Registration[];
  entity(id: string): Entity | null;
  rolesOf(id: string): RoleAssignment[];
  edgesFrom(id: string): FrameworkEdge[];
  edgesTo(id: string): FrameworkEdge[];
  // Registrations whose handler is the symbol, or reaches it in at most
  // `depth` call hops. `cut` is set when the walk stopped at its visit cap.
  routesReaching(symbol: string, depth?: number): { routes: RouteReach[]; cut: boolean };
  // Registrations declared in a file (a route table that changed).
  registrationsIn(file: string): Registration[];
  // Entities that are the file or are declared in it: a template, a
  // migration, a model field, a command.
  entitiesIn(file: string): Entity[];
  // Tests that reference, call or may request the symbol.
  testsOf(symbol: string, depth?: number): TestLink[];
  // What the plugins could not see in these files, and every gap with no
  // site of the applications and projects that hold them (a cap, a budget,
  // a computed root URL module): those can hide anything in the files.
  unknownsIn(files: ReadonlySet<string>): FrameworkUnknown[];
};

const layers = new WeakMap<Graph, FrameworkLayer>();

export function frameworkLayer(graph: Graph): FrameworkLayer | null {
  const data = graph.frameworks;
  if (!data) return null;
  const kept = layers.get(graph);
  if (kept && kept.data === data) return kept;
  const layer = makeLayer(graph, data);
  layers.set(graph, layer);
  return layer;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

function joinNotes(...notes: (string | null)[]): string | null {
  const kept = [...new Set(notes.filter((n): n is string => n !== null && n !== ""))];
  return kept.length > 0 ? kept.join(" ") : null;
}

function makeLayer(graph: Graph, data: FrameworkData): FrameworkLayer {
  const entities = new Map<string, Entity>();
  const byFile = new Map<string, Entity[]>();
  const registrationsByFile = new Map<string, Registration[]>();
  for (const e of data.entities) {
    entities.set(e.id, e);
    const files = new Set<string>();
    if (e.kind === "registration") {
      files.add(e.site.file);
      push(registrationsByFile, e.site.file, e);
    } else {
      if (e.file) files.add(e.file);
      if (e.site) files.add(e.site.file);
    }
    for (const f of files) push(byFile, f, e);
  }
  const roles = new Map<string, RoleAssignment[]>();
  for (const r of data.roles) push(roles, r.target, r);
  const from = new Map<string, FrameworkEdge[]>();
  const to = new Map<string, FrameworkEdge[]>();
  for (const e of data.edges) {
    push(from, e.from, e);
    push(to, e.to, e);
  }
  const handlersOf = (symbol: string) => (to.get(symbol) ?? []).filter((e) => e.kind === "handles");

  const routesReaching = (symbol: string, depth = REACH_DEPTH): { routes: RouteReach[]; cut: boolean } => {
    // Backward walk over call edges from the symbol; each symbol reached is
    // checked for a registration that handles it.
    type Step = { id: string; path: string[]; tier: Tier; note: string | null };
    const best = new Map<string, Step>();
    let frontier: Step[] = [{ id: symbol, path: [symbol], tier: "certain", note: null }];
    best.set(symbol, frontier[0] as Step);
    let visits = 1;
    let cut = false;
    for (let hop = 0; hop < depth && frontier.length > 0; hop++) {
      const next: Step[] = [];
      for (const s of frontier) {
        for (const e of graph.in.get(s.id) ?? ([] as GraphEdge[])) {
          if (!CALL_KINDS.has(e.kind)) continue;
          if (best.has(e.from)) continue;
          if (visits >= REACH_VISITS) {
            cut = true;
            break;
          }
          const site = e.sites.find((x) => x.tier === e.tier) ?? e.sites[0];
          const step: Step = { id: e.from, path: [e.from, ...s.path], tier: weakest(s.tier, e.tier), note: joinNotes(s.note, e.tier === "certain" ? null : (site?.note ?? null)) };
          best.set(e.from, step);
          next.push(step);
          visits++;
        }
      }
      frontier = next;
    }
    const routes: RouteReach[] = [];
    for (const s of best.values()) {
      for (const h of handlersOf(s.id)) {
        const reg = entities.get(h.from);
        if (!reg || reg.kind !== "registration") continue;
        routes.push({ registration: reg, handler: s.id, path: s.path, hops: s.path.length - 1, tier: weakest(h.evidence.tier, s.tier), note: joinNotes(h.evidence.note, s.note) });
      }
    }
    routes.sort((a, b) => a.hops - b.hops || a.registration.site.file.localeCompare(b.registration.site.file) || a.registration.site.line - b.registration.site.line);
    return { routes, cut };
  };

  const testsOf = (symbol: string, depth = REACH_DEPTH): TestLink[] => {
    const links: TestLink[] = [];
    const add = (e: FrameworkEdge, target: string, via: string | null, tier: Tier, note: string | null) => {
      links.push({ test: e.from, target, category: e.category ?? "type-or-value-reference", tier, via, site: { file: e.evidence.site.file, line: e.evidence.site.line }, note });
    };
    for (const e of to.get(symbol) ?? []) if (e.kind === "tests") add(e, symbol, null, e.evidence.tier, e.evidence.note);
    // A test that names the class the symbol belongs to.
    const node = graph.nodes.get(symbol);
    if (node && node.kind === "method") {
      const owner = (graph.defsByFile.get(node.file) ?? []).find((n) => n.kind === "class" && symbol.startsWith(`${node.file}#${n.name}.`));
      if (owner) for (const e of to.get(owner.id) ?? []) if (e.kind === "tests") add(e, symbol, owner.id, weakest(e.evidence.tier, "possible"), joinNotes(e.evidence.note, "the test names the class, not this method"));
    }
    // A test that requests or names a route that reaches the symbol.
    for (const r of routesReaching(symbol, depth).routes) {
      for (const e of to.get(r.registration.id) ?? []) {
        if (e.kind !== "tests") continue;
        add(e, symbol, r.registration.id, weakest(e.evidence.tier, r.tier), joinNotes(e.evidence.note, r.note));
      }
    }
    const seen = new Set<string>();
    return links.filter((l) => {
      const k = `${l.test}\0${l.category}\0${l.via ?? ""}\0${l.site.file}:${l.site.line}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  return {
    data,
    registrations: () => data.entities.filter((e): e is Registration => e.kind === "registration"),
    entity: (id) => entities.get(id) ?? null,
    rolesOf: (id) => roles.get(id) ?? [],
    edgesFrom: (id) => from.get(id) ?? [],
    edgesTo: (id) => to.get(id) ?? [],
    routesReaching,
    registrationsIn: (file) => registrationsByFile.get(file) ?? [],
    entitiesIn: (file) => byFile.get(file) ?? [],
    testsOf,
    unknownsIn: (files) => {
      const projects = new Set([...files].map((f) => graph.projectOf(f)));
      const apps = new Set(data.apps.filter((a) => projects.has(a.project)).map((a) => a.id));
      return data.unknowns.filter((u) => {
        if (u.site !== null) return files.has(u.site.file);
        if ("file" in u.scope) return files.has(u.scope.file);
        if ("app" in u.scope) return apps.has(u.scope.app);
        return projects.has(u.scope.project);
      });
    },
  };
}
