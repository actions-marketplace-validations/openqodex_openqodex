// The Express plugin's resolve step: which values are Express applications
// and routers, which calls on them register routes, mount routers and add
// middleware, what each registration's handler is, and which test requests
// may reach which route.
//
// API identity: a value is an application only when it is made by calling
// the default (or namespace) import of the "express" module, a router only
// when it is made by `express.Router()` or the module's named `Router`, and
// the module must resolve outside the repository. A dependency on express
// enables the rules; it never proves that `app.get` is a route. A call on
// any other value, such as an object of the repository's own with a get
// method, is no registration.
//
// Every registration is kept with its site, apart from its handler: a
// handler that is missing, computed, wrapped, inline or external leaves the
// registration in place with the handler's status and an unknown that says
// why. A route path computed at run time leaves the pattern null with an
// unknown of cause "dynamic". Two applications never share a registration:
// a router mounted on both yields one registration per application.
//
// The route files are the repository's, so a stranger controls them. Every
// walk here is bounded and says where it stopped: mounts are followed
// MAX_MOUNT_DEPTH levels deep and MAX_MOUNTS_PER_APP times per application
// (a diamond of routers cannot multiply), an application keeps
// MAX_REGISTRATIONS_PER_APP registrations and the build MAX_REGISTRATIONS, a
// route keeps MAX_MIDDLEWARE_CHAIN middleware, and test requests are
// matched within MAX_MATCH_WORK steps. Patterns are matched segment by
// segment, never by a regular expression built from the repository's text.
import type { Detection, Entity, FrameworkEdge, FrameworkEvidence, FrameworkEvidenceKind, FrameworkUnknown, HandlerStatus, Lookup, PluginIndex, PluginOutput, Registration, RoleAssignment, Site } from "../plugin.js";
import { appId, entityId } from "../plugin.js";
import type { Tier } from "../../model/records.js";
import type { ExpressFact } from "./facts.js";
import { HTTP_METHODS } from "./facts.js";
import type { Expr } from "./js.js";
import { evaluate, MAX_SOURCE_BYTES, show } from "./js.js";

export const PLUGIN = "express";
export const RULE_VERSION = 1;
const rule = (id: string) => ({ id, version: RULE_VERSION });

// The caps, each with an unknown when it stops a walk.
export const MAX_MOUNT_DEPTH = 8; // routers deep under an application
export const MAX_MOUNTS_PER_APP = 500; // router expansions under one application
export const MAX_REGISTRATIONS_PER_APP = 5000;
export const MAX_REGISTRATIONS = 10000; // in one build, every application together
export const MAX_MIDDLEWARE_CHAIN = 64; // middleware kept per application, router and route
export const MAX_MIDDLEWARE_EDGES = 100_000; // middleware edges in one build
export const MAX_TEST_REQUESTS = 2000; // supertest requests matched in one build
export const MAX_PATTERN_SEGMENTS = 64; // segments of a pattern or a request path matched
export const MAX_MATCH_WORK = 4_000_000; // pattern-by-path steps in one build

type Fact<K extends ExpressFact["kind"]> = Extract<ExpressFact, { kind: K }>;

// A value the plugin knows: an application, a router, or a test agent
// (`request(app)` of supertest).
type Val =
  | { kind: "app" | "router"; id: string; file: string; name: string; line: number; column: number; scope: number }
  | { kind: "agent"; file: string; target: Expr; scope: number; line: number };

// A name that is a parameter typed as an Express application or router: a
// registration on it lands on whatever application the caller passes.
type Param = { kind: "param"; file: string; name: string; type: string; line: number };

type Identity = {
  factory: Set<string>; // locals that call into express(): the default or namespace import
  router: Set<string>; // locals bound to the named Router export
  types: Set<string>; // locals bound to the named type exports Express, Router, Application, IRouter
  supertest: Set<string>;
  http: Set<string>; // locals of node's http or https module
  createServer: Set<string>; // locals bound to their named createServer export
};

// One file's facts, sorted by kind and name once.
type FileIndex = {
  values: Map<string, Fact<"value">[]>;
  params: Map<string, Fact<"param">[]>;
  cjs: Map<string, Fact<"cjs-export">>;
  functions: Map<string, Fact<"function">[]>;
  calls: Fact<"call">[];
  servers: Fact<"server">[];
  testBlocks: number;
  tooLarge: Fact<"too-large"> | null;
};

const METHOD_SET = new Set<string>([...HTTP_METHODS, "del"]);
const TYPE_NAMES = new Set(["Express", "Router", "Application", "IRouter"]);
const HTTP_MODULES = new Set(["http", "https", "node:http", "node:https", "http2", "node:http2"]);
const RUNNERS = ["vitest", "jest", "mocha", "ava", "@jest/globals", "uvu", "tap"];
const JS_EXTS = new Set(["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts"]);

// A test file by the runners' own default rule: under `__tests__`, or named
// `<name>.test.<ext>` or `<name>.spec.<ext>`. Plain string checks.
export function isTestFile(file: string): boolean {
  const parts = file.split("/");
  if (parts.slice(0, -1).includes("__tests__")) return true;
  const bits = (parts[parts.length - 1] ?? "").split(".");
  if (bits.length < 3) return false;
  const kind = bits[bits.length - 2];
  return (kind === "test" || kind === "spec") && JS_EXTS.has(bits[bits.length - 1] as string);
}

export type Analysis = {
  apps: Detection[];
  output: PluginOutput;
};

const memo = new WeakMap<object, Analysis>();

export function analyse(index: PluginIndex<ExpressFact>): Analysis {
  const kept = memo.get(index);
  if (kept) return kept;
  const result = run(index);
  memo.set(index, result);
  return result;
}

const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
};

function run(index: PluginIndex<ExpressFact>): Analysis {
  const roles: RoleAssignment[] = [];
  const edges: FrameworkEdge[] = [];
  const unknowns: FrameworkUnknown[] = [];
  const registrations: Registration[] = [];
  const apps: Detection[] = [];

  const enabled = new Map<string, boolean>();
  const isEnabled = (file: string): boolean => {
    const project = index.projectOf(file);
    let on = enabled.get(project);
    if (on === undefined) {
      on = index.declares(project, "npm", "express");
      enabled.set(project, on);
    }
    return on;
  };

  const fileIndexes = new Map<string, FileIndex>();
  const fx = (file: string): FileIndex => {
    let f = fileIndexes.get(file);
    if (f) return f;
    f = { values: new Map(), params: new Map(), cjs: new Map(), functions: new Map(), calls: [], servers: [], testBlocks: 0, tooLarge: null };
    for (const fact of index.factsOf(file)) {
      switch (fact.kind) {
        case "value":
          push(f.values, fact.name, fact);
          break;
        case "param":
          push(f.params, fact.name, fact);
          break;
        case "cjs-export":
          if (!f.cjs.has(fact.name)) f.cjs.set(fact.name, fact);
          break;
        case "function":
          push(f.functions, fact.name, fact);
          break;
        case "call":
          f.calls.push(fact);
          break;
        case "server":
          f.servers.push(fact);
          break;
        case "test-block":
          f.testBlocks++;
          break;
        case "too-large":
          f.tooLarge = fact;
          break;
      }
    }
    fileIndexes.set(file, f);
    return f;
  };

  // ---------- which local names are Express, supertest, node's http ----------
  const identities = new Map<string, Identity>();
  const identity = (file: string): Identity => {
    let id = identities.get(file);
    if (id) return id;
    id = { factory: new Set(), router: new Set(), types: new Set(), supertest: new Set(), http: new Set(), createServer: new Set() };
    identities.set(file, id);
    const lf = index.languageFacts(file);
    if (!lf) return id;
    const outside = (spec: string) => index.module(file, spec).kind === "external";
    for (const imp of lf.imports) {
      if (imp.scoped) continue;
      const local = [...imp.names.filter((n) => n.imported === "default").map((n) => n.local), ...(imp.namespace ? [imp.namespace] : [])];
      if (imp.spec === "express" && outside("express")) {
        for (const l of local) id.factory.add(l);
        for (const n of imp.names) {
          if (n.imported === "Router") id.router.add(n.local);
          if (TYPE_NAMES.has(n.imported)) id.types.add(n.local);
        }
      } else if (imp.spec === "supertest" && outside("supertest")) {
        for (const l of local) id.supertest.add(l);
      } else if (HTTP_MODULES.has(imp.spec)) {
        for (const l of local) id.http.add(l);
        for (const n of imp.names) if (n.imported === "createServer") id.createServer.add(n.local);
      }
    }
    return id;
  };

  // ---------- values ----------
  const routerKey = (file: string, line: number) => `fw:express:router:${file}:${line}`;
  const classify = (file: string, v: { name: string; value: Expr; scope: number; line: number; column: number }): Val | null => {
    const e = v.value;
    if (e.t !== "call" || e.fn.t !== "ref") return null;
    const id = identity(file);
    const p = e.fn.path;
    if (p.length === 1 && id.factory.has(p[0] as string)) return { kind: "app", id: appId(PLUGIN, file, v.line), file, name: v.name, line: v.line, column: v.column, scope: v.scope };
    if ((p.length === 2 && id.factory.has(p[0] as string) && p[1] === "Router") || (p.length === 1 && id.router.has(p[0] as string))) {
      return { kind: "router", id: routerKey(file, v.line), file, name: v.name, line: v.line, column: v.column, scope: v.scope };
    }
    if (p.length >= 1 && p.length <= 2 && id.supertest.has(p[0] as string) && (p.length === 1 || p[1] === "agent") && e.args[0]) {
      return { kind: "agent", file, target: e.args[0], scope: v.scope, line: v.line };
    }
    return null;
  };

  // The value a name holds at a line of a file: a declaration in the same
  // function first, then one at module level, then what an import brings
  // (a module-level value of another file shows as a miss there, read
  // through that file's own facts). Each step is at most MAX_MOUNT_DEPTH
  // deep, so `const a = b; const b = a` ends.
  const valueCache = new Map<string, Val | Param | null>();
  const valueIn = (file: string, path: readonly string[], scope: number, line: number, depth = 0): Val | Param | null => {
    if (depth > MAX_MOUNT_DEPTH || path.length === 0) return null;
    const key = depth === 0 ? `${file}\0${scope}\0${line}\0${path.join(".")}` : null;
    if (key !== null && valueCache.has(key)) return valueCache.get(key) ?? null;
    const out = valueOf(file, path, scope, line, depth);
    if (key !== null) valueCache.set(key, out);
    return out;
  };
  const valueOf = (file: string, path: readonly string[], scope: number, line: number, depth: number): Val | Param | null => {
    const name = path[0] as string;
    if (path.length === 1) {
      const decls = fx(file).values.get(name) ?? [];
      let local: Fact<"value"> | null = null;
      let top: Fact<"value"> | null = null;
      for (const v of decls) {
        if (scope !== 0 && v.scope === scope && v.line <= line && (!local || v.line > local.line)) local = v;
        if (v.scope === 0) {
          // A module-level declaration: the last one at or before the line, else the first after it.
          const before = v.line <= line;
          const topBefore = top !== null && top.line <= line;
          if (!top || (before && (!topBefore || v.line > top.line)) || (!before && !topBefore && v.line < top.line)) top = v;
        }
      }
      const decl = local ?? top;
      if (decl) {
        const direct = classify(file, decl);
        if (direct) return direct;
        // `const app = other` passes a known value on.
        if (decl.value.t === "ref" && !(decl.value.path.length === 1 && decl.value.path[0] === name)) return valueIn(file, decl.value.path, decl.scope, decl.line, depth + 1);
        return null;
      }
      const param = (fx(file).params.get(name) ?? []).find((p) => p.scope === scope);
      if (param) {
        const id = identity(file);
        const head = param.type[0] as string;
        const typed = (param.type.length === 1 && id.types.has(head)) || (param.type.length === 2 && id.factory.has(head) && TYPE_NAMES.has(param.type[1] as string));
        return typed ? { kind: "param", file, name, type: param.type.join("."), line: param.line } : null;
      }
    }
    return fromImport(file, path, depth);
  };

  const fromImport = (file: string, path: readonly string[], depth: number): Val | Param | null => {
    let found: Lookup = index.lookup(file, path);
    let target: { file: string; name: string } | null = null;
    if (found.kind === "miss") target = { file: found.target, name: found.name };
    else if (found.kind === "none" && path.length === 2) {
      found = index.lookup(file, [path[0] as string]);
      if (found.kind === "module") target = { file: found.file, name: path[1] as string };
    }
    if (!target || !index.languageFacts(target.file)) return null;
    return exportedValue(target.file, target.name, depth + 1);
  };

  const topValue = (file: string, name: string): Fact<"value"> | null => (fx(file).values.get(name) ?? []).find((v) => v.top) ?? null;

  const exportedValue = (file: string, name: string, depth: number): Val | Param | null => {
    if (depth > MAX_MOUNT_DEPTH) return null;
    const lf = index.languageFacts(file);
    let local: string | null = null;
    if (name === "default") local = lf?.defaultExport ?? null;
    const direct = (fx(file).values.get(name) ?? []).find((v) => v.top && v.exported);
    if (direct) return valueIn(file, [direct.name], 0, direct.line, depth);
    local ??= lf?.exportsLocal.find((x) => x.exported === name)?.local ?? null;
    const cjs = fx(file).cjs.get(name);
    if (!local && cjs) {
      if (cjs.value.t === "ref" && cjs.value.path.length === 1) local = cjs.value.path[0] as string;
      else return classify(file, { name, value: cjs.value, scope: 0, line: cjs.line, column: cjs.column });
    }
    if (!local) return null;
    const decl = topValue(file, local);
    return decl ? valueIn(file, [local], 0, decl.line, depth) : null;
  };

  const constant = (file: string) => (path: string[]): string | null => {
    if (path.length !== 1) return null;
    const decl = (fx(file).values.get(path[0] as string) ?? []).find((v) => v.top && v.value.t === "str");
    return decl && decl.value.t === "str" ? decl.value.v : null;
  };

  // ---------- events on each application and router ----------
  type RouteEvent = { type: "route"; file: string; site: Site; methods: string[]; path: Expr; handlers: Expr[]; scope: number };
  type UseEvent = { type: "use"; file: string; site: Site; prefix: Expr | null; args: Expr[]; scope: number };
  type Event = RouteEvent | UseEvent;
  const events = new Map<string, Event[]>();
  const vals = new Map<string, Val & { kind: "app" | "router" }>();
  const served = new Map<string, Site[]>();
  const requests: { file: string; site: Site; method: string; path: Expr; agent: Val & { kind: "agent" }; scope: number }[] = [];
  const paramRoutes: { param: Param; event: RouteEvent }[] = [];
  const addEvent = (v: Val & { kind: "app" | "router" }, e: Event) => {
    vals.set(v.id, v);
    push(events, v.id, e);
  };

  const files = index.factFiles().filter(isEnabled);
  for (const file of files) {
    const big = fx(file).tooLarge;
    if (big) {
      unknowns.push({ plugin: PLUGIN, site: { file, line: 1, column: 1 }, scope: { file }, affects: ["handles", "mounts", "applies_middleware", "tests"], cause: "file-not-parsed", name: null, note: `the file is ${big.bytes} bytes, over the ${MAX_SOURCE_BYTES}-byte cap of the Express plugin, so its routes were not read`, count: null, exact: false });
      continue;
    }
    for (const list of fx(file).values.values()) {
      for (const v of list) {
        const c = classify(file, v);
        if (c && c.kind !== "agent") {
          vals.set(c.id, c);
          if (!events.has(c.id)) events.set(c.id, []);
        }
      }
    }
  }

  // The receiver of a watched call: a value, a route chain on a value, or a
  // supertest agent.
  type Base = { val: Val | Param; route: Expr | null } | null;
  const baseOf = (file: string, recv: Expr, scope: number, line: number): Base => {
    let r = recv;
    // `x.route("/p").get(h).post(h2)`: walk down the chain of method calls
    // (readExpr kept it at most a few levels deep).
    while (r.t === "call" && r.fn.t === "member" && METHOD_SET.has(r.fn.prop)) r = r.fn.obj;
    if (r.t === "call" && r.fn.t === "ref" && r.fn.path.length >= 2 && r.fn.path[r.fn.path.length - 1] === "route") {
      const v = valueIn(file, r.fn.path.slice(0, -1), scope, line);
      return v && v.kind !== "agent" ? { val: v, route: r.args[0] ?? null } : null;
    }
    if (r.t === "call" && r.fn.t === "member" && r.fn.prop === "route") return null;
    if (r.t === "ref") {
      const v = valueIn(file, r.path, scope, line);
      return v ? { val: v, route: null } : null;
    }
    if (r.t === "call") {
      const c = classify(file, { name: "", value: r, scope, line, column: r.column });
      return c ? { val: c, route: null } : null;
    }
    return null;
  };

  for (const file of files) {
    if (fx(file).tooLarge) continue;
    for (const f of fx(file).calls) {
      const site: Site = { file, line: f.line, column: f.column };
      const base = baseOf(file, f.recv, f.scope, f.line);
      if (!base) continue;
      const v = base.val;
      if (v.kind === "agent") {
        if (METHOD_SET.has(f.prop) && f.args[0] && f.prop !== "all") requests.push({ file, site, method: f.prop === "del" ? "DELETE" : f.prop.toUpperCase(), path: f.args[0], agent: v, scope: f.scope });
        continue;
      }
      if (f.prop === "listen") {
        if (v.kind !== "param") push(served, v.id, site);
        continue;
      }
      if (f.prop === "use") {
        if (base.route || v.kind === "param") continue;
        const first = f.args[0];
        const isPrefix = first !== undefined && (first.t === "str" || first.t === "dyn" || (first.t === "ref" && evaluate(first, constant(file)) !== null));
        addEvent(v, { type: "use", file, site, prefix: isPrefix ? (first as Expr) : null, args: isPrefix ? f.args.slice(1) : f.args, scope: f.scope });
        continue;
      }
      if (!METHOD_SET.has(f.prop)) continue;
      // `app.get("name")` with one argument reads a setting; a route needs a handler.
      const path = base.route ?? f.args[0];
      const handlers = base.route ? f.args : f.args.slice(1);
      if (!path || handlers.length === 0) continue;
      const method = f.prop === "all" ? "*" : f.prop === "del" ? "DELETE" : f.prop.toUpperCase();
      const e: RouteEvent = { type: "route", file, site, methods: [method], path, handlers, scope: f.scope };
      if (v.kind === "param") paramRoutes.push({ param: v, event: e });
      else addEvent(v, e);
    }
    for (const f of fx(file).servers) {
      const id = identity(file);
      const p = f.fn;
      const isNode = (p.length === 2 && id.http.has(p[0] as string)) || (p.length === 1 && id.createServer.has(p[0] as string));
      if (!isNode) continue;
      for (const a of f.args) {
        if (a.t !== "ref") continue;
        const v = valueIn(file, a.path, f.scope, f.line);
        if (v && v.kind === "app") push(served, v.id, { file, line: f.line, column: f.column });
      }
    }
  }
  for (const list of events.values()) list.sort((a, b) => (a.file === b.file ? a.site.line - b.site.line || a.site.column - b.site.column : a.file < b.file ? -1 : 1));

  // ---------- handlers and middleware ----------
  type Bound = { status: HandlerStatus; targets: string[]; tier: Tier; kind: FrameworkEvidenceKind; via: FrameworkEvidence["via"]; note: string | null; why: { cause: FrameworkUnknown["cause"]; note: string; name: string | null } | null };
  const bindCache = new Map<string, Bound>();
  const bindFn = (file: string, e: Expr, scope: number, line: number, role: "handler" | "middleware"): Bound => {
    const key = `${file}:${e.line}:${e.column}:${role}`;
    const kept = bindCache.get(key);
    if (kept) return kept;
    const out = bindOnce(file, e, scope, line, role);
    bindCache.set(key, out);
    return out;
  };
  const bindOnce = (file: string, e: Expr, scope: number, line: number, role: "handler" | "middleware"): Bound => {
    const none = (status: HandlerStatus, cause: FrameworkUnknown["cause"], note: string, name: string | null): Bound => ({ status, targets: [], tier: "certain", kind: "route-call", via: null, note: null, why: { cause, note, name } });
    if (e.t === "fn") return none("unresolved", "unsupported-rule", `the ${role} is an inline function, which has no symbol of its own; the calls it makes are counted under the code around it`, null);
    if (e.t === "call") {
      const inner = e.args.find((a) => a.t === "ref");
      const wrapper = show(e.fn);
      if (role === "middleware") {
        const fn = e.fn.t === "ref" ? index.lookup(file, e.fn.path) : null;
        if (fn?.kind === "symbol") return { status: "bound", targets: fn.ids, tier: "possible", kind: "route-call", via: fn.via, note: `the middleware is the value ${show(e)} returns`, why: null };
        return none(fn?.kind === "external" ? "external" : "unresolved", fn?.kind === "external" ? "external" : "unsupported-rule", `the middleware is the value ${show(e)} returns`, null);
      }
      return none("unresolved", "unsupported-rule", `the handler is the value ${show(e)} returns; whether ${wrapper} calls ${inner ? show(inner) : "what it is given"} is not proved, so the handler is not bound`, inner ? show(inner) : wrapper);
    }
    if (e.t !== "ref") return none("dynamic", "dynamic", `the ${role} is computed (${show(e)})`, null);
    const found = index.lookup(file, e.path);
    switch (found.kind) {
      case "symbol":
        return { status: "bound", targets: found.ids, tier: found.tier, kind: "route-call", via: found.via, note: found.tier === "certain" ? null : (found.note ?? `the ${role}'s binding is ${found.tier}`), why: null };
      case "miss":
        return none("missing", "miss", `the ${role} ${show(e)} names ${found.name} in ${found.target}, where no such definition exists now`, show(e));
      case "external":
        return none("external", "external", `${show(e)} comes from a declared dependency`, show(e));
      case "gap":
        return none(found.cause === "ambiguous" ? "ambiguous" : "unresolved", found.cause, found.note, show(e));
      default: {
        const head = e.path[0] as string;
        const isLocal = fx(file).values.has(head) || fx(file).params.has(head) || (e.path.length === 1 && valueIn(file, e.path, scope, line) !== null);
        if (isLocal) return none("dynamic", "dynamic", `the ${role} ${show(e)} is a value the code computes, not a definition`, show(e));
        return none("missing", "miss", `no definition named ${show(e)} is in scope`, show(e));
      }
    }
  };

  const errorHandler = (id: string): boolean => {
    const n = index.node(id);
    if (!n) return false;
    return (fx(n.file).functions.get(n.name) ?? []).some((f) => f.line === n.startLine && f.params === 4);
  };

  const roleSeen = new Set<string>();
  const addRole = (target: string, role: "route_handler" | "middleware" | "test", detail: string | null, app: string | null, evidence: FrameworkEvidence) => {
    const k = `${target}\0${role}`;
    if (roleSeen.has(k)) return;
    roleSeen.add(k);
    roles.push({ target, role, detail, app, evidence });
  };

  // ---------- composition: every route each application serves ----------
  type Mw = { prefix: string | null; site: Site; file: string; expr: Expr; scope: number };
  // One root of the composition (an application, or a router no
  // application reaches) and what its walk has spent.
  type Walk = { app: string | null; root: string; mounts: number; regs: number; stopped: "mounts" | "registrations" | "total" | null; mwOmitted: number; depthCut: number };
  let totalRegs = 0;
  const segs = (p: string): string[] => p.split("/").filter((s) => s !== "");
  const joinPath = (a: string, b: string): string => `/${[...segs(a), ...segs(b)].join("/")}`;
  const under = (pattern: string | null, prefix: string | null): boolean => {
    if (prefix === null || prefix === "/" || prefix === "") return true;
    if (pattern === null) return false;
    const p = segs(prefix);
    const q = segs(pattern);
    return p.length <= q.length && p.every((s, i) => s === q[i]);
  };
  const scopeOf = (w: Walk, file: string): FrameworkUnknown["scope"] => (w.app ? { app: w.app } : { file });

  const reached = new Set<string>(); // routers some application reaches
  const mountedBy = new Map<string, number>(); // routers mounted anywhere, application or not
  for (const [id, list] of events) {
    for (const e of list) {
      if (e.type !== "use") continue;
      for (const a of e.args) {
        if (a.t !== "ref") continue;
        const v = valueIn(e.file, a.path, e.scope, e.site.line);
        if (v && v.kind === "router" && v.id !== id) mountedBy.set(v.id, (mountedBy.get(v.id) ?? 0) + 1);
      }
    }
  }

  let middlewareEdges = 0;
  let middlewareEdgesOmitted = 0;
  const compose = (w: Walk, val: Val & { kind: "app" | "router" }, prefix: string | null, inherited: Mw[], via: Site[], stack: readonly string[], depth: number) => {
    if (w.app) reached.add(val.id);
    const mw: Mw[] = [...inherited];
    for (const e of events.get(val.id) ?? []) {
      if (w.stopped) return;
      if (e.type === "use") {
        const own = e.prefix === null ? null : evaluate(e.prefix, constant(e.file));
        if (e.prefix !== null && own === null) {
          unknowns.push({ plugin: PLUGIN, site: e.site, scope: scopeOf(w, e.file), affects: ["mounts", "handles", "applies_middleware"], cause: "dynamic", name: show(e.prefix), note: `the mount path ${show(e.prefix)} is computed at run time, so the routes under it have no known pattern`, count: null, exact: false });
        }
        const at = e.prefix === null ? prefix : own === null ? null : joinPath(prefix ?? "", own);
        const known = e.prefix === null || own !== null;
        for (const a of e.args) {
          if (w.stopped) return;
          const target = a.t === "ref" ? valueIn(e.file, a.path, e.scope, e.site.line) : null;
          if (target && target.kind === "router") {
            // A mount that loops back to a router on the way here ends the loop.
            if (stack.includes(target.id)) continue;
            if (depth >= MAX_MOUNT_DEPTH) {
              w.depthCut++;
              continue;
            }
            if (w.mounts >= MAX_MOUNTS_PER_APP) {
              w.stopped = "mounts";
              return;
            }
            w.mounts++;
            edges.push({ from: val.id, to: target.id, kind: "mounts", plugin: PLUGIN, app: w.app, evidence: { kind: "mount", tier: "certain", site: e.site, via: null, premises: [], rule: rule("express-mount"), note: null } });
            compose(w, target, known ? (at ?? "") : null, mw.filter((m) => under(at, m.prefix)), [...via, e.site], [...stack, target.id], depth + 1);
            continue;
          }
          if (target && target.kind === "app") continue; // a sub-application: its own routes, its own identity
          if (mw.length >= MAX_MIDDLEWARE_CHAIN) {
            w.mwOmitted++;
            continue;
          }
          mw.push({ prefix: known ? at : null, site: e.site, file: e.file, expr: a, scope: e.scope });
          // Every function given to use is middleware, whether or not a route follows it.
          const b = bindFn(e.file, a, e.scope, e.site.line, "middleware");
          for (const t of b.targets) addRole(t, "middleware", errorHandler(t) ? "error-handler" : "express", w.app, { kind: "route-call", tier: b.tier, site: e.site, via: b.via, premises: [], rule: rule("express-middleware"), note: b.note });
        }
        continue;
      }
      // A route.
      if (w.regs >= MAX_REGISTRATIONS_PER_APP) {
        w.stopped = "registrations";
        return;
      }
      if (totalRegs >= MAX_REGISTRATIONS) {
        w.stopped = "total";
        return;
      }
      w.regs++;
      totalRegs++;
      const written = evaluate(e.path, constant(e.file));
      // A router no application reaches keeps its pattern as written; one
      // under a computed mount path has none.
      const pattern = written === null ? null : prefix === null ? (via.length > 0 ? null : written) : joinPath(prefix, written);
      const key = `${e.file}:${e.site.line}:${e.site.column}${via.map((s) => `@${s.file}:${s.line}:${s.column}`).join("")}`;
      const id = entityId(PLUGIN, w.app, "registration", key);
      const h = e.handlers[e.handlers.length - 1] as Expr;
      const bound = bindFn(e.file, h, e.scope, e.site.line, "handler");
      registrations.push({
        kind: "registration",
        id,
        plugin: PLUGIN,
        app: w.app,
        methods: e.methods,
        pattern,
        written,
        name: null,
        site: e.site,
        mountedVia: via,
        mounted: w.app !== null,
        handler: { written: show(h), status: bound.status, targets: bound.targets },
      });
      if (written === null) unknowns.push({ plugin: PLUGIN, site: e.site, scope: { file: e.file }, affects: ["handles"], cause: "dynamic", name: show(e.path), note: `the route path ${show(e.path)} is computed at run time, so this registration has no known pattern`, count: null, exact: false });
      if (bound.why) unknowns.push({ plugin: PLUGIN, site: { file: e.file, line: h.line, column: h.column }, scope: { file: e.file }, affects: ["handles"], cause: bound.why.cause, name: bound.why.name, note: bound.why.note, count: null, exact: false });
      for (const t of bound.targets) {
        const ev: FrameworkEvidence = { kind: bound.kind, tier: bound.tier, site: e.site, via: bound.via, premises: [], rule: rule("express-route"), note: bound.note };
        edges.push({ from: id, to: t, kind: "handles", plugin: PLUGIN, app: w.app, evidence: ev });
        addRole(t, "route_handler", "express", w.app, ev);
      }
      // Middleware: the application's and routers' own in effect here, then the route's.
      const own: Mw[] = [];
      for (const x of e.handlers.slice(0, -1)) {
        for (const item of x.t === "array" ? x.items : [x]) own.push({ prefix: null, site: e.site, file: e.file, expr: item, scope: e.scope });
      }
      const chain = [...mw.filter((m) => under(pattern, m.prefix)), ...own];
      if (chain.length > MAX_MIDDLEWARE_CHAIN) w.mwOmitted += chain.length - MAX_MIDDLEWARE_CHAIN;
      let order = 0;
      for (const m of chain.slice(0, MAX_MIDDLEWARE_CHAIN)) {
        const b = bindFn(m.file, m.expr, m.scope, m.site.line, "middleware");
        for (const t of b.targets) {
          const ev: FrameworkEvidence = { kind: "route-call", tier: b.tier, site: m.site, via: b.via, premises: [], rule: rule("express-middleware"), note: b.note };
          addRole(t, "middleware", errorHandler(t) ? "error-handler" : "express", w.app, ev);
          if (middlewareEdges >= MAX_MIDDLEWARE_EDGES) {
            middlewareEdgesOmitted++;
            continue;
          }
          edges.push({ from: id, to: t, kind: "applies_middleware", plugin: PLUGIN, app: w.app, evidence: ev, order });
          middlewareEdges++;
        }
        order++;
      }
    }
  };

  // What a walk left out, as unknowns on its root.
  const report = (w: Walk, file: string) => {
    const scope = scopeOf(w, file);
    if (w.depthCut > 0) unknowns.push({ plugin: PLUGIN, site: null, scope, affects: ["mounts", "handles"], cause: "fan-out-capped", name: null, note: `routers mounted more than ${MAX_MOUNT_DEPTH} levels deep were not followed (${w.depthCut} mounts); their routes are not listed`, count: w.depthCut, exact: true });
    if (w.stopped === "mounts") unknowns.push({ plugin: PLUGIN, site: null, scope, affects: ["mounts", "handles", "applies_middleware"], cause: "fan-out-capped", name: null, note: `the walk stopped after ${MAX_MOUNTS_PER_APP} router mounts under one application; the routes past it are not listed`, count: null, exact: false });
    if (w.stopped === "registrations") unknowns.push({ plugin: PLUGIN, site: null, scope, affects: ["handles", "applies_middleware"], cause: "fan-out-capped", name: null, note: `the walk stopped after ${MAX_REGISTRATIONS_PER_APP} registrations under one application; the routes past it are not listed`, count: null, exact: false });
    if (w.stopped === "total") unknowns.push({ plugin: PLUGIN, site: null, scope, affects: ["handles", "applies_middleware"], cause: "fan-out-capped", name: null, note: `the plugin keeps at most ${MAX_REGISTRATIONS} registrations in one build; the routes past it are not listed`, count: null, exact: false });
    if (w.mwOmitted > 0) unknowns.push({ plugin: PLUGIN, site: null, scope, affects: ["applies_middleware"], cause: "fan-out-capped", name: null, note: `middleware past ${MAX_MIDDLEWARE_CHAIN} in one chain was left out (${w.mwOmitted} entries)`, count: w.mwOmitted, exact: true });
  };

  for (const v of vals.values()) {
    if (v.kind !== "app") continue;
    const id = v.id;
    const w: Walk = { app: id, root: id, mounts: 0, regs: 0, stopped: null, mwOmitted: 0, depthCut: 0 };
    compose(w, v, "", [], [], [id], 0);
    report(w, v.file);
    const version = index.model().node.find((p) => p.dir === index.projectOf(v.file))?.pkg.deps.get("express") ?? null;
    const servedAt = served.get(id) ?? [];
    apps.push({
      id,
      name: `${v.name} (${v.file})`,
      project: index.projectOf(v.file),
      root: index.projectOf(v.file),
      site: { file: v.file, line: v.line, column: v.column },
      evidence: [{ file: v.file, line: v.line, note: "made by calling the express module's default export" }, ...servedAt.slice(0, 8).map((s) => ({ file: s.file, line: s.line, note: "served here" }))],
      version,
      data: { served: servedAt.length > 0 },
    });
  }
  // Routers no application reaches: their routes are kept, relative and not served.
  for (const v of vals.values()) {
    if (v.kind !== "router" || reached.has(v.id) || (mountedBy.get(v.id) ?? 0) > 0) continue;
    const w: Walk = { app: null, root: v.id, mounts: 0, regs: 0, stopped: null, mwOmitted: 0, depthCut: 0 };
    compose(w, v, null, [], [], [v.id], 0);
    report(w, v.file);
  }
  // Routes on a parameter typed as an application or a router.
  for (const { param, event: e } of paramRoutes) {
    if (totalRegs >= MAX_REGISTRATIONS) break;
    totalRegs++;
    const written = evaluate(e.path, constant(e.file));
    const h = e.handlers[e.handlers.length - 1] as Expr;
    const bound = bindFn(e.file, h, e.scope, e.site.line, "handler");
    const id = entityId(PLUGIN, null, "registration", `${e.file}:${e.site.line}:${e.site.column}`);
    registrations.push({ kind: "registration", id, plugin: PLUGIN, app: null, methods: e.methods, pattern: written, written, name: null, site: e.site, mountedVia: [], mounted: false, handler: { written: show(h), status: bound.status, targets: bound.targets } });
    unknowns.push({ plugin: PLUGIN, site: e.site, scope: { file: e.file }, affects: ["handles", "mounts"], cause: "dynamic", name: param.name, note: `the route is registered on the parameter ${param.name} (${param.type}); which application it lands on, and under which prefix, is decided by the caller`, count: null, exact: false });
    if (bound.why) unknowns.push({ plugin: PLUGIN, site: { file: e.file, line: h.line, column: h.column }, scope: { file: e.file }, affects: ["handles"], cause: bound.why.cause, name: bound.why.name, note: bound.why.note, count: null, exact: false });
    for (const t of bound.targets) {
      const ev: FrameworkEvidence = { kind: "route-call", tier: bound.tier, site: e.site, via: bound.via, premises: [], rule: rule("express-route"), note: bound.note };
      edges.push({ from: id, to: t, kind: "handles", plugin: PLUGIN, app: null, evidence: ev });
      addRole(t, "route_handler", "express", null, ev);
    }
  }

  // ---------- test requests ----------
  // Patterns parsed once per registration, grouped by application.
  const byApp = new Map<string, { reg: Registration; pattern: Pattern }[]>();
  for (const r of registrations) {
    if (r.app === null || r.pattern === null) continue;
    const p = parsePattern(r.pattern);
    if (p) push(byApp, r.app, { reg: r, pattern: p });
  }
  const testFiles = new Set<string>();
  let work = 0;
  let unmatched = 0;
  let requestsSeen = 0;
  for (const r of requests) {
    if (requestsSeen >= MAX_TEST_REQUESTS || work >= MAX_MATCH_WORK) {
      unmatched++;
      continue;
    }
    requestsSeen++;
    const target = r.agent.target;
    const app = target.t === "ref" ? valueIn(r.agent.file, target.path, r.agent.scope, r.agent.line) : null;
    if (!app || app.kind !== "app") continue;
    testFiles.add(r.file);
    const path = evaluate(r.path, constant(r.file));
    if (path === null) {
      unknowns.push({ plugin: PLUGIN, site: r.site, scope: { file: r.file }, affects: ["tests"], cause: "dynamic", name: show(r.path), note: `the test requests a computed path (${show(r.path)}), so the route it reaches is not known`, count: null, exact: false });
      continue;
    }
    const clean = (path.split("?")[0] as string).split("#")[0] as string;
    const asked = segs(clean);
    if (asked.length > MAX_PATTERN_SEGMENTS) continue;
    const from = index.enclosing(r.file, r.site.line)?.id ?? r.file;
    for (const { reg, pattern } of byApp.get(app.id) ?? []) {
      if (!reg.methods.includes("*") && !reg.methods.includes(r.method) && !(r.method === "HEAD" && reg.methods.includes("GET"))) continue;
      work += (pattern.length + 1) * (asked.length + 1);
      if (!matchSegments(pattern, asked)) continue;
      edges.push({ from, to: reg.id, kind: "tests", plugin: PLUGIN, app: app.id, category: "route-request", evidence: { kind: "test-route-request", tier: "likely", site: r.site, via: null, premises: [reg.id], rule: rule("express-test-request"), note: `the test requests ${r.method} ${clean} from ${app.name}, which this route's pattern ${reg.pattern} matches` } });
    }
  }
  if (unmatched > 0) unknowns.push({ plugin: PLUGIN, site: null, scope: { project: "" }, affects: ["tests"], cause: "budget", name: null, note: `${unmatched} test requests were not matched to routes: the plugin matches at most ${MAX_TEST_REQUESTS} requests and ${MAX_MATCH_WORK} pattern steps in one build`, count: unmatched, exact: true });
  for (const file of files) {
    if (!isTestFile(file) || fx(file).testBlocks === 0) continue;
    const project = index.projectOf(file);
    const runner = RUNNERS.some((n) => index.declares(project, "npm", n)) || (index.languageFacts(file)?.imports.some((i) => i.spec === "node:test") ?? false);
    if (!runner || (!testFiles.has(file) && identity(file).supertest.size === 0)) continue;
    addRole(file, "test", "supertest", null, { kind: "role-path", tier: "certain", site: { file, line: 1, column: 1 }, via: null, premises: [], rule: rule("express-test-file"), note: null });
  }

  if (middlewareEdgesOmitted > 0) unknowns.push({ plugin: PLUGIN, site: null, scope: { project: "" }, affects: ["applies_middleware"], cause: "fan-out-capped", name: null, note: `the plugin keeps at most ${MAX_MIDDLEWARE_EDGES} middleware edges in one build; ${middlewareEdgesOmitted} more were left out`, count: middlewareEdgesOmitted, exact: true });
  const entities: Entity[] = registrations;
  return { apps, output: { roles, entities, edges, unknowns } };
}

// ---------- matching a request path against an Express pattern ----------

// A pattern segment: a literal, a `:name` parameter (one segment), a
// `:name?` optional parameter, or `*` (any number of segments).
type Seg = { t: "lit"; v: string } | { t: "param" } | { t: "optional" } | { t: "star" };
type Pattern = Seg[];

const isWordChar = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;

// A pattern parsed into segments, or null when it holds a form this matcher
// does not read (a regular expression group, a wildcard inside a segment,
// more than MAX_PATTERN_SEGMENTS segments): such a route is never matched.
export function parsePattern(pattern: string): Pattern | null {
  const parts = pattern.split("/").filter((s) => s !== "");
  if (parts.length > MAX_PATTERN_SEGMENTS) return null;
  const out: Pattern = [];
  for (const s of parts) {
    if (s === "*") {
      out.push({ t: "star" });
      continue;
    }
    if (s.charCodeAt(0) === 58) {
      const optional = s.endsWith("?");
      const name = optional ? s.slice(1, -1) : s.slice(1);
      if (name.length === 0) return null;
      for (let i = 0; i < name.length; i++) if (!isWordChar(name.charCodeAt(i))) return null;
      out.push(optional ? { t: "optional" } : { t: "param" });
      continue;
    }
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === "*" || c === "(" || c === ")" || c === "?" || c === "+" || c === ":" || c === "[") return null;
    }
    out.push({ t: "lit", v: s });
  }
  return out;
}

// Whether request segments match a parsed pattern: one pass over the
// pattern keeping the set of request positions reached, so the work is at
// most (pattern segments + 1) times (request segments + 1) steps, with no
// backtracking.
export function matchSegments(pattern: Pattern, asked: readonly string[]): boolean {
  const n = asked.length;
  let at = new Uint8Array(n + 1);
  at[0] = 1;
  for (const seg of pattern) {
    const next = new Uint8Array(n + 1);
    let any = false;
    if (seg.t === "star") {
      let seen = 0;
      for (let j = 0; j <= n; j++) {
        seen |= at[j] as number;
        next[j] = seen;
        any ||= seen === 1;
      }
    } else {
      for (let j = 0; j <= n; j++) {
        if (!at[j]) continue;
        if (seg.t === "optional") {
          next[j] = 1;
          any = true;
        }
        if (j < n && (seg.t !== "lit" || seg.v === asked[j])) {
          next[j + 1] = 1;
          any = true;
        }
      }
    }
    if (!any) return false;
    at = next;
  }
  return at[n] === 1;
}

// Whether a request path matches an Express pattern.
export function matches(pattern: string, path: string): boolean {
  const p = parsePattern(pattern);
  const asked = path.split("/").filter((s) => s !== "");
  if (!p || asked.length > MAX_PATTERN_SEGMENTS) return false;
  return matchSegments(p, asked);
}
