// The Go net/http plugin's resolve step: which values are muxes, which calls
// register routes on them, what each registration's handler is, which muxes
// are mounted under which others, which muxes are served, and which test
// requests may reach which route.
//
// API identity: `http` is net/http only when the file imports "net/http"
// under that name, the import resolves outside the repository (the standard
// library), and no declaration inside the function shadows the name where it
// is used. A mux is a value made by `http.NewServeMux()` (or a
// `http.ServeMux{}` literal); the default mux is reached through
// `http.Handle`, `http.HandleFunc` and `http.DefaultServeMux`. A method
// named HandleFunc on any other value is no registration.
//
// Every mux is an application of its own, and so is the default mux of each
// Go project that registers on it. A mux mounted under another (`Handle` with
// a mux as the handler, directly or through `http.StripPrefix`) has its
// routes composed into the outer application as well, with the stripped
// prefix in front. Two applications never share a registration.
//
// Registrations are kept apart from their handlers: a handler that is
// missing, inline, wrapped, computed or external leaves the registration in
// place with the handler's status and an unknown that says why. A route
// whose own pattern is computed at run time is no registration: it is an
// unknown of cause "dynamic" at the call.
//
// Every kind of work is capped per build, never per application or file:
// registrations, mount expansions, middleware edges, test requests, pattern
// match steps, composition steps and lookups. Each cap, once reached, adds
// one unknown and stops that kind of work for the rest of the build.
import type { Cause, Tier } from "../../model/records.js";
import type { GraphNode } from "../../types.js";
import type { Detection, FrameworkEdge, FrameworkEdgeKind, FrameworkEvidence, FrameworkUnknown, HandlerStatus, Lookup, PluginIndex, PluginOutput, Registration, RoleAssignment, Site } from "../plugin.js";
import { appId, entityId } from "../plugin.js";
import type { Expr, GoHttpFact } from "./facts.js";
import { evaluate, MAX_EXPR_DEPTH, MAX_SOURCE_BYTES, show } from "./facts.js";

export const PLUGIN = "go-http";
export const RULE_VERSION = 1;
const rule = (id: string) => ({ id, version: RULE_VERSION });

// The caps, per build.
export const MAX_REGISTRATIONS = 10_000; // registrations created
export const MAX_MOUNTS = 2000; // sub-mux expansions followed
// Kept well below what the framework stage can append in one call.
export const MAX_MIDDLEWARE_EDGES = 30_000; // applies_middleware edges
export const MAX_TEST_REQUESTS = 2000; // httptest requests matched
export const MAX_TEST_LINKS = 10_000; // tests edges made from requests
export const MAX_MATCH_WORK = 4_000_000; // pattern segments compared
export const MAX_COMPOSE_STEPS = 1_000_000; // registration calls visited while composing muxes
export const MAX_LOOKUPS = 100_000; // names looked up through the index
// The caps per item: a registration's wrapper chain, a branch of mounts, a pattern.
export const MAX_MIDDLEWARE_CHAIN = 64;
export const MAX_MOUNT_DEPTH = 8;
export const MAX_PATTERN_SEGMENTS = 64;
const MAX_VALUE_STEPS = 8; // `a := b` hops followed to reach a mux or a handler

type Fact<K extends GoHttpFact["kind"]> = Extract<GoHttpFact, { kind: K }>;
type Via = FrameworkEvidence["via"];

// A mux: an application. `dflt` marks a project's default mux.
type Mux = { kind: "mux"; id: string; file: string; name: string; line: number; column: number; project: string; dflt: boolean; served: Site[]; first: Site | null };
// A registration's receiver that is a parameter typed as a mux: the caller decides which.
type ParamMux = { kind: "param"; file: string; name: string; type: string; line: number };

type Event = { file: string; site: Site; prop: "Handle" | "HandleFunc"; pattern: Expr; handler: Expr; scopes: number[] };

type Why = { cause: Cause; note: string; name: string | null; at: { line: number; column: number } };
type Wrapper = { targets: string[]; tier: Tier; via: Via; note: string | null };
type Bound = {
  status: HandlerStatus;
  targets: string[];
  tier: Tier;
  via: Via;
  note: string | null;
  why: Why | null;
  wrappers: Wrapper[]; // outermost first
  wrapCut: boolean; // more wrappers than MAX_MIDDLEWARE_CHAIN
  mount: { mux: Mux; strip: string | null | undefined } | null; // strip: undefined none, null computed
};

type Decl = { kind: "value"; file: string; fact: Fact<"value"> } | { kind: "param"; file: string; fact: Fact<"param"> };

type Identity = { http: Set<string>; httptest: Set<string>; testing: Set<string> };

type FileIndex = {
  values: Map<string, Fact<"value">[]>;
  params: Map<string, Fact<"param">[]>;
  paramsOf: Map<number, Fact<"param">[]>; // by the line of the function that declares them
  consts: Map<string, string>;
  serveHttp: Map<string, Fact<"serve-http">>; // by receiver type and line
};

// The standard library's handler wrappers whose first argument is the handler they serve.
const STDLIB_WRAPPERS = new Set(["TimeoutHandler", "MaxBytesHandler", "AllowQuerySemicolons"]);
const METHOD_CONSTANTS: Record<string, string> = {
  MethodGet: "GET",
  MethodHead: "HEAD",
  MethodPost: "POST",
  MethodPut: "PUT",
  MethodPatch: "PATCH",
  MethodDelete: "DELETE",
  MethodConnect: "CONNECT",
  MethodOptions: "OPTIONS",
  MethodTrace: "TRACE",
};
const SERVE_ARG: Record<string, number> = { ListenAndServe: 1, ListenAndServeTLS: 3, Serve: 1, ServeTLS: 1 };

const dirOf = (file: string): string => {
  const i = file.lastIndexOf("/");
  return i < 0 ? "" : file.slice(0, i);
};
const lastOf = (spec: string): string => spec.slice(spec.lastIndexOf("/") + 1);
const siteKey = (s: Site): string => `${s.file}:${s.line}:${s.column}`;

export type Analysis = { apps: Detection[]; output: PluginOutput };

const memo = new WeakMap<object, Analysis>();

export function analyse(index: PluginIndex<GoHttpFact>): Analysis {
  const kept = memo.get(index);
  if (kept) return kept;
  const result = run(index);
  memo.set(index, result);
  return result;
}

function run(index: PluginIndex<GoHttpFact>): Analysis {
  const roles: RoleAssignment[] = [];
  const edges: FrameworkEdge[] = [];
  const unknowns: FrameworkUnknown[] = [];
  const registrations: Registration[] = [];

  // ---------- caps ----------
  const used = { registrations: 0, mounts: 0, middleware: 0, requests: 0, testLinks: 0, match: 0, steps: 0, lookups: 0 };
  const stopped = new Set<string>();
  const stop = (key: keyof typeof used | "depth", cause: Cause, site: Site | null, affects: FrameworkEdgeKind[], note: string) => {
    if (stopped.has(key)) return;
    stopped.add(key);
    unknowns.push({ plugin: PLUGIN, site, scope: { project: "" }, affects, cause, name: null, note, count: null, exact: false });
  };
  const seenGaps = new Set<string>();
  const gap = (u: FrameworkUnknown) => {
    const k = `${u.cause}\0${u.site ? siteKey(u.site) : ""}\0${u.name ?? ""}\0${"file" in u.scope ? u.scope.file : ""}`;
    if (seenGaps.has(k)) return;
    seenGaps.add(k);
    unknowns.push(u);
  };
  const lookup = (file: string, path: readonly string[]): Lookup => {
    if (used.lookups >= MAX_LOOKUPS) {
      stop("lookups", "budget", { file, line: 1, column: 1 }, ["handles", "mounts", "applies_middleware"], `the plugin stopped looking names up after ${MAX_LOOKUPS} lookups in this build; handlers met after that are not bound`);
      return { kind: "gap", cause: "budget", note: `the lookup budget of ${MAX_LOOKUPS} ran out`, candidates: null };
    }
    used.lookups++;
    return index.lookup(file, path);
  };

  // ---------- files, packages and their facts ----------
  const files = index.factFiles();
  const goFiles = new Map<string, string[]>(); // folder to its Go files
  for (const p of index.paths()) {
    if (!p.endsWith(".go")) continue;
    const d = dirOf(p);
    const list = goFiles.get(d);
    if (list) list.push(p);
    else goFiles.set(d, [p]);
  }
  const pkgName = (file: string): string => index.languageFacts(file)?.goPackage ?? "";
  // The package a folder's non-test files declare.
  const pkgOfDir = (dir: string): string => {
    for (const f of goFiles.get(dir) ?? []) {
      const p = pkgName(f);
      if (p !== "" && !p.endsWith("_test")) return p;
    }
    return "";
  };
  const of = <K extends GoHttpFact["kind"]>(file: string, kind: K): Fact<K>[] => index.factsOf(file).filter((f): f is Fact<K> => f.kind === kind);

  const fileIndexes = new Map<string, FileIndex>();
  const fileIndex = (file: string): FileIndex => {
    let fi = fileIndexes.get(file);
    if (fi) return fi;
    fi = { values: new Map(), params: new Map(), paramsOf: new Map(), consts: new Map(), serveHttp: new Map() };
    for (const f of index.factsOf(file)) {
      if (f.kind === "value") (fi.values.get(f.name) ?? fi.values.set(f.name, []).get(f.name))?.push(f);
      else if (f.kind === "param") {
        (fi.params.get(f.name) ?? fi.params.set(f.name, []).get(f.name))?.push(f);
        (fi.paramsOf.get(f.scope) ?? fi.paramsOf.set(f.scope, []).get(f.scope))?.push(f);
      } else if (f.kind === "const") fi.consts.set(f.name, f.value);
      else if (f.kind === "serve-http") fi.serveHttp.set(`${f.recv}\0${f.line}`, f);
    }
    fileIndexes.set(file, fi);
    return fi;
  };
  // Package-level values by folder, package and name.
  const topValues = new Map<string, Decl[]>();
  for (const file of files) {
    for (const v of of(file, "value")) {
      if (v.scopes.length > 0) continue;
      const k = `${dirOf(file)}\0${pkgName(file)}\0${v.name}`;
      (topValues.get(k) ?? topValues.set(k, []).get(k))?.push({ kind: "value", file, fact: v });
    }
  }
  const topValue = (dir: string, pkg: string, name: string): Decl | null => topValues.get(`${dir}\0${pkg}\0${name}`)?.[0] ?? null;
  const constantOf = (file: string) => (name: string) => fileIndex(file).consts.get(name) ?? null;

  // ---------- which local names are net/http, httptest and testing ----------
  const identities = new Map<string, Identity>();
  const identity = (file: string): Identity => {
    let id = identities.get(file);
    if (id) return id;
    id = { http: new Set(), httptest: new Set(), testing: new Set() };
    identities.set(file, id);
    const lf = index.languageFacts(file);
    if (!lf || lf.lang !== "go") return id;
    const stdlib = (spec: string) => index.module(file, spec).kind === "external";
    for (const imp of lf.imports) {
      if (imp.scoped || imp.star) continue;
      const local = imp.namespace ?? lastOf(imp.spec);
      if (local === "_" || local === "") continue;
      if (imp.spec === "net/http" && stdlib(imp.spec)) id.http.add(local);
      else if (imp.spec === "net/http/httptest" && stdlib(imp.spec)) id.httptest.add(local);
      else if (imp.spec === "testing" && stdlib(imp.spec)) id.testing.add(local);
    }
    // A package-level definition of the same name would not compile; it never passes for the package.
    for (const d of lf.defs) {
      if (!d.topLevel) continue;
      id.http.delete(d.name);
      id.httptest.delete(d.name);
      id.testing.delete(d.name);
    }
    return id;
  };
  const isPkg = (file: string, e: Expr, set: keyof Identity, member: string | null): boolean =>
    e.t === "ref" && !e.local && e.path.length === (member === null ? 1 : 2) && identity(file)[set].has(e.path[0] as string) && (member === null || e.path[1] === member);

  // ---------- names and values ----------
  // The declaration a name refers to at a line: one in the enclosing
  // functions (innermost first, the latest before the line), else a
  // package-level value of the file's package. `strict` skips a value
  // declared on the line itself (`x := x` reads the outer x).
  const declOf = (file: string, name: string, local: boolean, scopes: readonly number[], line: number, strict: boolean): Decl | null => {
    if (!local) return topValue(dirOf(file), pkgName(file), name);
    const fi = fileIndex(file);
    const vals = fi.values.get(name) ?? [];
    const params = fi.params.get(name) ?? [];
    for (const s of scopes) {
      let best: Fact<"value"> | null = null;
      for (const v of vals) if ((v.scopes[0] ?? 0) === s && (strict ? v.line < line : v.line <= line) && (!best || v.line > best.line)) best = v;
      if (best) return { kind: "value", file, fact: best };
      const p = params.find((x) => x.scope === s);
      if (p) return { kind: "param", file, fact: p };
    }
    return null;
  };
  // The declaration a name chain's head names, and what is left of the chain:
  // a local or a package-level value of this package, or a value of another
  // package named `pkg.Name`.
  const declPath = (file: string, path: readonly string[], local: boolean, scopes: readonly number[], line: number, strict: boolean): { decl: Decl; rest: string[] } | null => {
    const head = path[0] as string;
    const d = declOf(file, head, local, scopes, line, strict);
    if (d) return { decl: d, rest: path.slice(1) };
    if (local || path.length < 2) return null;
    const m = lookup(file, [head]);
    if (m.kind !== "module") return null;
    const v = topValue(m.file, pkgOfDir(m.file), path[1] as string);
    return v ? { decl: v, rest: path.slice(2) } : null;
  };

  const muxes = new Map<string, Mux>();
  const muxAt = (file: string, f: Fact<"value">): Mux => {
    const id = appId(PLUGIN, file, f.line);
    let m = muxes.get(id);
    if (!m) {
      m = { kind: "mux", id, file, name: f.name, line: f.line, column: f.column, project: index.projectOf(file), dflt: false, served: [], first: null };
      muxes.set(id, m);
    }
    return m;
  };
  const modPath = (project: string): string => (project === "" ? "go.mod" : `${project}/go.mod`);
  const defaultMux = (project: string, create: Site | null): Mux | null => {
    const id = appId(PLUGIN, modPath(project), 1);
    let m = muxes.get(id);
    if (!m && create) {
      m = { kind: "mux", id, file: modPath(project), name: "http.DefaultServeMux", line: 1, column: 1, project, dflt: true, served: [], first: create };
      muxes.set(id, m);
    }
    return m ?? null;
  };
  // Whether a value expression makes a mux: `http.NewServeMux()`, `http.ServeMux{}`.
  const makesMux = (file: string, e: Expr): boolean =>
    (e.t === "call" && e.args.length === 0 && isPkg(file, e.fn, "http", "NewServeMux")) || (e.t === "lit" && e.type !== null && e.type.length === 2 && identity(file).http.has(e.type[0] as string) && e.type[1] === "ServeMux");

  const muxOfDecl = (d: Decl | null, create: Site | null, steps: number): Mux | ParamMux | null => {
    if (!d || steps > MAX_VALUE_STEPS) return null;
    if (d.kind === "param") {
      const t = d.fact.type;
      return t.length === 2 && identity(d.file).http.has(t[0] as string) && t[1] === "ServeMux" ? { kind: "param", file: d.file, name: d.fact.name, type: `${d.fact.pointer ? "*" : ""}${t.join(".")}`, line: d.fact.line } : null;
    }
    const v = d.fact;
    if (makesMux(d.file, v.value)) return muxAt(d.file, v);
    return v.value.t === "ref" ? muxOfRef(d.file, v.value, v.scopes, v.line, true, create, steps + 1) : null;
  };
  const muxOfRef = (file: string, e: Expr, scopes: readonly number[], line: number, strict: boolean, create: Site | null, steps: number): Mux | ParamMux | null => {
    if (e.t !== "ref" || steps > MAX_VALUE_STEPS) return null;
    if (isPkg(file, e, "http", "DefaultServeMux")) return defaultMux(index.projectOf(file), create);
    const found = declPath(file, e.path, e.local, scopes, line, strict);
    return found && found.rest.length === 0 ? muxOfDecl(found.decl, create, steps) : null;
  };

  // Every mux made anywhere is an application, registered on or not.
  for (const file of files) for (const v of of(file, "value")) if (makesMux(file, v.value)) muxAt(file, v);

  // ---------- registrations and servers ----------
  const events = new Map<string, Event[]>();
  const paramEvents: { param: ParamMux; event: Event }[] = [];
  for (const file of files) {
    for (const f of of(file, "call")) {
      if (f.prop !== "Handle" && f.prop !== "HandleFunc") continue;
      const pattern = f.args[0];
      const handler = f.args[1];
      if (!pattern || !handler || f.args.length !== 2) continue;
      const site: Site = { file, line: f.line, column: f.column };
      const event: Event = { file, site, prop: f.prop, pattern, handler, scopes: f.scopes };
      const target = isPkg(file, f.recv, "http", null) ? defaultMux(index.projectOf(file), site) : muxOfRef(file, f.recv, f.scopes, f.line, false, site, 0);
      if (!target) continue;
      if (target.kind === "param") {
        paramEvents.push({ param: target, event });
        continue;
      }
      (events.get(target.id) ?? events.set(target.id, []).get(target.id))?.push(event);
    }
  }
  for (const list of events.values()) list.sort((a, b) => (a.file === b.file ? a.site.line - b.site.line || a.site.column - b.site.column : a.file < b.file ? -1 : 1));

  // A server serves a mux, the default one when given nil.
  const serve = (file: string, e: Expr, scopes: readonly number[], site: Site) => {
    let cur = e;
    // `ListenAndServe(addr, logging(mux))` still serves mux.
    for (let i = 0; i < MAX_MOUNT_DEPTH && cur.t === "call"; i++) cur = cur.args.find((a) => a.t === "ref" || a.t === "call") ?? cur.args[0] ?? cur;
    const m = cur.t === "nil" ? defaultMux(index.projectOf(file), null) : muxOfRef(file, cur, scopes, site.line, false, null, 0);
    if (m && m.kind === "mux" && !m.served.some((s) => siteKey(s) === siteKey(site))) m.served.push(site);
  };
  for (const file of files) {
    for (const f of of(file, "call")) {
      const at = SERVE_ARG[f.prop];
      if (at === undefined || !isPkg(file, f.recv, "http", null)) continue;
      const arg = f.args[at];
      if (arg) serve(file, arg, f.scopes, { file, line: f.line, column: f.column });
    }
    for (const f of of(file, "server")) {
      if (!identity(file).http.has(f.type[0] as string)) continue;
      serve(file, f.handler ?? { t: "nil", line: f.line, column: f.column }, f.scopes, { file, line: f.line, column: f.column });
    }
  }

  // ---------- handlers ----------
  const symbolsOf = (dir: string, pkg: string): GraphNode[] => (goFiles.get(dir) ?? []).filter((f) => pkgName(f) === pkg).flatMap((f) => [...index.symbols(f)]);
  const methodsCache = new Map<string, string[]>();
  // The methods named `name` declared on a type in its package.
  const methodsOn = (type: GraphNode, name: string): string[] => {
    const k = `${type.id}\0${name}`;
    let ids = methodsCache.get(k);
    if (!ids) {
      ids = symbolsOf(dirOf(type.file), pkgName(type.file))
        .filter((s) => s.kind === "method" && s.name === name && s.id.startsWith(`${s.file}#${type.name}.${name}@`))
        .map((s) => s.id);
      methodsCache.set(k, ids);
    }
    return ids;
  };
  const embeds = (type: GraphNode): boolean => (index.languageFacts(type.file)?.defs ?? []).some((d) => d.name === type.name && d.line === type.startLine && d.bases.length > 0);

  type Res = Omit<Bound, "wrappers" | "wrapCut" | "mount">;
  const fail = (status: HandlerStatus, cause: Cause, note: string, name: string | null, at: Expr): Res => ({ status, targets: [], tier: "certain", via: null, note: null, why: { cause, note, name, at: { line: at.line, column: at.column } } });
  const fromLookup = (found: Lookup, e: Expr, what: string): Res => {
    switch (found.kind) {
      case "symbol":
        return { status: "bound", targets: found.ids, tier: found.tier, via: found.via, note: found.tier === "certain" ? null : (found.note ?? `the ${what}'s binding is ${found.tier}`), why: null };
      case "external":
        return fail("external", "external", `${show(e)} comes from the standard library or a declared dependency`, show(e), e);
      case "gap":
        return fail(found.cause === "ambiguous" ? "ambiguous" : found.cause === "miss" ? "missing" : "unresolved", found.cause, found.note, show(e), e);
      case "miss":
        return fail("missing", "miss", `the ${what} ${show(e)} names ${found.name} in ${found.target.startsWith("go:") ? found.target.slice(3) : found.target}, where no such definition exists now`, show(e), e);
      default:
        return fail("missing", "miss", `no definition named ${show(e)} is in scope`, show(e), e);
    }
  };

  // The type a value has, read from its declaration: a parameter's declared
  // type or a composite literal's type.
  const typeOfDecl = (d: Decl): { file: string; path: string[] } | null => {
    if (d.kind === "param") return d.fact.func ? null : { file: d.file, path: d.fact.type };
    const v = d.fact.value;
    return v.t === "lit" && v.type ? { file: d.file, path: v.type } : null;
  };
  const typeNode = (file: string, path: string[]): { node: GraphNode; found: Lookup } | { found: Lookup } => {
    const found = lookup(file, path);
    if (found.kind !== "symbol") return { found };
    const node = found.ids.map((id) => index.node(id)).find((n): n is GraphNode => n !== null && n.kind === "type");
    return node ? { node, found } : { found };
  };
  // A method value `x.m` whose receiver's type is declared: the method m of that type.
  const methodValue = (d: Decl, method: string, e: Expr, what: string): Res => {
    const t = typeOfDecl(d);
    if (!t) return fail("dynamic", "dynamic", `the ${what} ${show(e)} is a method of a value whose type no rule reads`, show(e), e);
    const tn = typeNode(t.file, t.path);
    if (!("node" in tn)) return tn.found.kind === "symbol" ? fail("unresolved", "unsupported-rule", `${t.path.join(".")} is not a type declared in the repository`, show(e), e) : fromLookup(tn.found, e, what);
    const ids = methodsOn(tn.node, method);
    if (ids.length === 0) return fail("unresolved", "unsupported-rule", `${t.path.join(".")} declares no method ${method} in its package; a promoted method or a field of function type is not followed`, show(e), e);
    const f = tn.found as Extract<Lookup, { kind: "symbol" }>;
    return { status: "bound", targets: ids, tier: f.tier, via: f.via, note: f.tier === "certain" ? `the ${what} is the method value ${show(e)} of ${t.path.join(".")}` : (f.note ?? `the type's binding is ${f.tier}`), why: null };
  };
  // A type used as a handler (`T{}`, `&pkg.T{}`): its ServeHTTP method.
  const servesType = (file: string, e: Extract<Expr, { t: "lit" }>): Res => {
    if (!e.type) return fail("dynamic", "dynamic", "the handler is a literal of an unnamed type", null, e);
    const tn = typeNode(file, e.type);
    if (!("node" in tn)) return tn.found.kind === "symbol" ? fail("unresolved", "unsupported-rule", `${e.type.join(".")} is not a type declared in the repository`, show(e), e) : fromLookup(tn.found, e, "handler");
    const ids = methodsOn(tn.node, "ServeHTTP");
    if (ids.length === 0) {
      return embeds(tn.node)
        ? fail("unresolved", "unsupported-rule", `${e.type.join(".")} declares no ServeHTTP method of its own; one promoted from an embedded field is not followed`, show(e), e)
        : fail("missing", "miss", `${e.type.join(".")} declares no ServeHTTP method in its package`, show(e), e);
    }
    const m = index.node(ids[0] as string);
    const fact = m ? fileIndex(m.file).serveHttp.get(`${tn.node.name}\0${m.startLine}`) : undefined;
    const recv = fact ? ` (${fact.pointer ? "pointer" : "value"} receiver)` : "";
    const f = tn.found as Extract<Lookup, { kind: "symbol" }>;
    return { status: "bound", targets: ids, tier: f.tier, via: f.via, note: f.tier === "certain" ? `served through ${tn.node.name}.ServeHTTP${recv}` : (f.note ?? `the type's binding is ${f.tier}`), why: null };
  };

  // A name used as a handler or a function value.
  const bindRef = (file: string, e: Extract<Expr, { t: "ref" }>, scopes: readonly number[], line: number, isFunc: boolean, steps: number): Res | { follow: Decl } => {
    const what = isFunc ? "handler function" : "handler";
    if (isPkg(file, { ...e, path: e.path.slice(0, 1) }, "http", null)) return fail("external", "external", `${show(e)} is a handler of the standard library`, show(e), e);
    const symbol = e.local ? null : lookup(file, e.path);
    if (symbol?.kind === "symbol") return fromLookup(symbol, e, what);
    const found = declPath(file, e.path, e.local, scopes, line, false);
    if (found && found.rest.length === 0 && found.decl.kind === "value" && steps < MAX_VALUE_STEPS) return { follow: found.decl };
    if (found && found.rest.length === 1) return methodValue(found.decl, found.rest[0] as string, e, what);
    if (found || e.local) return fail("dynamic", "dynamic", `the ${what} ${show(e)} is a value the code computes, not a definition`, show(e), e);
    return fromLookup(symbol ?? { kind: "none" }, e, what);
  };

  // What a call used as a handler is: a wrapper of the repository (a
  // function that takes a handler and returns one), with the position of the
  // handler it takes, or null.
  const wrappers = new Map<string, { arg: number; func: boolean } | null>();
  const handlerParam = (id: string): { arg: number; func: boolean } | null => {
    if (wrappers.has(id)) return wrappers.get(id) ?? null;
    const node = index.node(id);
    let found: { arg: number; func: boolean } | null = null;
    if (node) {
      const http = identity(node.file).http;
      const param = (fileIndex(node.file).paramsOf.get(node.startLine) ?? []).find((p) => p.index >= 0 && (p.func || (p.type.length === 2 && http.has(p.type[0] as string) && (p.type[1] === "Handler" || p.type[1] === "HandlerFunc"))));
      if (param) found = { arg: param.index, func: param.func || param.type[1] === "HandlerFunc" };
    }
    wrappers.set(id, found);
    return found;
  };
  const callees = new Map<string, Res>();
  const wrapperOf = (file: string, call: Extract<Expr, { t: "call" }>, scopes: readonly number[], line: number): { res: Res; arg: number; func: boolean } | null => {
    const fn = call.fn;
    if (fn.t !== "ref") return null;
    let res: Res;
    if (fn.local) {
      const found = declPath(file, fn.path, true, scopes, line, false);
      if (!found || found.rest.length !== 1) return null;
      res = methodValue(found.decl, found.rest[0] as string, fn, "middleware");
    } else {
      // A wrapper named at the top of a file binds the same way at every call.
      const k = `${file}\0${fn.path.join(".")}`;
      res = callees.get(k) ?? fromLookup(lookup(file, fn.path), fn, "middleware");
      callees.set(k, res);
    }
    if (res.status !== "bound") return null;
    const p = handlerParam(res.targets[0] as string);
    return p ? { res, ...p } : null;
  };

  const bind = (file: string, e: Expr, scopes: readonly number[], line: number, isFunc: boolean, steps: number): Bound => {
    const wrappers: Wrapper[] = [];
    let wrapCut = false;
    let strip: string | null | undefined;
    let cur = e;
    let fnValue = isFunc;
    const done = (r: Res, mount: Bound["mount"] = null): Bound => ({ ...r, wrappers, wrapCut, mount });
    for (let guard = 0; cur.t === "call" && guard <= MAX_EXPR_DEPTH; guard++) {
      const call: Extract<Expr, { t: "call" }> = cur;
      const fn = call.fn;
      if (fn.t === "ref" && !fn.local && fn.path.length === 2 && identity(file).http.has(fn.path[0] as string)) {
        const name = fn.path[1] as string;
        if (name === "HandlerFunc" && !fnValue && call.args.length === 1) {
          cur = call.args[0] as Expr;
          fnValue = true;
          continue;
        }
        if (name === "StripPrefix" && !fnValue && call.args.length === 2) {
          const p = evaluate(call.args[0] as Expr, constantOf(file));
          strip = strip === null || p === null ? null : `${strip ?? ""}${p}`;
          cur = call.args[1] as Expr;
          continue;
        }
        if (STDLIB_WRAPPERS.has(name) && !fnValue && call.args.length >= 1) {
          cur = call.args[0] as Expr;
          continue;
        }
        return done(fail("external", "external", `the handler is ${show(call)}, which the standard library builds`, show(call), call));
      }
      const w = wrapperOf(file, call, scopes, line);
      if (!w) {
        return done(
          wrappers.length > 0
            ? fail("unresolved", "unsupported-rule", `the handler is the value ${show(e)} returns; whether the wrappers call ${show(call)} is not proved, so the handler is not bound`, show(call), e)
            : fail("unresolved", "unsupported-rule", `the handler is the value ${show(call)} returns; no rule reads what it returns`, show(call), call),
        );
      }
      if (wrappers.length < MAX_MIDDLEWARE_CHAIN) wrappers.push({ targets: w.res.targets, tier: w.res.tier, via: w.res.via, note: w.res.note });
      else wrapCut = true;
      cur = call.args[w.arg] ?? { t: "other", line: call.line, column: call.column };
      fnValue = w.func;
    }
    if (wrappers.length > 0) {
      const outer = show(e.t === "call" ? e.fn : e);
      return done(fail("unresolved", "unsupported-rule", `the handler is the value ${show(e)} returns; whether ${outer} calls ${show(cur)} is not proved, so the handler is not bound`, show(cur), e));
    }
    switch (cur.t) {
      case "fn":
        return done(fail("unresolved", "unsupported-rule", "the handler is an inline function, which has no symbol of its own; the calls it makes are counted under the code around it", null, cur));
      case "lit":
        return fnValue ? done(fail("dynamic", "dynamic", `the handler ${show(cur)} is not a function`, show(cur), cur)) : done(servesType(file, cur));
      case "ref": {
        if (!fnValue) {
          const m = muxOfRef(file, cur, scopes, line, false, null, 0);
          if (m?.kind === "mux") return done({ status: "bound", targets: [], tier: "certain", via: null, note: null, why: null }, { mux: m, strip });
          if (m?.kind === "param") return done(fail("dynamic", "dynamic", `the handler is the parameter ${m.name} (${m.type}), a mux the caller passes`, m.name, cur));
        }
        const r = bindRef(file, cur, scopes, line, fnValue, steps);
        if ("follow" in r) {
          const d = r.follow as Extract<Decl, { kind: "value" }>;
          const inner = bind(d.file, d.fact.value, d.fact.scopes, d.fact.line, fnValue, steps + 1);
          return { ...inner, wrappers: [...wrappers, ...inner.wrappers], wrapCut: wrapCut || inner.wrapCut };
        }
        return done(r);
      }
      default:
        return done(fail("dynamic", "dynamic", `the handler is computed (${show(cur)})`, null, cur));
    }
  };
  const bound = new Map<Event, Bound>();
  const boundOf = (e: Event): Bound => {
    let b = bound.get(e);
    if (!b) {
      b = bind(e.file, e.handler, e.scopes, e.site.line, e.prop === "HandleFunc", 0);
      bound.set(e, b);
    }
    return b;
  };

  // ---------- patterns ----------
  const roleSeen = new Set<string>();
  const addRole = (target: string, role: "route_handler" | "middleware" | "test", detail: string, app: string | null, evidence: FrameworkEvidence) => {
    const k = `${target}\0${role}`;
    if (roleSeen.has(k)) return;
    roleSeen.add(k);
    roles.push({ target, role, detail, app, evidence });
  };
  const edgeSeen = new Set<string>();
  const addEdge = (e: FrameworkEdge): boolean => {
    const k = `${e.kind}\0${e.app ?? ""}\0${e.from}\0${e.to}\0${siteKey(e.evidence.site)}\0${e.order ?? ""}`;
    if (edgeSeen.has(k)) return false;
    edgeSeen.add(k);
    edges.push(e);
    return true;
  };

  // A route that is not a registration: its own pattern is computed.
  const computedPattern = (e: Event) =>
    gap({
      plugin: PLUGIN,
      site: e.site,
      scope: { file: e.file },
      affects: ["handles"],
      cause: "dynamic",
      name: show(e.handler),
      note: `the route pattern ${show(e.pattern)} is computed at run time, so this call is not listed as a registration; its handler is ${show(e.handler)}`,
      count: null,
      exact: false,
    });

  // The handles edge, the handler's unknown and the middleware chain of one registration.
  const attach = (reg: Registration, e: Event, b: Bound) => {
    const app = reg.app;
    if (b.why) gap({ plugin: PLUGIN, site: { file: e.file, line: b.why.at.line, column: b.why.at.column }, scope: { file: e.file }, affects: ["handles"], cause: b.why.cause, name: b.why.name, note: b.why.note, count: null, exact: false });
    for (const t of b.targets) {
      const ev: FrameworkEvidence = { kind: "route-call", tier: b.tier, site: e.site, via: b.via, premises: [], rule: rule("go-http-route"), note: b.note };
      addEdge({ from: reg.id, to: t, kind: "handles", plugin: PLUGIN, app, evidence: ev });
      addRole(t, "route_handler", "net/http", app, ev);
    }
    b.wrappers.forEach((w, order) => {
      for (const t of w.targets) {
        if (used.middleware >= MAX_MIDDLEWARE_EDGES) {
          stop("middleware", "fan-out-capped", e.site, ["applies_middleware"], `the plugin stopped adding middleware edges after ${MAX_MIDDLEWARE_EDGES} in this build`);
          return;
        }
        const ev: FrameworkEvidence = { kind: "route-call", tier: w.tier, site: e.site, via: w.via, premises: [], rule: rule("go-http-middleware"), note: w.note };
        if (addEdge({ from: reg.id, to: t, kind: "applies_middleware", plugin: PLUGIN, app, evidence: ev, order })) used.middleware++;
        addRole(t, "middleware", "net/http", app, ev);
      }
    });
    if (b.wrapCut) {
      gap({ plugin: PLUGIN, site: e.site, scope: { file: e.file }, affects: ["applies_middleware"], cause: "fan-out-capped", name: show(e.handler), note: `the handler is wrapped in more than ${MAX_MIDDLEWARE_CHAIN} middleware calls; the middleware past the first ${MAX_MIDDLEWARE_CHAIN} is not listed`, count: null, exact: false });
    }
  };

  const takeRegistration = (site: Site): boolean => {
    if (used.registrations >= MAX_REGISTRATIONS) {
      stop("registrations", "fan-out-capped", site, ["handles"], `the plugin stopped listing registrations after ${MAX_REGISTRATIONS} in this build; the routes past that are not listed`);
      return false;
    }
    used.registrations++;
    return true;
  };

  // ---------- composition: every route each mux serves ----------
  type Ctx = { app: Mux; prefix: string | null; host: string; methods: string[] | null; within: string[]; via: Site[]; stack: string[]; depth: number };
  const compose = (mux: Mux, ctx: Ctx) => {
    for (const e of events.get(mux.id) ?? []) {
      if (used.steps >= MAX_COMPOSE_STEPS) {
        stop("steps", "budget", e.site, ["handles", "mounts"], `the plugin stopped composing muxes after ${MAX_COMPOSE_STEPS} steps in this build`);
        return;
      }
      used.steps++;
      if (stopped.has("registrations") && stopped.has("mounts")) return;
      // Once registrations stop, only a Handle call can still mount a mux.
      if (stopped.has("registrations") && e.prop === "HandleFunc") continue;
      const written = evaluate(e.pattern, constantOf(e.file));
      if (written === null) {
        computedPattern(e);
        continue;
      }
      const own = parsePattern(written);
      const methods = meet(ctx.methods, own.methods);
      if (methods.length === 0) continue;
      const path = ctx.prefix === null ? null : join(ctx.prefix, own.path);
      if (path !== null && !ctx.within.every((w) => under(w, path))) continue;
      const host = ctx.host !== "" ? ctx.host : own.host;
      const b = boundOf(e);
      if (b.mount) {
        const sub = b.mount.mux;
        if (ctx.stack.includes(sub.id)) continue; // a loop: stop there, never repeat it
        if (ctx.depth >= MAX_MOUNT_DEPTH) {
          stop("depth", "fan-out-capped", e.site, ["mounts", "handles"], `muxes mounted more than ${MAX_MOUNT_DEPTH} levels deep are not followed`);
          continue;
        }
        if (used.mounts >= MAX_MOUNTS) {
          stop("mounts", "fan-out-capped", e.site, ["mounts", "handles"], `the plugin stopped following mounted muxes after ${MAX_MOUNTS} in this build`);
          continue;
        }
        used.mounts++;
        addEdge({ from: mux.id, to: sub.id, kind: "mounts", plugin: PLUGIN, app: ctx.app.id, evidence: { kind: "mount", tier: "certain", site: e.site, via: null, premises: [], rule: rule("go-http-mount"), note: b.mount.strip ? `the prefix ${b.mount.strip} is stripped before ${sub.name} routes the request` : null } });
        const strip = b.mount.strip;
        if (strip === null) gap({ plugin: PLUGIN, site: e.site, scope: { file: e.file }, affects: ["mounts", "handles"], cause: "dynamic", name: show(e.handler), note: "the prefix http.StripPrefix removes is computed at run time, so the routes under it have no known pattern", count: null, exact: false });
        const prefix = ctx.prefix === null || strip === null ? null : strip === undefined ? ctx.prefix : join(ctx.prefix, strip);
        compose(sub, { app: ctx.app, prefix, host, methods, within: path === null ? ctx.within : [...ctx.within, path], via: [...ctx.via, e.site], stack: [...ctx.stack, sub.id], depth: ctx.depth + 1 });
        continue;
      }
      if (!takeRegistration(e.site)) continue;
      const key = `${siteKey(e.site)}${ctx.via.map((s) => `@${siteKey(s)}`).join("")}`;
      const reg: Registration = {
        kind: "registration",
        id: entityId(PLUGIN, ctx.app.id, "registration", key),
        plugin: PLUGIN,
        app: ctx.app.id,
        methods,
        pattern: path === null ? null : host + path,
        written: own.host + own.path,
        name: null,
        site: e.site,
        mountedVia: ctx.via,
        mounted: true,
        handler: { written: show(e.handler), status: b.status, targets: b.targets },
      };
      registrations.push(reg);
      attach(reg, e, b);
    }
  };

  const apps = [...muxes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const m of apps) compose(m, { app: m, prefix: "", host: "", methods: null, within: [], via: [], stack: [m.id], depth: 0 });

  // Routes on a parameter typed as a mux: kept, with no application.
  for (const { param, event: e } of paramEvents) {
    const written = evaluate(e.pattern, constantOf(e.file));
    if (written === null) {
      computedPattern(e);
      continue;
    }
    const b = boundOf(e);
    if (b.mount || !takeRegistration(e.site)) continue;
    const own = parsePattern(written);
    const reg: Registration = {
      kind: "registration",
      id: entityId(PLUGIN, null, "registration", siteKey(e.site)),
      plugin: PLUGIN,
      app: null,
      methods: own.methods,
      pattern: own.host + own.path,
      written: own.host + own.path,
      name: null,
      site: e.site,
      mountedVia: [],
      mounted: false,
      handler: { written: show(e.handler), status: b.status, targets: b.targets },
    };
    registrations.push(reg);
    gap({ plugin: PLUGIN, site: e.site, scope: { file: e.file }, affects: ["handles", "mounts"], cause: "dynamic", name: param.name, note: `the route is registered on the parameter ${param.name} (${param.type}); which mux it lands on, and under which prefix, is decided by the caller`, count: null, exact: false });
    attach(reg, e, b);
  }

  // ---------- applications ----------
  const detections: Detection[] = apps.map((m) => ({
    id: m.id,
    name: m.dflt ? `http.DefaultServeMux (${m.file})` : `${m.name} (${m.file})`,
    project: m.project,
    root: m.project,
    site: { file: m.file, line: m.line, column: m.column },
    evidence: [
      m.dflt
        ? { file: m.first?.file ?? m.file, line: m.first?.line ?? 1, note: "registers on the default mux through net/http" }
        : { file: m.file, line: m.line, note: "made by net/http's NewServeMux" },
      ...m.served.map((s) => ({ file: s.file, line: s.line, note: "served here" })),
    ],
    version: null,
    data: { served: m.served.length > 0 },
  }));
  const appById = new Map(detections.map((d) => [d.id, d]));
  const httpProjects = new Set<string>([...detections.map((d) => d.project), ...registrations.map((r) => index.projectOf(r.site.file))]);

  // ---------- tests ----------
  const testFile = (file: string) => file.endsWith("_test.go");
  const byProject = new Map<string, Registration[]>();
  for (const r of registrations) {
    if (r.app === null || r.pattern === null) continue;
    const p = appById.get(r.app)?.project ?? index.projectOf(r.site.file);
    (byProject.get(p) ?? byProject.set(p, []).get(p))?.push(r);
  }
  const meter = { steps: 0 };
  const split = new Map<Registration, { host: string; segs: string[] | null }>();
  const splitOf = (reg: Registration) => {
    let s = split.get(reg);
    if (!s) {
      s = splitPattern(reg.pattern as string);
      split.set(reg, s);
    }
    return s;
  };
  requests: for (const file of files) {
    if (!testFile(file)) continue;
    for (const f of of(file, "call")) {
      if ((f.prop !== "NewRequest" && f.prop !== "NewRequestWithContext") || !isPkg(file, f.recv, "httptest", null)) continue;
      const site: Site = { file, line: f.line, column: f.column };
      if (used.requests >= MAX_TEST_REQUESTS) {
        stop("requests", "fan-out-capped", site, ["tests"], `the plugin stopped matching test requests after ${MAX_TEST_REQUESTS} in this build`);
        break requests;
      }
      used.requests++;
      const at = f.prop === "NewRequest" ? 0 : 1;
      const mArg = f.args[at];
      const tArg = f.args[at + 1];
      if (!mArg || !tArg) continue;
      const method = mArg.t === "ref" && !mArg.local && mArg.path.length === 2 && identity(file).http.has(mArg.path[0] as string) ? (METHOD_CONSTANTS[mArg.path[1] as string] ?? null) : evaluate(mArg, constantOf(file));
      const target = evaluate(tArg, constantOf(file));
      if (method === null || target === null) {
        gap({ plugin: PLUGIN, site, scope: { file }, affects: ["tests"], cause: "dynamic", name: show(method === null ? mArg : tArg), note: `the test builds a request with a computed ${method === null ? "method" : "path"} (${show(method === null ? mArg : tArg)}), so the route it reaches is not known`, count: null, exact: false });
        continue;
      }
      const req = requestTarget(target);
      const verb = method === "" ? "GET" : method.toUpperCase();
      const hits: Registration[] = [];
      const xs = segments(req.path);
      for (const reg of xs ? (byProject.get(index.projectOf(file)) ?? []) : []) {
        if (meter.steps >= MAX_MATCH_WORK) break;
        meter.steps++;
        if (!reg.methods.includes("*") && !reg.methods.includes(verb) && !(verb === "HEAD" && reg.methods.includes("GET"))) continue;
        const p = splitOf(reg);
        if (p.segs && (p.host === "" || p.host === req.host) && matchSegments(p.segs, xs as string[], meter)) hits.push(reg);
      }
      if (meter.steps >= MAX_MATCH_WORK) {
        stop("match", "budget", site, ["tests"], `the plugin stopped matching test requests to routes after ${MAX_MATCH_WORK} pattern steps in this build`);
        break requests;
      }
      const appsHit = new Set(hits.map((r) => r.app));
      const from = index.enclosing(file, f.line)?.id ?? file;
      for (const reg of hits) {
        const app = appById.get(reg.app as string);
        const several = appsHit.size > 1;
        if (used.testLinks >= MAX_TEST_LINKS) {
          stop("testLinks", "fan-out-capped", site, ["tests"], `the plugin stopped adding test links after ${MAX_TEST_LINKS} in this build`);
          break requests;
        }
        used.testLinks++;
        addEdge({
          from,
          to: reg.id,
          kind: "tests",
          plugin: PLUGIN,
          app: reg.app,
          category: "route-request",
          evidence: {
            kind: "test-route-request",
            tier: several ? "possible" : "likely",
            site,
            via: null,
            premises: [reg.id],
            rule: rule("go-http-test-request"),
            note: several
              ? `the test requests ${verb} ${req.path}, which routes on ${appsHit.size} muxes of this project match, and the test does not say which mux serves it`
              : `the test requests ${verb} ${req.path}, which this route's pattern ${reg.pattern} on ${app?.name ?? "its mux"} matches`,
          },
        });
      }
    }
  }
  // Test functions, in the projects that serve net/http.
  for (const file of files) {
    if (!testFile(file) || !httpProjects.has(index.projectOf(file))) continue;
    const testing = identity(file).testing;
    for (const f of of(file, "test-func")) {
      if (f.param.length !== 2 || !testing.has(f.param[0] as string) || f.param[1] !== "T" || !isTestName(f.name)) continue;
      const sym = index.symbols(file).find((n) => n.kind === "function" && n.name === f.name && n.startLine === f.line);
      if (!sym) continue;
      addRole(sym.id, "test", "go test", null, { kind: "role-path", tier: "certain", site: { file, line: f.line, column: f.column }, via: null, premises: [], rule: rule("go-http-test-function"), note: null });
    }
  }

  // ---------- files not read ----------
  for (const file of files) {
    for (const f of index.factsOf(file)) {
      if (f.kind === "too-large") {
        unknowns.push({ plugin: PLUGIN, site: { file, line: 1, column: 1 }, scope: { file }, affects: ["handles", "mounts", "applies_middleware"], cause: "file-not-parsed", name: null, note: `the file is ${f.bytes} bytes, over the ${MAX_SOURCE_BYTES} byte cap of the net/http plugin, so its routes were not read`, count: null, exact: false });
      } else if (f.kind === "parse-error") {
        unknowns.push({ plugin: PLUGIN, site: { file, line: 1, column: 1 }, scope: { file }, affects: ["handles", "mounts", "applies_middleware"], cause: "file-not-parsed", name: null, note: "the file has a syntax error; calls inside the broken regions were not read", count: null, exact: false });
      }
    }
  }

  return { apps: detections, output: { roles, entities: registrations, edges, unknowns } };
}

// Go's rule for a test function's name: Test, then nothing or a character that is not a lower-case letter.
function isTestName(name: string): boolean {
  if (!name.startsWith("Test")) return false;
  const next = name[4];
  return next === undefined || !(next >= "a" && next <= "z");
}

// A Go 1.22 pattern: `[METHOD ][HOST]/[PATH]`. No method takes any.
export function parsePattern(written: string): { methods: string[]; host: string; path: string } {
  let rest = written;
  let method = "*";
  let sp = -1;
  for (let i = 0; i < written.length && sp < 0; i++) if (written[i] === " " || written[i] === "\t") sp = i;
  if (sp >= 0) {
    method = written.slice(0, sp);
    rest = written.slice(sp).trimStart();
  }
  const slash = rest.indexOf("/");
  return slash < 0 ? { methods: [method], host: "", path: rest } : { methods: [method], host: rest.slice(0, slash), path: rest.slice(slash) };
}

// The methods a route keeps under a mount that takes only some.
function meet(outer: string[] | null, own: string[]): string[] {
  if (outer === null || outer.includes("*")) return own;
  if (own.includes("*")) return outer;
  return own.filter((m) => outer.includes(m));
}

// A prefix and a path, with one slash between them.
function join(prefix: string, path: string): string {
  if (prefix === "") return path;
  const p = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return path.startsWith("/") ? `${p}${path}` : `${p}/${path}`;
}

// Whether a composed path lies under a mount's own path: its subtree when
// the mount path ends in a slash, else the path itself. A mount path with a
// wildcard is not compared.
function under(mount: string, path: string): boolean {
  if (mount.includes("{")) return true;
  return mount.endsWith("/") ? path.startsWith(mount) : path === mount;
}

// The host and path an httptest request is made for: a path, or an absolute
// URL; httptest uses example.com when the target names no host.
function requestTarget(target: string): { host: string; path: string } {
  let host = "example.com";
  let rest = target;
  for (const scheme of ["http://", "https://"]) {
    if (!target.startsWith(scheme)) continue;
    const after = target.slice(scheme.length);
    const slash = after.indexOf("/");
    host = slash < 0 ? after : after.slice(0, slash);
    rest = slash < 0 ? "/" : after.slice(slash);
  }
  for (const stop of ["?", "#"]) {
    const i = rest.indexOf(stop);
    if (i >= 0) rest = rest.slice(0, i);
  }
  return { host, path: rest === "" ? "/" : rest };
}

// The segments after a path's leading slash, or null past MAX_PATTERN_SEGMENTS.
function segments(path: string): string[] | null {
  if (!path.startsWith("/")) return null;
  const parts = path.slice(1).split("/", MAX_PATTERN_SEGMENTS + 1);
  return parts.length > MAX_PATTERN_SEGMENTS ? null : parts;
}

// A composed pattern's host and path segments; no segments past the cap.
function splitPattern(pattern: string): { host: string; segs: string[] | null } {
  const slash = pattern.indexOf("/");
  return slash < 0 ? { host: "", segs: null } : { host: pattern.slice(0, slash), segs: segments(pattern.slice(slash)) };
}

// Whether a request matches a composed Go pattern (`[HOST]/[PATH]`), by Go's
// rules, one segment at a time with no regular expression: `{name}` takes one
// non-empty segment, a last `{name...}` takes the rest, a trailing slash
// takes the subtree below it, `{$}` only the path that ends there. A pattern
// or path of more than MAX_PATTERN_SEGMENTS segments matches nothing.
// `meter` counts the segments compared.
export function matches(pattern: string, path: string, host = "example.com", meter?: { steps: number }): boolean {
  const p = splitPattern(pattern);
  const xs = segments(path);
  if (!p.segs || !xs || (p.host !== "" && p.host !== host)) return false;
  return matchSegments(p.segs, xs, meter);
}

function matchSegments(ps: readonly string[], xs: readonly string[], meter?: { steps: number }): boolean {
  for (let i = 0; i < ps.length; i++) {
    if (meter) meter.steps++;
    const seg = ps[i] as string;
    const last = i === ps.length - 1;
    if (last && seg === "") return xs.length > i;
    if (seg === "{$}") return last && xs.length === i + 1 && xs[i] === "";
    const wild = seg.startsWith("{") && seg.endsWith("}");
    if (wild && seg.endsWith("...}")) return last && xs.length > i;
    if (i >= xs.length) return false;
    if (wild) {
      if (xs[i] === "") return false;
      continue;
    }
    if (seg !== xs[i]) return false;
  }
  return xs.length === ps.length;
}
