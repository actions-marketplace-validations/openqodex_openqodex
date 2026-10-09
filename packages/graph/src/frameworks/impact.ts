// The framework part of a change's impact summary: which routes reach the
// touched code, which registrations the change declares or left without a
// handler, which templates the touched code renders and who renders a
// changed template, which migrations change a touched model, and which
// tests reference, call or may request the touched code. Read through the
// framework layer only.
import type { Change, ImpactFrameworkRoute, ImpactFrameworkTest, ImpactFrameworks } from "@openqodex/core";
import type { Graph } from "../types.js";
import { frameworkLayer } from "./layer.js";
import type { Entity, Registration } from "./plugin.js";

export const MAX_SEEDS = 25;
export const MAX_ROUTES = 40;
export const MAX_TESTS = 40;
export const MAX_ROWS = 40;

const routeLabel = (r: Registration) => `${r.methods.map((m) => (m === "*" ? "ANY" : m)).join("|")} ${r.pattern ?? r.partial ?? "(computed path)"}`;

// Everything the brief's framework tables cut, uncut, for the review's
// packet: every route that reaches each touched symbol, every test link,
// every template rendered and every migration of a touched model, plus the
// summary's declared and orphaned routes. Null when the stage did not run.
export function frameworkPacket(graph: Graph, impact: { touched: readonly string[]; frameworks?: ImpactFrameworks }): Record<string, unknown> | null {
  const layer = frameworkLayer(graph);
  if (!layer || !impact.frameworks) return null;
  const routes = new Map<string, Record<string, unknown>>();
  const asRow = (r: Registration) => ({ registration: r.id, plugin: r.plugin, app: r.app, methods: r.methods, pattern: r.pattern, partial: r.partial ?? null, name: r.name, site: r.site, handler: r.handler, mounted: r.mounted, mountedVia: r.mountedVia });
  const declared = new Set(impact.frameworks.routes.filter((r) => r.declared).map((r) => r.registration));
  for (const id of impact.frameworks.routeIds ?? impact.frameworks.routes.map((r) => r.registration)) {
    const r = layer.entity(id);
    if (r && r.kind === "registration") routes.set(r.id, { ...asRow(r), declared: declared.has(r.id) || undefined, reaches: [] });
  }
  const tests: Record<string, unknown>[] = [];
  const renders: Record<string, unknown>[] = [];
  const migrations: Record<string, unknown>[] = [];
  let cut = false;
  for (const seed of impact.touched) {
    const reach = layer.routesReaching(seed);
    cut = cut || reach.cut;
    for (const x of reach.routes) {
      const row = routes.get(x.registration.id) ?? { ...asRow(x.registration), declared: false, reaches: [] };
      (row.reaches as unknown[]).push({ seed, path: x.path, hops: x.hops, tier: x.tier, note: x.note });
      routes.set(x.registration.id, row);
    }
    for (const t of layer.testsOf(seed)) tests.push({ ...t, target: seed });
    for (const e of layer.edgesFrom(seed)) if (e.kind === "renders") renders.push({ from: seed, to: layer.entity(e.to), evidence: e.evidence });
    for (const e of layer.edgesTo(seed)) if (e.kind === "changes_schema") migrations.push({ model: seed, migration: e.from, evidence: e.evidence });
  }
  const unknowns = layer.unknownsIn(new Set(impact.frameworks.changedFiles ?? []));
  return {
    routes: [...routes.values()],
    routesTotal: routes.size,
    walkCut: cut,
    unknowns,
    tests,
    renders,
    migrations,
    note: "Test links are static references, calls or possible requests, never coverage.",
  };
}

export function frameworkImpact(graph: Graph, change: Pick<Change, "files" | "coverage">, touched: readonly string[], removed: readonly string[]): ImpactFrameworks | undefined {
  const layer = frameworkLayer(graph);
  if (!layer) return undefined;
  const nameOf = (id: string): string => {
    const n = graph.nodes.get(id);
    if (n) {
      const owner = id.slice(id.indexOf("#") + 1, id.lastIndexOf("@")).split(".").slice(0, -1).join(".");
      return n.kind === "method" && owner ? `${owner}.${n.name}` : n.name;
    }
    const e = layer.entity(id);
    if (e) return e.kind === "registration" ? routeLabel(e) : e.name;
    return id;
  };
  const changed = new Set(change.files.filter((f) => f.status !== "deleted").map((f) => f.path));
  const allChanged = new Set(change.files.flatMap((f) => [f.path, ...(f.oldPath ? [f.oldPath] : [])]));
  const seeds = touched.slice(0, MAX_SEEDS);

  // ---------- routes ----------
  const routes = new Map<string, ImpactFrameworkRoute>();
  const asRoute = (r: Registration): ImpactFrameworkRoute => ({
    plugin: r.plugin,
    app: r.app,
    registration: r.id,
    methods: r.methods,
    pattern: r.pattern,
    partial: r.partial ?? null,
    name: r.name,
    site: { file: r.site.file, line: r.site.line },
    handler: r.handler.written,
    status: r.handler.status,
    mounted: r.mounted,
    reach: null,
    declared: false,
  });
  for (const seed of seeds) {
    for (const reach of layer.routesReaching(seed).routes) {
      const row = routes.get(reach.registration.id) ?? asRoute(reach.registration);
      if (!row.reach || reach.hops < row.reach.hops) row.reach = { seed, seedName: nameOf(seed), hops: reach.hops, tier: reach.tier, note: reach.note };
      routes.set(reach.registration.id, row);
    }
  }
  const removedNames = new Set(removed.map((id) => graph.nodes.get(id)?.name ?? id.slice(id.indexOf("#") + 1, id.lastIndexOf("@")).split(".").pop() ?? ""));
  for (const r of layer.registrations()) {
    const lines = change.coverage.get(r.site.file);
    const declared = changed.has(r.site.file) && (lines?.has(r.site.line) ?? false);
    // A handler gone with this change: the registration stays, and says so.
    const tail = r.handler.written.replace(/\.as_view\(\)$/, "").split(/[.#]/).pop() ?? "";
    const orphaned = r.handler.status !== "bound" && r.handler.status !== "external" && (changed.has(r.site.file) || (tail !== "" && removedNames.has(tail)));
    if (!declared && !orphaned) continue;
    const row = routes.get(r.id) ?? asRoute(r);
    row.declared = row.declared || declared;
    routes.set(r.id, row);
  }
  const routeRows = [...routes.values()].sort((a, b) => Number(a.status === "bound") - Number(b.status === "bound") || (a.reach?.hops ?? 99) - (b.reach?.hops ?? 99) || a.site.file.localeCompare(b.site.file) || a.site.line - b.site.line);

  // ---------- templates ----------
  const renders: ImpactFrameworks["renders"] = [];
  for (const seed of seeds) {
    for (const e of layer.edgesFrom(seed)) {
      if (e.kind !== "renders") continue;
      const t = layer.entity(e.to);
      if (!t || t.kind === "registration") continue;
      renders.push({ from: seed, fromName: nameOf(seed), template: t.name, file: t.file, tier: e.evidence.tier, note: e.evidence.note, site: { file: e.evidence.site.file, line: e.evidence.site.line } });
    }
  }
  const renderedBy: ImpactFrameworks["renderedBy"] = [];
  for (const file of changed) {
    for (const t of layer.entitiesIn(file)) {
      if (t.kind !== "template" || t.file !== file) continue;
      for (const e of layer.edgesTo(t.id)) if (e.kind === "renders") renderedBy.push({ template: file, by: e.from, byName: nameOf(e.from), site: { file: e.evidence.site.file, line: e.evidence.site.line } });
    }
  }

  // ---------- models and migrations ----------
  const operationOf = (premises: string[]): string => {
    for (const p of premises) {
      const e = layer.entity(p);
      if (e && e.kind === "migration_operation") return e.name;
    }
    return "";
  };
  const models: ImpactFrameworks["models"] = [];
  for (const seed of seeds) {
    if (!layer.rolesOf(seed).some((r) => r.role === "model")) continue;
    const migrations = layer
      .edgesTo(seed)
      .filter((e) => e.kind === "changes_schema")
      .map((e) => ({ file: e.from, line: e.evidence.site.line, operation: operationOf(e.evidence.premises) }))
      .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    models.push({ model: seed, name: nameOf(seed), migrations });
  }
  const migrations: ImpactFrameworks["migrations"] = [];
  for (const file of changed) {
    if (!layer.rolesOf(file).some((r) => r.role === "migration")) continue;
    const ops = layer.entitiesIn(file).filter((e): e is Exclude<Entity, Registration> => e.kind === "migration_operation");
    const targets = layer.edgesFrom(file).filter((e) => e.kind === "changes_schema" || e.kind === "maps_to");
    migrations.push({ file, operations: ops.map((o) => o.name), models: [...new Set(targets.map((e) => nameOf(e.to)))] });
  }

  // ---------- tests ----------
  const tests: ImpactFrameworkTest[] = [];
  const seenTests = new Set<string>();
  for (const seed of seeds) {
    for (const link of layer.testsOf(seed)) {
      const k = `${link.test}\0${seed}\0${link.category}\0${link.via ?? ""}`;
      if (seenTests.has(k)) continue;
      seenTests.add(k);
      const via = link.via ? layer.entity(link.via) : null;
      tests.push({
        test: link.test,
        testName: nameOf(link.test),
        target: seed,
        targetName: nameOf(seed),
        category: link.category,
        through: via && via.kind === "registration" ? routeLabel(via) : null,
        tier: link.tier,
        note: link.note,
        site: link.site,
      });
    }
  }
  const tierRank = { certain: 0, likely: 1, possible: 2 } as const;
  tests.sort((a, b) => tierRank[a.tier] - tierRank[b.tier] || a.site.file.localeCompare(b.site.file) || a.site.line - b.site.line);

  // ---------- roles and gaps ----------
  const roles: ImpactFrameworks["roles"] = [];
  for (const seed of seeds) {
    for (const r of layer.rolesOf(seed)) {
      if (r.role === "route_handler" || r.role === "test") continue;
      if (!roles.some((x) => x.target === seed && x.role === r.role)) roles.push({ target: seed, name: nameOf(seed), role: r.role, detail: r.detail });
    }
  }
  const unknowns = layer.unknownsIn(allChanged);
  return {
    plugins: layer.data.plugins.filter((p) => p.apps > 0 || p.status === "failed" || p.status === "stopped").map((p) => ({ id: p.id, status: p.status, reason: p.reason, apps: p.apps })),
    routes: routeRows.slice(0, MAX_ROUTES),
    routesTotal: routeRows.length,
    renders: renders.slice(0, MAX_ROWS),
    renderedBy: renderedBy.slice(0, MAX_ROWS),
    models: models.slice(0, MAX_ROWS),
    migrations: migrations.slice(0, MAX_ROWS),
    tests: tests.slice(0, MAX_TESTS),
    testsTotal: tests.length,
    roles: roles.slice(0, MAX_ROWS),
    unknown: unknowns.slice(0, MAX_ROWS).map((u) => ({ file: u.site?.file ?? ("file" in u.scope ? u.scope.file : null), line: u.site?.line ?? null, cause: u.cause, note: u.note })),
    unknownTotal: unknowns.length,
    changedFiles: [...allChanged].sort(),
    routeIds: routeRows.map((r) => r.registration),
  };
}
