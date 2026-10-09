// The FastAPI plugin's resolve step: which values are FastAPI applications
// and routers, which decorators and calls on them register routes and
// include routers, what each registration's full pattern and handler are,
// which dependencies run before each handler, which classes are Pydantic
// models, and which test requests may reach which route.
//
// API identity: a value is an application only when it is made by calling
// FastAPI imported from the fastapi package (`from fastapi import FastAPI`
// under any alias, or `fastapi.FastAPI` after `import fastapi`), a router
// only when it is made by calling fastapi's APIRouter, and the fastapi
// module must resolve outside the repository. A dependency on fastapi
// enables the rules; it never proves that `@app.get` is a route. A
// decorator on any other value, such as a registry of the repository's own
// with a get method, is no registration.
//
// FastAPI joins prefixes as written, with no slash normalisation: the
// include prefix, then the router's own prefix, then the path. A route
// whose own path is computed (an f-string with a replacement field, a
// concatenation with anything but a string constant of the same module) is
// no registration: it is an unknown of cause "dynamic" naming the handler.
// A route under a computed prefix stays a registration with pattern null.
// Two applications never share a registration: a router included in both
// yields one registration per application.
//
// Every kind of work is capped for the whole build, never per application
// or per file, so a repository of a thousand small applications costs no
// more than one large one: MAX_REGISTRATIONS registrations, MAX_MOUNTS
// include expansions, MAX_MIDDLEWARE_EDGES dependency edges,
// MAX_TEST_REQUESTS test requests, MAX_MATCH_WORK pattern-matching steps
// and MAX_LOOKUPS name lookups; and each list the plugin returns stays
// under its own cap (MAX_APPS, MAX_EDGES, MAX_ROLES, MAX_UNKNOWNS). Each
// cap, once reached, stops that work for the rest of the build and says so
// with one unknown. A registration keeps
// MAX_MIDDLEWARE_CHAIN dependencies, and includes are followed
// MAX_INCLUDE_DEPTH levels deep. Patterns are matched segment by segment,
// never through a regular expression.
import type { Cause, Tier } from "../../model/records.js";
import { weakest } from "../../model/records.js";
import type { DefFact, GraphNode } from "../../types.js";
import type { Detection, FrameworkEdge, FrameworkEvidence, FrameworkUnknown, HandlerStatus, Lookup, PluginIndex, PluginOutput, Registration, RoleAssignment, Site } from "../plugin.js";
import { appId, entityId } from "../plugin.js";
import type { FastApiFact, ParamDep } from "./facts.js";
import { MAX_SOURCE_BYTES, ROUTE_METHODS } from "./facts.js";
import type { Expr } from "./py.js";
import { evaluate, show } from "./py.js";

export const PLUGIN = "fastapi";
export const RULE_VERSION = 1;
const rule = (id: string) => ({ id, version: RULE_VERSION });

// Caps on the work of one build, every application and file together.
export const MAX_REGISTRATIONS = 10_000; // registrations created
export const MAX_MOUNTS = 2000; // include_router expansions followed
export const MAX_MIDDLEWARE_EDGES = 40_000; // dependency edges created
export const MAX_TEST_REQUESTS = 2000; // test client requests matched
export const MAX_MATCH_WORK = 4_000_000; // pattern-matching steps
export const MAX_LOOKUPS = 200_000; // name lookups through the index
// Caps on each list the plugin returns. The stage appends a plugin's
// output with one spread call, which overflows the stack past about
// 100,000 items, so every list stays well under that.
export const MAX_APPS = 2000; // applications detected
export const MAX_EDGES = 60_000; // edges of every kind
export const MAX_ROLES = 20_000; // roles assigned
export const MAX_UNKNOWNS = 5000; // unknowns at a site, before one summary
// Caps on one item's output.
export const MAX_MIDDLEWARE_CHAIN = 64; // dependencies kept per registration
export const MAX_INCLUDE_DEPTH = 8; // routers deep under an application
export const MAX_MODEL_DEPTH = 8; // base classes followed to find a Pydantic model
export const MAX_PATTERN_SEGMENTS = 64; // segments of a pattern or a request path matched
export const MAX_SEGMENT_CHARS = 256; // characters of one segment matched against a template

type Fact<K extends FastApiFact["kind"]> = Extract<FastApiFact, { kind: K }>;
type Call = Extract<Expr, { t: "call" }>;

// The qualified names that are FastAPI's, Starlette's and Pydantic's own.
const APP_NAMES = new Set(["fastapi.FastAPI", "fastapi.applications.FastAPI"]);
const ROUTER_NAMES = new Set(["fastapi.APIRouter", "fastapi.routing.APIRouter"]);
const DEPENDS_NAMES = new Set(["fastapi.Depends", "fastapi.Security", "fastapi.params.Depends", "fastapi.params.Security", "fastapi.param_functions.Depends", "fastapi.param_functions.Security"]);
const CLIENT_NAMES = new Set(["fastapi.testclient.TestClient", "starlette.testclient.TestClient"]);
const MODEL_NAMES = new Set(["pydantic.BaseModel", "pydantic.main.BaseModel"]);
// The top-level packages whose names the plugin reads. fastapi must
// resolve as a declared dependency; the others come with it.
const WATCHED_TOPS = new Set(["fastapi", "starlette", "pydantic", "pytest"]);

const METHODS = new Set<string>(ROUTE_METHODS);
const REQUEST_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head"]);

// A value the plugin knows: an application, a router, or a test client.
type Val = { kind: "app" | "router"; id: string; file: string; name: string; line: number; column: number; scope: number; call: Call } | { kind: "client"; file: string; target: Expr | null; scope: number; line: number };
type Known = Extract<Val, { kind: "app" | "router" }>;

export type Analysis = { apps: Detection[]; output: PluginOutput };

const memo = new WeakMap<object, Analysis>();

export function analyse(index: PluginIndex<FastApiFact>): Analysis {
  const kept = memo.get(index);
  if (kept) return kept;
  const result = run(index);
  memo.set(index, result);
  return result;
}

const kwOf = (c: { kw: { key: string; value: Expr }[] }, key: string): Expr | undefined => c.kw.find((k) => k.key === key)?.value;
const DEP_NOTE = "a FastAPI dependency: it runs before the handler on every request to this route";

function run(index: PluginIndex<FastApiFact>): Analysis {
  const roles: RoleAssignment[] = [];
  const edges: FrameworkEdge[] = [];
  const unknowns: FrameworkUnknown[] = [];
  const registrations: Registration[] = [];
  const apps: Detection[] = [];

  const gapSeen = new Set<string>();
  const gapsLeft: { count: number; first: Site | null } = { count: 0, first: null };
  // An unknown, once per site, cause, scope and name; past MAX_UNKNOWNS only
  // counted, unless `always` (the summaries of the caps).
  const gap = (u: FrameworkUnknown, always = false) => {
    const k = `${u.site ? `${u.site.file}:${u.site.line}:${u.site.column}` : "-"}\0${u.cause}\0${JSON.stringify(u.scope)}\0${u.name ?? ""}`;
    if (gapSeen.has(k)) return;
    gapSeen.add(k);
    if (!always && unknowns.length >= MAX_UNKNOWNS) {
      gapsLeft.count++;
      gapsLeft.first ??= u.site;
      return;
    }
    unknowns.push(u);
  };
  const siteGap = (site: Site, cause: Cause, affects: FrameworkUnknown["affects"], name: string | null, note: string) => gap({ plugin: PLUGIN, site, scope: { file: site.file }, affects, cause, name, note, count: null, exact: false });

  const project = (file: string) => index.projectOf(file);
  const declaredMemo = new Map<string, boolean>();
  const declares = (file: string, name: string): boolean => {
    const k = `${project(file)}\0${name}`;
    let on = declaredMemo.get(k);
    if (on === undefined) {
      on = index.declares(project(file), "python", name);
      declaredMemo.set(k, on);
    }
    return on;
  };
  const isEnabled = (file: string) => declares(file, "fastapi");

  // ---------- the build's budgets ----------
  // Each counts the work done across the whole run; `first` is where the
  // cap was first reached, `left` what was left out after it.
  type Cap = { used: number; max: number; first: Site | null; left: number; exact: boolean };
  const cap = (max: number): Cap => ({ used: 0, max, first: null, left: 0, exact: true });
  const caps = {
    regs: cap(MAX_REGISTRATIONS),
    mounts: cap(MAX_MOUNTS),
    depEdges: cap(MAX_MIDDLEWARE_EDGES),
    requests: cap(MAX_TEST_REQUESTS),
    lookups: cap(MAX_LOOKUPS),
    apps: cap(MAX_APPS),
    edges: cap(MAX_EDGES),
    roles: cap(MAX_ROLES),
  };
  // Spends one unit of a cap; false (and counted as left out) once it is reached.
  const spend = (c: Cap, site: Site | null, n = 1): boolean => {
    if (c.used + n <= c.max) {
      c.used += n;
      return true;
    }
    c.first ??= site;
    c.left += n;
    return false;
  };
  // Every edge goes out through here, under MAX_EDGES.
  const emit = (e: FrameworkEdge): boolean => {
    if (!spend(caps.edges, e.evidence.site)) return false;
    edges.push(e);
    return true;
  };
  const matchWork = { left: MAX_MATCH_WORK };
  let matchStopped: Site | null = null;
  const tooDeep: { count: number; first: Site | null } = { count: 0, first: null };

  // ---------- facts by file, values by name ----------
  type FileFacts = { values: Map<string, Fact<"value">[]>; routes: Fact<"route">[]; calls: Fact<"call">[]; tooLarge: Fact<"too-large"> | null; broken: Fact<"syntax-error"> | null };
  const byFile = new Map<string, FileFacts>();
  const factsIn = (file: string): FileFacts => {
    let f = byFile.get(file);
    if (f) return f;
    f = { values: new Map(), routes: [], calls: [], tooLarge: null, broken: null };
    byFile.set(file, f);
    for (const x of index.factsOf(file)) {
      switch (x.kind) {
        case "value": {
          const list = f.values.get(x.name);
          if (list) list.push(x);
          else f.values.set(x.name, [x]);
          break;
        }
        case "route":
          f.routes.push(x);
          break;
        case "call":
          f.calls.push(x);
          break;
        case "too-large":
          f.tooLarge = x;
          break;
        case "syntax-error":
          f.broken = x;
          break;
      }
    }
    return f;
  };

  // ---------- lookups ----------
  const lookups = new Map<string, Lookup>();
  const lookup = (file: string, path: readonly string[]): Lookup => {
    const k = `${file}\0${path.join(".")}`;
    let l = lookups.get(k);
    if (l) return l;
    if (!spend(caps.lookups, { file, line: 1, column: 1 })) return { kind: "none" };
    l = index.lookup(file, path);
    lookups.set(k, l);
    return l;
  };

  // ---------- what each local name stands for, from the file's imports ----------
  // A local name to the qualified name it is bound to: `FastAPI` after
  // `from fastapi import FastAPI` is "fastapi.FastAPI"; `fastapi` after
  // `import fastapi` is "fastapi". Only names of the watched packages, and
  // only when the module resolves outside the repository.
  const namesMemo = new Map<string, Map<string, string>>();
  const outside = (file: string, spec: string): boolean => {
    const top = spec.split(".")[0] as string;
    const m = index.module(file, spec);
    if (m.kind === "external") return true;
    // Starlette, Pydantic and pytest come with FastAPI and are often not
    // declared themselves: outside the repository is enough for them.
    return top !== "fastapi" && m.kind === "gap" && m.cause === "miss";
  };
  const names = (file: string): Map<string, string> => {
    let n = namesMemo.get(file);
    if (n) return n;
    n = new Map();
    namesMemo.set(file, n);
    const lf = index.languageFacts(file);
    if (!lf) return n;
    for (const imp of lf.imports) {
      if (imp.scoped || imp.star) continue;
      const top = imp.spec.split(".")[0] as string;
      if (!WATCHED_TOPS.has(top) || !outside(file, imp.spec)) continue;
      if (imp.namespace) n.set(imp.namespace, imp.alias ? imp.spec : top);
      for (const x of imp.names) n.set(x.local, `${imp.spec}.${x.imported}`);
    }
    return n;
  };
  const qualified = (file: string, path: readonly string[]): string | null => {
    const head = names(file).get(path[0] as string);
    return head === undefined ? null : [head, ...path.slice(1)].join(".");
  };
  const isApi = (file: string, e: Expr, set: ReadonlySet<string>): boolean => e.t === "ref" && set.has(qualified(file, e.path) ?? "");

  // ---------- values ----------
  const routerKey = (file: string, line: number) => `fw:${PLUGIN}:router:${file}:${line}`;
  const classify = (file: string, v: { name: string; value: Expr; scope: number; line: number; column: number }): Val | null => {
    const e = v.value;
    if (e.t !== "call" || e.fn.t !== "ref") return null;
    const q = qualified(file, e.fn.path);
    if (q === null) return null;
    if (APP_NAMES.has(q)) return { kind: "app", id: appId(PLUGIN, file, v.line), file, name: v.name, line: v.line, column: v.column, scope: v.scope, call: e };
    if (ROUTER_NAMES.has(q)) return { kind: "router", id: routerKey(file, v.line), file, name: v.name, line: v.line, column: v.column, scope: v.scope, call: e };
    if (CLIENT_NAMES.has(q)) return { kind: "client", file, target: e.args[0] ?? kwOf(e, "app") ?? null, scope: v.scope, line: v.line };
    return null;
  };

  // The value a name holds at a line of a file: an assignment in the same
  // function first, then one at module level, then what an import brings
  // (a module-level value of another file shows as a miss there, read
  // through that file's own facts). At most MAX_INCLUDE_DEPTH steps, so an
  // alias chain cannot loop.
  const valueIn = (file: string, path: readonly string[], scope: number, line: number, depth = 0): Val | null => {
    if (depth > MAX_INCLUDE_DEPTH || path.length === 0) return null;
    const name = path[0] as string;
    if (path.length === 1) {
      let local: Fact<"value"> | null = null;
      let top: Fact<"value"> | null = null;
      for (const d of factsIn(file).values.get(name) ?? []) {
        if (scope !== 0 && d.scope === scope && d.line <= line && (!local || d.line > local.line)) local = d;
        if (d.scope === 0) {
          // The latest assignment before the line, else the first after it.
          const better = !top || (d.line <= line ? top.line > line || d.line > top.line : top.line > line && d.line < top.line);
          if (better) top = d;
        }
      }
      const decl = local ?? top;
      if (decl) {
        const direct = classify(file, decl);
        if (direct) return direct;
        // `app = other` passes a known value on.
        if (decl.value.t === "ref" && !(decl.value.path.length === 1 && decl.value.path[0] === name)) return valueIn(file, decl.value.path, decl.scope, decl.line, depth + 1);
        return null;
      }
    }
    return fromImport(file, path, depth);
  };

  const fromImport = (file: string, path: readonly string[], depth: number): Val | null => {
    let found: Lookup = lookup(file, path);
    let target: { file: string; name: string } | null = null;
    if (found.kind === "miss") target = { file: found.target, name: found.name };
    else if (found.kind === "none" && path.length === 2) {
      found = lookup(file, [path[0] as string]);
      if (found.kind === "module") target = { file: found.file, name: path[1] as string };
    }
    if (!target || target.file === file || !index.languageFacts(target.file)) return null;
    return valueIn(target.file, [target.name], 0, Number.MAX_SAFE_INTEGER, depth + 1);
  };

  // A module-level string constant of the file: a name every module-level
  // assignment gives the same literal string.
  const constant = (file: string) => (path: string[]): string | null => {
    if (path.length !== 1) return null;
    let v: string | null = null;
    for (const d of factsIn(file).values.get(path[0] as string) ?? []) {
      if (d.scope !== 0) continue;
      if (d.value.t !== "str" || (v !== null && v !== d.value.v)) return null;
      v = d.value.v;
    }
    return v;
  };

  // ---------- handlers ----------
  const symbolsMemo = new Map<string, Map<string, GraphNode>>();
  const symbolAt = (file: string, name: string, line: number): GraphNode | null => {
    let m = symbolsMemo.get(file);
    if (!m) {
      m = new Map();
      for (const s of index.symbols(file)) m.set(`${s.name}@${s.startLine}`, s);
      symbolsMemo.set(file, m);
    }
    return m.get(`${name}@${line}`) ?? null;
  };

  type Bound = { status: HandlerStatus; targets: string[]; tier: Tier; via: FrameworkEvidence["via"]; note: string | null; why: { cause: Cause; note: string; name: string | null } | null };
  const none = (status: HandlerStatus, cause: Cause, note: string, name: string | null): Bound => ({ status, targets: [], tier: "certain", via: null, note: null, why: { cause, note, name } });
  // What a name passed as an endpoint or a dependency is bound to.
  const bindRef = (file: string, e: Expr, role: "handler" | "dependency"): Bound => {
    if (e.t === "call") return none("unresolved", "unsupported-rule", `the ${role} is the value ${show(e)} returns, which is not followed`, show(e));
    if (e.t !== "ref") return none("dynamic", "dynamic", `the ${role} is computed (${show(e)})`, null);
    const found = lookup(file, e.path);
    switch (found.kind) {
      case "symbol":
        return { status: "bound", targets: found.ids, tier: found.tier, via: found.via, note: found.tier === "certain" ? null : (found.note ?? `the ${role}'s binding is ${found.tier}`), why: null };
      case "miss":
        return none("missing", "miss", `the ${role} ${show(e)} names ${found.name} in ${found.target}, where no such definition exists now`, show(e));
      case "external":
        return none("external", "external", `${show(e)} comes from a declared dependency`, show(e));
      case "gap":
        return none(found.cause === "ambiguous" ? "ambiguous" : "unresolved", found.cause, found.note, show(e));
      default:
        return none("dynamic", "dynamic", `${show(e)} is not a definition at the top level of the file`, show(e));
    }
  };

  const roleSeen = new Set<string>();
  const addRole = (target: string, role: RoleAssignment["role"], detail: string, app: string | null, evidence: FrameworkEvidence) => {
    const k = `${target}\0${role}`;
    if (roleSeen.has(k)) return;
    roleSeen.add(k);
    if (spend(caps.roles, evidence.site)) roles.push({ target, role, detail, app, evidence });
  };

  // ---------- routes and includes on each application and router ----------
  type RouteEvent = {
    file: string;
    site: Site;
    methods: string[] | null; // null: computed
    written: string; // the path, literal
    name: string | null;
    handler: { kind: "def"; fn: string; def: number } | { kind: "ref"; expr: Expr };
    deps: Expr | undefined; // the `dependencies=` list
    params: ParamDep[];
    paramsOmitted: number;
  };
  type IncludeEvent = { file: string; site: Site; router: Expr | undefined; prefix: Expr | undefined; deps: Expr | undefined; scope: number };
  const routesOf = new Map<string, RouteEvent[]>();
  const includesOf = new Map<string, IncludeEvent[]>();
  const vals = new Map<string, Known>();
  const requests: { file: string; site: Site; method: string; path: Expr | undefined; client: Extract<Val, { kind: "client" }> }[] = [];
  const push = <T>(m: Map<string, T[]>, k: string, v: T) => {
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
  };

  const methodsOf = (file: string, e: Expr | undefined, fallback: string[]): string[] | null => {
    if (e === undefined) return fallback;
    if (e.t !== "list" || e.omitted > 0) return null;
    const out: string[] = [];
    for (const item of e.items) {
      const v = evaluate(item, constant(file));
      if (v === null) return null;
      out.push(v.toUpperCase());
    }
    return out;
  };
  const literalName = (e: Expr | undefined): string | null => (e && e.t === "str" ? e.v : null);

  // A route whose own path is computed is no registration: an unknown
  // naming the handler, at the decorator or call site.
  const addRoute = (base: Known, e: Omit<RouteEvent, "written">, path: Expr | undefined | null) => {
    const written = path ? evaluate(path, constant(e.file)) : null;
    const handler = e.handler.kind === "def" ? e.handler.fn : show(e.handler.expr);
    if (written === null) {
      siteGap(e.site, "dynamic", ["handles"], handler, `the route path ${path ? show(path) : "(none)"} of ${handler} is computed at run time, so the route is not listed`);
      return;
    }
    vals.set(base.id, base);
    push(routesOf, base.id, { ...e, written });
  };

  const files = index.factFiles().filter(isEnabled);
  for (const file of files) {
    const f = factsIn(file);
    if (f.tooLarge) {
      gap({ plugin: PLUGIN, site: { file, line: 1, column: 1 }, scope: { file }, affects: ["handles", "mounts", "applies_middleware", "tests"], cause: "file-not-parsed", name: null, note: `the file is ${f.tooLarge.bytes} bytes, over the ${MAX_SOURCE_BYTES}-byte cap of the FastAPI plugin, so its routes, dependencies and test requests were not read`, count: null, exact: false });
      continue;
    }
    if (f.broken) siteGap({ file, line: f.broken.line, column: f.broken.column }, "file-not-parsed", ["handles", "mounts", "applies_middleware", "tests"], null, "the file has a syntax error here; decorators and calls inside broken regions were not read");
    for (const list of f.values.values()) {
      for (const v of list) {
        const c = classify(file, v);
        if (c && c.kind !== "client") vals.set(c.id, c);
      }
    }
  }

  for (const file of files) {
    const f = factsIn(file);
    if (f.tooLarge) continue;
    for (const r of f.routes) {
      const base = valueIn(file, r.recv, r.scope, r.line);
      if (!base || base.kind === "client") continue;
      const site: Site = { file, line: r.line, column: r.column };
      const ws = r.method === "websocket";
      const methods = ws ? ["GET"] : r.method === "api_route" ? methodsOf(file, kwOf(r, "methods"), ["GET"]) : METHODS.has(r.method) ? [r.method.toUpperCase()] : null;
      const name = literalName(kwOf(r, "name")) ?? (ws ? "websocket" : null);
      addRoute(base, { file, site, methods, name, handler: { kind: "def", fn: r.fn, def: r.def }, deps: kwOf(r, "dependencies"), params: r.params, paramsOmitted: r.omitted }, r.args[0] ?? kwOf(r, "path"));
    }
    for (const c of f.calls) {
      const site: Site = { file, line: c.line, column: c.column };
      const base = c.recv.t === "ref" ? valueIn(file, c.recv.path, c.scope, c.line) : c.recv.t === "call" ? classify(file, { name: "", value: c.recv, scope: c.scope, line: c.line, column: c.column }) : null;
      if (!base) continue;
      if (base.kind === "client") {
        if (REQUEST_METHODS.has(c.prop)) requests.push({ file, site, method: c.prop.toUpperCase(), path: c.args[0] ?? kwOf(c, "url"), client: base });
        else if (c.prop === "request") {
          const m = literalName(c.args[0] ?? kwOf(c, "method"));
          if (m !== null) requests.push({ file, site, method: m.toUpperCase(), path: c.args[1] ?? kwOf(c, "url"), client: base });
        }
        continue;
      }
      if (c.prop === "include_router") {
        vals.set(base.id, base);
        push(includesOf, base.id, { file, site, router: c.args[0] ?? kwOf(c, "router"), prefix: kwOf(c, "prefix"), deps: kwOf(c, "dependencies"), scope: c.scope });
      } else if (c.prop === "add_api_route" || c.prop === "add_api_websocket_route") {
        const ws = c.prop === "add_api_websocket_route";
        const endpoint = c.args[1] ?? kwOf(c, "endpoint");
        if (!endpoint) continue;
        const methods = ws ? ["GET"] : methodsOf(file, kwOf(c, "methods"), ["GET"]);
        const name = literalName(kwOf(c, "name")) ?? (ws ? "websocket" : null);
        addRoute(base, { file, site, methods, name, handler: { kind: "ref", expr: endpoint }, deps: kwOf(c, "dependencies"), params: [], paramsOmitted: 0 }, c.args[0] ?? kwOf(c, "path"));
      }
    }
  }
  const bySite = (a: { file: string; site: Site }, b: { file: string; site: Site }) => (a.file === b.file ? a.site.line - b.site.line || a.site.column - b.site.column : a.file < b.file ? -1 : 1);
  for (const list of routesOf.values()) list.sort(bySite);
  for (const list of includesOf.values()) list.sort(bySite);

  // ---------- dependencies ----------
  // One dependency in a chain: the call that declares it and where.
  type Dep = { call: Expr; file: string; type: Expr | null };
  const depsOfList = (file: string, list: Expr | undefined): { deps: Dep[]; omitted: number } => {
    if (!list) return { deps: [], omitted: 0 };
    if (list.t !== "list") {
      siteGap({ file, line: list.line, column: list.column }, "dynamic", ["applies_middleware"], show(list), `the dependencies ${show(list)} are computed at run time`);
      return { deps: [], omitted: 0 };
    }
    return { deps: list.items.map((call) => ({ call, file, type: null })), omitted: list.omitted };
  };
  // What one dependency call is bound to, read once per call however many
  // registrations share it: null when the call is not FastAPI's Depends
  // or Security, else its targets with the evidence each edge shares.
  type DepBinding = { targets: { id: string; ev: FrameworkEvidence }[] } | null;
  const depMemo = new WeakMap<Expr, DepBinding>();
  const bindDep = (d: Dep): DepBinding => {
    if (depMemo.has(d.call)) return depMemo.get(d.call) ?? null;
    let out: DepBinding = null;
    if (d.call.t === "call" && isApi(d.file, d.call.fn, DEPENDS_NAMES)) {
      out = { targets: [] };
      const site: Site = { file: d.file, line: d.call.line, column: d.call.column };
      const target = d.call.args[0] ?? kwOf(d.call, "dependency") ?? d.type;
      if (!target) siteGap(site, "unsupported-rule", ["applies_middleware"], null, `${show(d.call)} names no dependency and its parameter has no annotation the plugin can read`);
      else {
        const b = bindRef(d.file, target, "dependency");
        if (b.why && b.status !== "external") siteGap(site, b.why.cause, ["applies_middleware"], b.why.name, b.why.note);
        const ev: FrameworkEvidence = { kind: "route-call", tier: b.tier, site, via: b.via, premises: [], rule: rule("fastapi-dependency"), note: b.note ? `${DEP_NOTE}; ${b.note}` : DEP_NOTE };
        out.targets = b.targets.map((id) => ({ id, ev }));
      }
    }
    depMemo.set(d.call, out);
    return out;
  };

  // The chain of one registration, in the order FastAPI runs it: the
  // application's, the includes' and the routers' own, the decorator's,
  // then the parameters'. Entries past MAX_MIDDLEWARE_CHAIN are counted
  // and left out.
  const applyDeps = (reg: Registration, chain: Dep[], omitted: number, app: string | null) => {
    let left = omitted;
    let order = 0;
    for (const d of chain) {
      // A parameter default that is not a dependency (`Query(None)`) is no
      // part of the chain.
      const b = bindDep(d);
      if (!b) continue;
      if (order >= MAX_MIDDLEWARE_CHAIN) {
        left++;
        continue;
      }
      order++;
      for (const t of b.targets) {
        if (!spend(caps.depEdges, t.ev.site) || !emit({ from: reg.id, to: t.id, kind: "applies_middleware", plugin: PLUGIN, app, evidence: t.ev, order: order - 1 })) break;
        addRole(t.id, "middleware", "fastapi-dependency", app, t.ev);
      }
    }
    if (left > 0) gap({ plugin: PLUGIN, site: reg.site, scope: { file: reg.site.file }, affects: ["applies_middleware"], cause: "fan-out-capped", name: null, note: `the route's dependency chain is longer than the ${MAX_MIDDLEWARE_CHAIN} dependencies the plugin keeps (or a dependency list was longer than it reads); ${left} were left out`, count: left, exact: true });
  };

  // ---------- composition: every route each application serves ----------
  const prefixOf = (file: string, e: Expr | undefined, site: Site, what: string): string | null => {
    if (e === undefined) return "";
    const v = evaluate(e, constant(file));
    if (v === null) siteGap(site, "dynamic", ["mounts", "handles"], show(e), `the ${what} prefix ${show(e)} is computed at run time, so the routes under it have no known pattern`);
    return v;
  };

  const reached = new Set<string>();
  const compose = (val: Known, app: string | null, prefix: string | null, inherited: Dep[], inheritedOmitted: number, via: Site[], stack: string[], depth: number) => {
    reached.add(val.id);
    // The router's own prefix and dependencies, or the application's dependencies.
    const own = val.kind === "router" ? prefixOf(val.file, kwOf(val.call, "prefix"), { file: val.file, line: val.line, column: val.column }, "router") : "";
    const base = prefix === null || own === null ? null : prefix + own;
    const ownDeps = depsOfList(val.file, kwOf(val.call, "dependencies"));
    const deps = [...inherited, ...ownDeps.deps];
    const omitted = inheritedOmitted + ownDeps.omitted;

    const routes = routesOf.get(val.id) ?? [];
    for (let i = 0; i < routes.length; i++) {
      const e = routes[i] as RouteEvent;
      if (!spend(caps.regs, e.site)) {
        // Past the build's cap: count what this router still holds and stop.
        caps.regs.left += routes.length - i - 1;
        break;
      }
      const pattern = base === null ? null : base + e.written;
      const key = `${e.file}:${e.site.line}:${e.site.column}${via.map((s) => `@${s.file}:${s.line}:${s.column}`).join("")}`;
      const id = entityId(PLUGIN, app, "registration", key);
      let bound: Bound;
      let handlerWritten: string;
      if (e.handler.kind === "def") {
        handlerWritten = e.handler.fn;
        const sym = symbolAt(e.file, e.handler.fn, e.handler.def);
        bound = sym ? { status: "bound", targets: [sym.id], tier: "certain", via: null, note: null, why: null } : none("unresolved", "unsupported-rule", `the decorated function ${e.handler.fn} has no definition of its own in the graph`, e.handler.fn);
      } else {
        handlerWritten = show(e.handler.expr);
        bound = bindRef(e.file, e.handler.expr, "handler");
      }
      const reg: Registration = {
        kind: "registration",
        id,
        plugin: PLUGIN,
        app,
        methods: e.methods ?? ["*"],
        pattern,
        written: e.written,
        name: e.name,
        site: e.site,
        mountedVia: via,
        mounted: app !== null,
        handler: { written: handlerWritten, status: bound.status, targets: bound.targets },
      };
      registrations.push(reg);
      if (e.methods === null) siteGap(e.site, "dynamic", ["handles"], handlerWritten, "the route's methods are computed at run time, so it is listed as taking any method");
      if (bound.why) siteGap(e.site, bound.why.cause, ["handles"], bound.why.name, bound.why.note);
      for (const t of bound.targets) {
        const ev: FrameworkEvidence = { kind: e.handler.kind === "def" ? "route-decorator" : "route-call", tier: bound.tier, site: e.site, via: bound.via, premises: [], rule: rule("fastapi-route"), note: bound.note };
        if (emit({ from: id, to: t, kind: "handles", plugin: PLUGIN, app, evidence: ev })) addRole(t, "route_handler", "fastapi", app, ev);
      }
      const decorator = depsOfList(e.file, e.deps);
      applyDeps(reg, [...deps, ...decorator.deps, ...e.params.map((p) => ({ call: p.call, file: e.file, type: p.type }))], omitted + decorator.omitted + e.paramsOmitted, app);
    }

    for (const e of includesOf.get(val.id) ?? []) {
      const target = e.router?.t === "ref" ? valueIn(e.file, e.router.path, e.scope, e.site.line) : null;
      if (!target || target.kind !== "router") {
        siteGap(e.site, e.router?.t === "ref" ? "unsupported-rule" : "dynamic", ["mounts", "handles"], e.router ? show(e.router) : null, `the router included here (${e.router ? show(e.router) : "nothing"}) is not an APIRouter value the plugin can follow, so its routes are not listed`);
        continue;
      }
      if (stack.includes(target.id)) continue; // a loop: stop where it closes
      if (depth >= MAX_INCLUDE_DEPTH) {
        tooDeep.count++;
        tooDeep.first ??= e.site;
        continue;
      }
      if (!spend(caps.mounts, e.site)) {
        caps.mounts.exact = false; // what the skipped routers hold is not counted
        continue;
      }
      const inc = prefixOf(e.file, e.prefix, e.site, "include");
      emit({ from: val.id, to: target.id, kind: "mounts", plugin: PLUGIN, app, evidence: { kind: "mount", tier: "certain", site: e.site, via: null, premises: [], rule: rule("fastapi-include"), note: null } });
      const incDeps = depsOfList(e.file, e.deps);
      compose(target, app, base === null || inc === null ? null : base + inc, [...deps, ...incDeps.deps], omitted + incDeps.omitted, [...via, e.site], [...stack, target.id], depth + 1);
    }
  };

  const sortedVals = [...vals.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const v of sortedVals) {
    if (v.kind !== "app" || !spend(caps.apps, { file: v.file, line: v.line, column: v.column })) continue;
    compose(v, v.id, "", [], 0, [], [v.id], 0);
    apps.push({
      id: v.id,
      name: `${v.name} (${v.file})`,
      project: project(v.file),
      root: project(v.file),
      site: { file: v.file, line: v.line, column: v.column },
      evidence: [{ file: v.file, line: v.line, note: "made by calling FastAPI from the fastapi package" }],
      version: null,
    });
  }

  // Routers no application reaches: their routes are kept, relative and
  // not served. Roots first (routers no router includes), then any router
  // left over (an include loop with no way in), each walked once.
  const includedBy = new Set<string>();
  for (const [id, list] of includesOf) {
    for (const e of list) {
      if (e.router?.t !== "ref") continue;
      const t = valueIn(e.file, e.router.path, e.scope, e.site.line);
      if (t && t.kind === "router" && t.id !== id) includedBy.add(t.id);
    }
  }
  const appReached = new Set(reached);
  for (const v of sortedVals) if (v.kind === "router" && !appReached.has(v.id) && !includedBy.has(v.id)) compose(v, null, "", [], 0, [], [v.id], 0);
  for (const v of sortedVals) if (v.kind === "router" && !reached.has(v.id)) compose(v, null, "", [], 0, [], [v.id], 0);

  // ---------- test requests ----------
  type Candidate = { reg: Registration; segs: Seg[] };
  const byApp = new Map<string, { buckets: Map<string, Candidate[]>; wild: Candidate[] }>();
  for (const reg of registrations) {
    if (reg.app === null || reg.pattern === null) continue;
    const segs = parsePattern(reg.pattern);
    if (!segs) continue;
    let a = byApp.get(reg.app);
    if (!a) {
      a = { buckets: new Map(), wild: [] };
      byApp.set(reg.app, a);
    }
    const first = segs[1];
    if (first && first.kind === "lit") push(a.buckets, first.text, { reg, segs });
    else a.wild.push({ reg, segs });
  }
  for (const r of requests) {
    if (r.client.target?.t !== "ref") continue;
    const app = valueIn(r.client.file, r.client.target.path, r.client.scope, r.client.line);
    if (!app || app.kind !== "app") continue;
    const raw = r.path ? evaluate(r.path, constant(r.file)) : null;
    if (raw === null) {
      siteGap(r.site, "dynamic", ["tests"], r.path ? show(r.path) : null, `the test requests a computed path (${r.path ? show(r.path) : "none"}), so the route it reaches is not known`);
      continue;
    }
    if (matchStopped || !spend(caps.requests, r.site)) continue;
    const path = requestPath(raw);
    const asked = path.split("/");
    const a = byApp.get(app.id);
    if (!a || asked.length > MAX_PATTERN_SEGMENTS + 1) continue;
    const from = index.enclosing(r.file, r.site.line)?.id ?? r.file;
    const toggled = toggleSlash(path).split("/");
    for (const { reg, segs } of [...(a.buckets.get(asked[1] ?? "") ?? []), ...a.wild]) {
      if (!reg.methods.includes("*") && !reg.methods.includes(r.method)) continue;
      if (!matchSegs(segs, asked, matchWork) && !matchSegs(segs, toggled, matchWork)) {
        if (matchWork.left <= 0) break;
        continue;
      }
      if (!emit({ from, to: reg.id, kind: "tests", plugin: PLUGIN, app: app.id, category: "route-request", evidence: { kind: "test-route-request", tier: "likely", site: r.site, via: null, premises: [reg.id], rule: rule("fastapi-test-request"), note: `the test client requests ${r.method} ${path} from ${app.name}, which this route's pattern ${reg.pattern} matches` } })) break;
    }
    if (matchWork.left <= 0) matchStopped = r.site;
  }

  // ---------- Pydantic models and pytest tests, from the language facts ----------
  type ModelProof = { tier: Tier; via: FrameworkEvidence["via"]; note: string | null };
  // The class definitions of a file by name and line, built once per file.
  const classesMemo = new Map<string, Map<string, DefFact>>();
  const classAt = (file: string, name: string, line: number): DefFact | null => {
    let m = classesMemo.get(file);
    if (!m) {
      m = new Map();
      for (const d of index.languageFacts(file)?.defs ?? []) if (d.kind === "class") m.set(`${d.name}@${d.line}`, d);
      classesMemo.set(file, m);
    }
    return m.get(`${name}@${line}`) ?? null;
  };
  // Whether a class reaches BaseModel within `steps` bases (BaseModel
  // itself is one step). Memoised per class and step count, so the answer
  // never depends on the order the classes are read in, and the recursion
  // is at most MAX_MODEL_DEPTH deep.
  const modelMemo = new Map<string, ModelProof | null>();
  const isModel = (file: string, def: DefFact, steps: number): ModelProof | null => {
    const k = `${file}\0${def.name}\0${def.line}\0${steps}`;
    if (modelMemo.has(k)) return modelMemo.get(k) ?? null;
    modelMemo.set(k, null); // a base cycle reads as no model
    let found: ModelProof | null = null;
    for (const base of def.bases) {
      const path = base.qualifier ? [...base.qualifier.split("."), base.name] : [base.name];
      if (MODEL_NAMES.has(qualified(file, path) ?? "")) {
        found = { tier: "certain", via: null, note: null };
        break;
      }
      if (steps <= 1) continue;
      const l = lookup(file, path);
      if (l.kind !== "symbol") continue;
      for (const id of l.ids) {
        const node = index.node(id);
        if (!node || node.kind !== "class") continue;
        const parent = classAt(node.file, node.name, node.startLine);
        const inner = parent ? isModel(node.file, parent, steps - 1) : null;
        if (!inner) continue;
        const tier = weakest(l.tier, inner.tier);
        found = { tier, via: l.via, note: tier === "certain" ? null : (l.note ?? inner.note ?? `the base class ${path.join(".")} binds as ${tier}`) };
        break;
      }
      if (found) break;
    }
    modelMemo.set(k, found);
    return found;
  };

  for (const file of index.paths()) {
    if (!file.endsWith(".py")) continue;
    const lf = index.languageFacts(file);
    if (!lf) continue;
    if (declares(file, "pydantic") || declares(file, "fastapi")) {
      for (const def of lf.defs) {
        if (def.kind !== "class" || def.bases.length === 0) continue;
        const m = isModel(file, def, MAX_MODEL_DEPTH);
        const sym = m ? symbolAt(file, def.name, def.line) : null;
        if (!m || !sym) continue;
        addRole(sym.id, "model", "pydantic", null, { kind: "role-base", tier: m.tier, site: { file, line: def.line, column: def.column }, via: m.via, premises: [], rule: rule("fastapi-pydantic-model"), note: m.note });
      }
    }
    if (!isEnabled(file) || !isTestFile(file)) continue;
    const runner = declares(file, "pytest") || lf.imports.some((i) => !i.scoped && (i.spec === "pytest" || i.spec.startsWith("pytest.") || ((i.spec === "fastapi.testclient" || i.spec === "starlette.testclient") && i.names.some((n) => n.imported === "TestClient"))));
    if (!runner) continue;
    const ev: FrameworkEvidence = { kind: "role-path", tier: "certain", site: { file, line: 1, column: 1 }, via: null, premises: [], rule: rule("fastapi-pytest"), note: null };
    addRole(file, "test", "pytest", null, ev);
    for (const def of lf.defs) {
      if (!def.topLevel || !((def.kind === "function" && def.name.startsWith("test")) || (def.kind === "class" && def.name.startsWith("Test")))) continue;
      const sym = symbolAt(file, def.name, def.line);
      if (sym) addRole(sym.id, "test", "pytest", null, { ...ev, site: { file, line: def.line, column: def.column } });
    }
  }

  // ---------- one unknown per cap reached ----------
  const capGap = (c: Cap, affects: FrameworkUnknown["affects"], cause: Cause, what: string) => {
    if (c.left === 0 || !c.first) return;
    gap({ plugin: PLUGIN, site: c.first, scope: { project: project(c.first.file) }, affects, cause, name: null, note: `the plugin stops at ${c.max} ${what} in one build; ${c.left}${c.exact ? "" : " or more"} were left out from here on`, count: c.left, exact: c.exact }, true);
  };
  const all: FrameworkUnknown["affects"] = ["handles", "mounts", "applies_middleware", "tests"];
  if (caps.mounts.left > 0 || caps.apps.left > 0) caps.regs.exact = false;
  if (caps.lookups.left > 0) for (const c of Object.values(caps)) c.exact = false;
  capGap(caps.apps, all, "fan-out-capped", "applications");
  capGap(caps.regs, ["handles", "applies_middleware", "tests"], "fan-out-capped", "registrations");
  capGap(caps.mounts, ["mounts", "handles"], "fan-out-capped", "router includes");
  capGap(caps.depEdges, ["applies_middleware"], "fan-out-capped", "dependency edges");
  capGap(caps.requests, ["tests"], "fan-out-capped", "test client requests");
  capGap(caps.edges, all, "fan-out-capped", "edges");
  capGap(caps.roles, [], "fan-out-capped", "roles");
  capGap(caps.lookups, all, "budget", "name lookups");
  if (tooDeep.first) gap({ plugin: PLUGIN, site: tooDeep.first, scope: { project: project(tooDeep.first.file) }, affects: ["mounts", "handles"], cause: "fan-out-capped", name: null, note: `routers included more than ${MAX_INCLUDE_DEPTH} levels deep are not followed (${tooDeep.count} includes); their routes are not listed`, count: tooDeep.count, exact: true }, true);
  if (matchStopped) gap({ plugin: PLUGIN, site: matchStopped, scope: { project: project(matchStopped.file) }, affects: ["tests"], cause: "budget", name: null, note: `matching test requests to routes stopped after ${MAX_MATCH_WORK} steps; the requests from here on were not matched`, count: null, exact: false }, true);
  const lostAt = gapsLeft.first;
  if (gapsLeft.count > 0) gap({ plugin: PLUGIN, site: lostAt, scope: { project: lostAt ? project(lostAt.file) : "" }, affects: all, cause: "fan-out-capped", name: null, note: `the plugin keeps ${MAX_UNKNOWNS} unknowns in one build; ${gapsLeft.count} more were counted and left out`, count: gapsLeft.count, exact: true }, true);

  return { apps, output: { roles, entities: registrations, edges, unknowns } };
}

// Whether a path names a pytest test module: `test_*.py` or `*_test.py`.
export function isTestFile(path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.endsWith(".py") && (base.startsWith("test_") || base.endsWith("_test.py"));
}

// A request path as the route table sees it: no scheme and host, no query, no fragment.
function requestPath(raw: string): string {
  let p = raw;
  if (p.startsWith("http://") || p.startsWith("https://")) {
    const slash = p.indexOf("/", p.indexOf("//") + 2);
    p = slash < 0 ? "/" : p.slice(slash);
  }
  const q = p.indexOf("?");
  if (q >= 0) p = p.slice(0, q);
  const h = p.indexOf("#");
  if (h >= 0) p = p.slice(0, h);
  return p;
}

// The same path with its trailing slash added or taken away: Starlette
// redirects one to the other when only that differs, and the test client
// follows the redirect.
function toggleSlash(path: string): string {
  if (path === "/" || path === "") return path;
  return path.endsWith("/") ? path.slice(0, -1) : `${path}/`;
}

// ---------- the segment matcher ----------
// A pattern segment: a literal, a template of literal pieces and
// parameters (`{item_id}`, `{name}.txt`), or a path parameter that takes
// the rest of the path (`{file_path:path}`, with an optional literal
// before it in the same segment).
type Conv = "str" | "int" | "float" | "uuid";
type Piece = { lit: string } | { conv: Conv };
export type Seg = { kind: "lit"; text: string } | { kind: "tpl"; pieces: Piece[] } | { kind: "path"; prefix: string };

const isIdentStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isIdent = (c: number) => isIdentStart(c) || (c >= 48 && c <= 57);
const identifier = (s: string): boolean => {
  if (s.length === 0 || !isIdentStart(s.charCodeAt(0))) return false;
  for (let i = 1; i < s.length; i++) if (!isIdent(s.charCodeAt(i))) return false;
  return true;
};

// `name` or `name:conv`, as Starlette reads a parameter; null when not one.
function readParam(body: string): { conv: string } | null {
  const colon = body.indexOf(":");
  const name = colon < 0 ? body : body.slice(0, colon);
  const conv = colon < 0 ? "str" : body.slice(colon + 1);
  return identifier(name) && identifier(conv) ? { conv } : null;
}

// The segments of a pattern, or null when it has more than
// MAX_PATTERN_SEGMENTS segments, a segment longer than MAX_SEGMENT_CHARS,
// or a shape the matcher does not read (text after a path parameter in its
// segment, a parameter before one).
export function parsePattern(pattern: string): Seg[] | null {
  if (pattern.length > (MAX_PATTERN_SEGMENTS + 1) * (MAX_SEGMENT_CHARS + 1)) return null;
  const raw = pattern.split("/");
  if (raw.length > MAX_PATTERN_SEGMENTS + 1) return null;
  const out: Seg[] = [];
  for (const s of raw) {
    if (s.length > MAX_SEGMENT_CHARS) return null;
    if (!s.includes("{")) {
      out.push({ kind: "lit", text: s });
      continue;
    }
    const pieces: Piece[] = [];
    let lit = "";
    let pathParam = false;
    for (let i = 0; i < s.length; ) {
      if (pathParam) return null;
      if (s[i] === "{") {
        const close = s.indexOf("}", i + 1);
        const param = close < 0 ? null : readParam(s.slice(i + 1, close));
        if (param) {
          if (lit !== "") pieces.push({ lit });
          lit = "";
          if (param.conv === "path") pathParam = true;
          else pieces.push({ conv: param.conv === "int" || param.conv === "float" || param.conv === "uuid" ? param.conv : "str" });
          i = close + 1;
          continue;
        }
      }
      lit += s[i];
      i++;
    }
    if (pathParam) {
      if (pieces.some((p) => "conv" in p)) return null;
      out.push({ kind: "path", prefix: pieces.map((p) => ("lit" in p ? p.lit : "")).join("") });
      continue;
    }
    if (lit !== "") pieces.push({ lit });
    out.push({ kind: "tpl", pieces });
  }
  return out;
}

function inClass(conv: Conv, c: number): boolean {
  switch (conv) {
    case "int":
      return c >= 48 && c <= 57;
    case "float":
      return (c >= 48 && c <= 57) || c === 46;
    case "uuid":
      return (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70) || c === 45;
    default:
      return true; // a segment never holds a slash
  }
}

// One path segment against a template: a pass over the characters per
// piece, keeping the positions reachable after each piece.
function matchTemplate(pieces: Piece[], text: string, work: { left: number }): boolean {
  if (text.length > MAX_SEGMENT_CHARS) return false;
  let cur = new Uint8Array(text.length + 1);
  cur[0] = 1;
  for (const p of pieces) {
    work.left -= text.length + 1;
    if (work.left <= 0) return false;
    const next = new Uint8Array(text.length + 1);
    if ("lit" in p) {
      for (let q = 0; q + p.lit.length <= text.length; q++) if (cur[q] && text.startsWith(p.lit, q)) next[q + p.lit.length] = 1;
    } else {
      // A parameter takes one or more characters of its class.
      let open = false;
      for (let q = 1; q <= text.length; q++) {
        if (cur[q - 1]) open = true;
        if (!inClass(p.conv, text.charCodeAt(q - 1))) open = false;
        if (open) next[q] = 1;
      }
    }
    cur = next;
  }
  return cur[text.length] === 1;
}

// The pattern's segments against the path's, as a table of the path
// segments each pattern segment can end on: one pass per pattern segment.
export function matchSegs(segs: Seg[], asked: string[], work: { left: number }): boolean {
  if (asked.length > MAX_PATTERN_SEGMENTS + 1 || segs.length > MAX_PATTERN_SEGMENTS + 1) return false;
  const n = asked.length;
  let reach = new Uint8Array(n + 1);
  reach[0] = 1;
  for (const seg of segs) {
    work.left -= n + 1;
    if (work.left <= 0) return false;
    const next = new Uint8Array(n + 1);
    if (seg.kind === "path") {
      for (let j = 0; j < n; j++) {
        if (!reach[j] || !(asked[j] as string).startsWith(seg.prefix)) continue;
        for (let k = j + 1; k <= n; k++) next[k] = 1;
        break;
      }
    } else {
      for (let j = 0; j < n; j++) {
        if (!reach[j]) continue;
        const text = asked[j] as string;
        if (seg.kind === "lit" ? text === seg.text : matchTemplate(seg.pieces, text, work)) next[j + 1] = 1;
      }
    }
    reach = next;
  }
  return reach[n] === 1;
}

// Whether a request path matches a FastAPI pattern: `{name}` is one
// segment, `{name:path}` the rest of the path, a trailing slash may differ
// (Starlette redirects). No regular expression is built; a pattern or path
// of more than MAX_PATTERN_SEGMENTS segments is refused.
export function matches(pattern: string, path: string): boolean {
  const segs = parsePattern(pattern);
  if (!segs) return false;
  const work = { left: MAX_MATCH_WORK };
  const clean = requestPath(path);
  const asked = clean.split("/");
  if (asked.length > MAX_PATTERN_SEGMENTS + 1) return false;
  return matchSegs(segs, asked, work) || matchSegs(segs, toggleSlash(clean).split("/"), work);
}
