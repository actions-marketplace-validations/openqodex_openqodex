// Turns every file's local facts into a graph. A call becomes an edge only
// with evidence: a definition in the same file or Go package, an import that
// names it, a receiver whose type a constructor or an annotation gives, or
// (Ruby) a constant found by the autoload convention. A method call is never
// matched by its name alone. Every call site is kept on its edge.
//
// Everything here is maps keyed by name or path: no step scans every file
// for every call, so resolution stays linear in the number of call sites.
import { dirname, posix } from "node:path";
import type { ImpactKind } from "@openqodex/core";
import type { BoundImport, CallFact, DefFact, Family, FileFacts, GraphEdge, GraphNode, GraphSite, Miss, TypeRef } from "./types.js";
import { familyOf } from "./types.js";

const MAX_DEPTH = 8; // re-export and base-class chains
export const HUB_FILES = 8; // a name defined in more files never binds without evidence

const BUILTINS: Record<Family, ReadonlySet<string>> = {
  js: new Set(
    "require console setTimeout setInterval clearTimeout clearInterval setImmediate parseInt parseFloat isNaN isFinite String Number Boolean Array Object Promise Symbol Error TypeError RangeError SyntaxError Map Set WeakMap WeakSet Date RegExp JSON Math Reflect Proxy BigInt encodeURIComponent decodeURIComponent encodeURI decodeURI structuredClone fetch queueMicrotask describe it test expect beforeEach afterEach beforeAll afterAll jest vi process Buffer URL URLSearchParams TextEncoder TextDecoder AbortController Uint8Array ArrayBuffer Intl globalThis window document".split(
      " ",
    ),
  ),
  python: new Set(
    "print len range str int float bool list dict set tuple isinstance issubclass super getattr setattr hasattr delattr type open repr sorted enumerate zip map filter any all min max sum abs iter next id hash callable format vars round object Exception ValueError TypeError KeyError IndexError RuntimeError NotImplementedError AttributeError ImportError OSError StopIteration AssertionError staticmethod classmethod property divmod chr ord bytes bytearray frozenset globals locals dir input reversed slice memoryview complex pow hex oct bin compile eval exec breakpoint ascii".split(
      " ",
    ),
  ),
  go: new Set(
    "append cap clear close complex copy delete imag len make max min new panic print println real recover string int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 uintptr float32 float64 byte rune bool error any complex64 complex128".split(
      " ",
    ),
  ),
  ruby: new Set(
    "puts print p pp require require_relative raise fail lambda proc loop attr_accessor attr_reader attr_writer private protected public module_function include extend prepend new freeze format sprintf block_given? yield define_method send public_send respond_to? is_a? kind_of? instance_of? nil? to_s to_i to_f to_a to_h to_sym each map select reject find each_with_object inject reduce tap then dup clone catch throw sleep rand srand gets binding caller exit abort at_exit Integer Float String Array Hash Rational Complex".split(
      " ",
    ),
  ),
};

export type FileInput = { path: string; facts: FileFacts };

// What a name or an expression stands for.
type Value =
  | { v: "sym"; ids: string[] }
  | { v: "mod"; file: string }
  | { v: "pkg"; dir: string }
  | { v: "pymod"; from: string; dotted: string } // Python `import a.b`: a dotted module path
  | { v: "ext" }
  | { v: "miss"; target: string; name: string };

type Def = DefFact & { id: string; file: string; family: Family };

type ClassInfo = { file: string; family: Family; ids: string[]; bases: TypeRef[]; fields: Map<string, TypeRef>; nesting: string | null };

export type TsPaths = { baseDir: string; paths: [string, string[]][]; baseUrl: string | null } | null;

export type ResolveInput = {
  files: FileInput[];
  known: ReadonlySet<string>; // every path import resolution may land on: eligible files and removed ones
  tsPaths: TsPaths;
  goModules: [string, string][]; // module path, folder ("" for the root)
};

export type Resolved = {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  importers: Map<string, GraphEdge[]>;
  defsByFile: Map<string, GraphNode[]>;
  misses: Miss[];
  unresolvedSites: number;
};

export function symbolId(file: string, d: Pick<DefFact, "owner" | "name" | "line" | "column">): string {
  return `${file}#${d.owner ? `${d.owner}.` : ""}${d.name}@${d.line}:${d.column}`;
}

function dirOf(path: string): string {
  const d = dirname(path);
  return d === "." ? "" : d;
}

function join(...parts: string[]): string {
  const j = posix.normalize(posix.join(...parts.filter((p) => p !== "")));
  return j === "." ? "" : j;
}

const JS_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

export function resolveGraph(input: ResolveInput): Resolved {
  const facts = new Map<string, FileFacts>();
  for (const f of input.files) facts.set(f.path, f.facts);

  const nodes = new Map<string, GraphNode>();
  const defsByFile = new Map<string, GraphNode[]>();
  const defById = new Map<string, Def>();
  const topByFile = new Map<string, Map<string, string[]>>();
  const pkgTop = new Map<string, Map<string, string[]>>(); // Go package (folder, or folder#test) to name to ids
  const pkgName = new Map<string, string>(); // Go folder to package name
  const classes = new Map<string, ClassInfo>();
  const classOfId = new Map<string, string>();
  const methods = new Map<string, Map<string, string[]>>();
  const rbTop = new Map<string, string[]>(); // Ruby methods outside any class
  const filesByName = new Map<string, Set<string>>(); // family:name to defining files

  const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
  };
  const nameIndex = (m: Map<string, Map<string, string[]>>, k: string) => {
    let inner = m.get(k);
    if (!inner) {
      inner = new Map();
      m.set(k, inner);
    }
    return inner;
  };

  // A Go package is its folder; an external test package (`package x_test`)
  // in the same folder is a package of its own.
  const pkgOf = (file: string): string => {
    const pkg = facts.get(file)?.goPackage;
    return pkg?.endsWith("_test") ? `${dirOf(file)}#test` : dirOf(file);
  };

  const classKey = (family: Family, file: string, qualified: string) => {
    if (family === "ruby") return `rb::${qualified}`;
    if (family === "go") return `go:${pkgOf(file)}::${qualified}`;
    return `${file}::${qualified}`;
  };
  // Methods called on the class itself ("s") and on an instance ("i") are
  // indexed apart; Python methods are reachable both ways.
  type Side = "s" | "i";
  const sideKey = (key: string, side: Side) => `${key}\u0000${side}`;

  // ---------- index the definitions ----------
  for (const { path, facts: f } of input.files) {
    const family = familyOf(f.lang);
    const lineCount = f.defs.reduce((m, d) => Math.max(m, d.endLine), 1);
    nodes.set(path, { id: path, file: path, name: posix.basename(path), kind: "file", startLine: 1, endLine: lineCount, snapshot: "current", exported: true, lang: f.lang });
    if (family === "go" && f.goPackage && !f.goPackage.endsWith("_test") && !pkgName.has(dirOf(path))) pkgName.set(dirOf(path), f.goPackage);
    const list: GraphNode[] = [];
    for (const d of f.defs) {
      const id = symbolId(path, d);
      const node: GraphNode = { id, file: path, name: d.name, kind: d.kind as ImpactKind, startLine: d.line, endLine: d.endLine, snapshot: "current", exported: d.exported, lang: f.lang };
      nodes.set(id, node);
      list.push(node);
      defById.set(id, { ...d, id, file: path, family });
      let names = filesByName.get(`${family}:${d.name}`);
      if (!names) filesByName.set(`${family}:${d.name}`, (names = new Set()));
      names.add(path);
      if (d.kind === "method") {
        const key = classKey(family, path, d.owner ?? "");
        if (family === "python" || d.static) push(nameIndex(methods, sideKey(key, "s")), d.name, id);
        if (family === "python" || !d.static) push(nameIndex(methods, sideKey(key, "i")), d.name, id);
      } else if (family === "go") {
        if (d.topLevel) push(nameIndex(pkgTop, pkgOf(path)), d.name, id);
      } else if (family === "ruby" && d.kind === "function") {
        push(rbTop, d.name, id);
      } else if (d.topLevel) {
        push(nameIndex(topByFile, path), d.name, id);
      }
      // A nested definition is reached only through the scopes that declare it (CallFact.local).
      if (d.kind === "class" || d.kind === "module" || d.kind === "type") {
        const qualified = family === "ruby" && d.owner ? `${d.owner}::${d.name}` : d.name;
        const key = classKey(family, path, qualified);
        classOfId.set(id, key);
        let info = classes.get(key);
        if (!info) {
          info = { file: path, family, ids: [], bases: [], fields: new Map(), nesting: d.owner };
          classes.set(key, info);
        }
        info.ids.push(id);
        info.bases.push(...d.bases);
        for (const [k, t] of Object.entries(d.fields)) info.fields.set(k, t);
      }
    }
    defsByFile.set(path, list);
  }

  // ---------- module resolution ----------
  const known = input.known;
  const jsCandidates = (base: string): string | null => {
    if (known.has(base)) return base;
    const swapped = base.replace(/\.(m|c)?jsx?$/, (_m, k: string | undefined) => `.${k ?? ""}ts`);
    if (swapped !== base) {
      if (known.has(swapped)) return swapped;
      if (known.has(`${swapped}x`)) return `${swapped}x`;
    }
    for (const ext of JS_EXTS) if (known.has(base + ext)) return base + ext;
    for (const ext of JS_EXTS) if (known.has(`${base}/index${ext}`)) return `${base}/index${ext}`;
    return null;
  };
  const jsSpec = (from: string, spec: string): string | "ext" | null => {
    if (spec.startsWith(".")) return jsCandidates(join(dirOf(from), spec));
    const ts = input.tsPaths;
    if (ts) {
      let best: { target: string[]; rest: string; len: number } | null = null;
      for (const [pattern, targets] of ts.paths) {
        const star = pattern.indexOf("*");
        if (star === -1) {
          if (pattern === spec && (!best || pattern.length > best.len)) best = { target: targets, rest: "", len: pattern.length };
        } else {
          const pre = pattern.slice(0, star);
          const post = pattern.slice(star + 1);
          if (spec.startsWith(pre) && spec.endsWith(post) && spec.length >= pre.length + post.length && (!best || pre.length > best.len)) {
            best = { target: targets, rest: spec.slice(pre.length, spec.length - post.length), len: pre.length };
          }
        }
      }
      if (best) {
        for (const t of best.target) {
          const hit = jsCandidates(join(ts.baseDir, t.replace("*", best.rest)));
          if (hit) return hit;
        }
      }
      if (ts.baseUrl !== null) {
        const hit = jsCandidates(join(ts.baseUrl, spec));
        if (hit) return hit;
      }
    }
    return "ext";
  };
  const pyRoots = new Map<string, string[]>();
  const pySourceRoots = (from: string): string[] => {
    const dir = dirOf(from);
    let roots = pyRoots.get(dir);
    if (roots) return roots;
    roots = [];
    let d = dir;
    for (;;) {
      if (!known.has(join(d, "__init__.py"))) roots.push(d);
      if (d === "") break;
      d = dirOf(d);
    }
    pyRoots.set(dir, roots);
    return roots;
  };
  const pyModule = (base: string): string | null => {
    if (known.has(`${base}.py`)) return `${base}.py`;
    if (known.has(join(base, "__init__.py"))) return join(base, "__init__.py");
    return null;
  };
  const pySpec = (from: string, spec: string): string | "ext" | null => {
    const dots = /^\.*/.exec(spec)?.[0].length ?? 0;
    const rest = spec.slice(dots).split(".").filter(Boolean).join("/");
    if (dots > 0) {
      let d = dirOf(from);
      for (let i = 1; i < dots; i++) d = dirOf(d);
      return pyModule(join(d, rest));
    }
    for (const root of pySourceRoots(from)) {
      const hit = pyModule(join(root, rest));
      if (hit) return hit;
    }
    return "ext";
  };
  const goModules = [...input.goModules].sort((a, b) => b[0].length - a[0].length);
  const goSpec = (spec: string): string | "ext" => {
    for (const [mod, dir] of goModules) {
      if (spec === mod) return dir;
      if (spec.startsWith(`${mod}/`)) return join(dir, spec.slice(mod.length + 1));
    }
    return "ext";
  };
  const rbSpec = (from: string, spec: string, relative: boolean): string | "ext" => {
    const base = relative ? join(dirOf(from), spec) : spec;
    const file = base.endsWith(".rb") ? base : `${base}.rb`;
    if (known.has(file)) return file;
    if (!relative && known.has(join("lib", file))) return join("lib", file);
    return "ext";
  };

  // ---------- bindings per file ----------
  type Binding =
    | { kind: "named"; target: string | "ext" | null; imported: string }
    | { kind: "ns"; target: string | "ext" | null }
    | { kind: "pyns"; dotted: string };
  const bindingsCache = new Map<string, { names: Map<string, Binding>; stars: (string | "ext" | null)[] }>();
  const importTargets = new Map<string, { target: string; line: number; column: number }[]>();

  const bindings = (file: string) => {
    let b = bindingsCache.get(file);
    if (b) return b;
    b = { names: new Map(), stars: [] };
    bindingsCache.set(file, b);
    const f = facts.get(file);
    if (!f) return b;
    const family = familyOf(f.lang);
    const targets: { target: string; line: number; column: number }[] = [];
    for (const imp of f.imports) {
      let target: string | "ext" | null;
      if (family === "js") target = jsSpec(file, imp.spec);
      else if (family === "python") target = pySpec(file, imp.spec);
      else if (family === "go") target = goSpec(imp.spec);
      else target = rbSpec(file, imp.spec, imp.relative === true);
      if (target !== null && target !== "ext") targets.push({ target, line: imp.line, column: imp.column });
      if (family === "ruby") continue;
      if (imp.reexport) continue; // re-exports bind nothing locally
      if (imp.scoped) continue; // binds only in its own scope, through CallFact.bound
      if (imp.star) {
        b.stars.push(target);
        continue;
      }
      if (family === "go") {
        const local = imp.namespace ?? (target !== null && target !== "ext" ? pkgName.get(target) : undefined) ?? goGuess(imp.spec);
        b.names.set(local, { kind: "ns", target });
        continue;
      }
      if (imp.namespace && family === "python") {
        // `import a.b` binds `a`; `import a.b as c` binds `c` to `a.b`.
        b.names.set(imp.namespace, { kind: "pyns", dotted: imp.alias ? imp.spec : imp.namespace });
      } else if (imp.namespace) b.names.set(imp.namespace, { kind: "ns", target });
      for (const n of imp.names) b.names.set(n.local, { kind: "named", target, imported: n.imported });
    }
    importTargets.set(file, targets);
    return b;
  };

  // A name a module offers to importers.
  const lookupExport = (file: string, name: string, depth: number): Value | null => {
    if (depth > MAX_DEPTH) return null;
    const f = facts.get(file);
    if (!f) return known.has(file) ? { v: "miss", target: file, name } : null;
    const family = familyOf(f.lang);
    if (family === "go") return pkgValue(pkgOf(file), name);
    if (family === "js") {
      // The export table: exported declarations, `export { a as b }`,
      // `export default`, CommonJS assignments, then re-exports. A private
      // top-level definition is never an export.
      if (name === "default" && f.defaultExport) return resolveLocal(file, f.defaultExport, depth + 1);
      const top = topByFile.get(file)?.get(name)?.filter((id) => defById.get(id)?.exported);
      if (top && top.length > 0) return { v: "sym", ids: top };
      for (const e of f.exportsLocal) if (e.exported === name) return resolveLocal(file, e.local, depth + 1);
      let starHit: Value | null = null;
      for (const imp of f.imports) {
        if (!imp.reexport) continue;
        const target = jsSpec(file, imp.spec);
        if (target === null) continue;
        if (target === "ext") {
          if (imp.names.some((n) => n.local === name)) return { v: "ext" };
          continue;
        }
        const named = imp.names.find((n) => n.local === name);
        if (named) return named.imported === "*" ? { v: "mod", file: target } : lookupExport(target, named.imported, depth + 1);
        if (imp.star && !starHit) {
          const hit = lookupExport(target, name, depth + 1);
          if (hit && hit.v !== "miss") starHit = hit;
        }
      }
      return starHit ?? { v: "miss", target: file, name };
    }
    // Python: definitions, then names the module imported, then submodules of a package.
    const top = topByFile.get(file)?.get(name);
    if (top) return { v: "sym", ids: top };
    if (bindings(file).names.has(name)) return resolveLocal(file, name, depth + 1);
    if (file.endsWith("__init__.py")) {
      const sub = pyModule(join(dirOf(file), name));
      if (sub) return { v: "mod", file: sub };
    }
    for (const star of bindings(file).stars) {
      if (star === null || star === "ext") continue;
      const hit = lookupExport(star, name, depth + 1);
      if (hit && hit.v !== "miss") return hit;
    }
    return { v: "miss", target: file, name };
  };

  const pkgValue = (dir: string, name: string): Value => {
    const ids = pkgTop.get(dir)?.get(name);
    return ids ? { v: "sym", ids } : { v: "miss", target: `go:${dir}`, name };
  };

  const bindingValue = (file: string, family: Family, name: string, b: Binding, depth: number): Value | null => {
    if (b.kind === "pyns") return { v: "pymod", from: file, dotted: b.dotted };
    if (b.target === "ext") return { v: "ext" };
    if (b.target === null) return { v: "miss", target: file, name };
    if (b.kind === "ns") return family === "go" ? { v: "pkg", dir: b.target } : { v: "mod", file: b.target };
    return lookupExport(b.target, b.imported, depth + 1);
  };

  // What a name a scoped import binds means: the same as a file-wide import
  // of it would, for the one scope the import was made in.
  const boundValue = (file: string, name: string, ref: BoundImport): Value | null => {
    const f = facts.get(file);
    const imp = f?.imports[ref.import];
    if (!f || !imp) return null;
    const family = familyOf(f.lang);
    if (family === "python" && ref.imported === "*") return { v: "pymod", from: file, dotted: imp.alias ? imp.spec : (imp.namespace ?? imp.spec) };
    const target = family === "python" ? pySpec(file, imp.spec) : family === "js" ? jsSpec(file, imp.spec) : null;
    const b: Binding = ref.imported === "*" ? { kind: "ns", target } : { kind: "named", target, imported: ref.imported };
    return bindingValue(file, family, name, b, 0);
  };

  // What a bare name means in a file.
  const resolveLocal = (file: string, name: string, depth = 0): Value | null => {
    const f = facts.get(file);
    if (!f || depth > MAX_DEPTH) return null;
    const family = familyOf(f.lang);
    if (family === "go") {
      const ids = pkgTop.get(pkgOf(file))?.get(name);
      if (ids) return { v: "sym", ids };
    } else {
      const top = topByFile.get(file)?.get(name);
      if (top) return { v: "sym", ids: top };
    }
    const b = bindings(file).names.get(name);
    if (b) return bindingValue(file, family, name, b, depth);
    for (const star of bindings(file).stars) {
      if (star === null || star === "ext") continue;
      const hit = lookupExport(star, name, depth + 1);
      if (hit && hit.v !== "miss") return hit;
    }
    if (family === "go") {
      // Dot imports bring a package's names into scope.
      for (const star of bindings(file).stars) if (star === "ext") return null;
    }
    return null;
  };

  const attr = (value: Value | null, name: string): Value | null => {
    if (!value) return null;
    if (value.v === "ext" || value.v === "miss") return value.v === "ext" ? value : null;
    if (value.v === "mod") return lookupExport(value.file, name, 0);
    if (value.v === "pkg") return pkgValue(value.dir, name);
    if (value.v === "pymod") {
      const dotted = `${value.dotted}.${name}`;
      const sub = pySpec(value.from, dotted);
      if (sub !== null && sub !== "ext") return { v: "mod", file: sub };
      const mod = pySpec(value.from, value.dotted);
      if (mod === "ext") return { v: "pymod", from: value.from, dotted };
      return mod === null ? null : lookupExport(mod, name, 0);
    }
    const key = value.ids.length === 1 ? classOfId.get(value.ids[0] as string) : undefined;
    if (!key) return null;
    const m = methodOn(key, name, "s", 0);
    return m ? { v: "sym", ids: m } : { v: "miss", target: key, name };
  };

  // Ruby: a constant by lexical lookup from the innermost nesting outwards.
  const rbConst = (name: string, nesting: string | null): string | null => {
    const n = name.replace(/^::/, "");
    const parts = nesting && !name.startsWith("::") ? nesting.split("::") : [];
    for (let i = parts.length; i >= 0; i--) {
      const key = `rb::${[...parts.slice(0, i), n].join("::")}`;
      if (classes.has(key)) return key;
    }
    return null;
  };

  // The class a type name in `file` stands for. A function's name stands for
  // its declared result type at the position the call took.
  const typeKey = (file: string, family: Family, t: TypeRef, depth = 0): string | null => {
    if (t.elem || depth > MAX_DEPTH) return null;
    if (family === "ruby") return rbConst(t.name, t.qualifier);
    // The head name, through the scoped import that binds it where the type was read.
    const head = (name: string) => (t.bound ? boundValue(file, name, t.bound) : resolveLocal(file, name));
    let v: Value | null;
    if (t.qualifier) {
      const parts = t.qualifier.split(".");
      v = head(parts[0] as string);
      for (const p of parts.slice(1)) v = attr(v, p);
      v = v && v.v !== "sym" ? attr(v, t.name) : null;
    } else v = head(t.name);
    if (v?.v !== "sym" || v.ids.length !== 1) return null;
    const cls = classOfId.get(v.ids[0] as string);
    if (cls) return cls;
    const def = defById.get(v.ids[0] as string);
    const result = def?.results?.[t.result ?? 0];
    return def && result ? typeKey(def.file, def.family, { ...result, result: undefined }, depth + 1) : null;
  };

  const baseKeys = new Map<string, string[]>();
  const basesOf = (key: string): string[] => {
    let out = baseKeys.get(key);
    if (out) return out;
    out = [];
    baseKeys.set(key, out);
    const info = classes.get(key);
    if (!info) return out;
    for (const b of info.bases) {
      const k = typeKey(info.file, info.family, b);
      if (k && k !== key) out.push(k);
    }
    return out;
  };

  function methodOn(key: string, name: string, side: Side, depth: number): string[] | null {
    if (depth > MAX_DEPTH) return null;
    const own = methods.get(sideKey(key, side))?.get(name);
    if (own) return own;
    // A Ruby module's instance methods are called on the module itself
    // through module_function or extend self.
    const info = classes.get(key);
    if (side === "s" && info?.family === "ruby" && info.ids.every((id) => defById.get(id)?.kind === "module")) {
      const viaModule = methods.get(sideKey(key, "i"))?.get(name);
      if (viaModule) return viaModule;
    }
    for (const base of basesOf(key)) {
      const hit = methodOn(base, name, side, depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  const fieldKey = (key: string, field: string, depth = 0): string | null => {
    if (depth > MAX_DEPTH) return null;
    const info = classes.get(key);
    const t = info?.fields.get(field);
    if (info && t) return typeKey(info.file, info.family, t);
    for (const base of basesOf(key)) {
      const hit = fieldKey(base, field, depth + 1);
      if (hit) return hit;
    }
    return null;
  };

  // The class whose method the caller is: its owner in this file.
  const enclosingClass = (file: string, family: Family, caller: Def | undefined): string | null => {
    if (!caller) return null;
    if (caller.kind === "class" || caller.kind === "module") return classOfId.get(caller.id) ?? null;
    if (caller.kind !== "method" || !caller.owner) return null;
    return classKey(family, file, caller.owner);
  };

  // ---------- calls ----------
  const edgeMap = new Map<string, GraphEdge>();
  const addEdge = (from: string, to: string, kind: GraphEdge["kind"], site: GraphSite) => {
    const k = `${from}\u0000${to}\u0000${kind}`;
    let e = edgeMap.get(k);
    if (!e) {
      e = { from, to, kind, confidence: site.confidence, sites: [] };
      edgeMap.set(k, e);
    }
    if (site.confidence === "high") e.confidence = "high";
    e.sites.push(site);
  };
  const misses: Miss[] = [];
  let unresolvedSites = 0;

  type Outcome = { ids: string[]; confidence: "high" | "low"; evidence: GraphSite["evidence"] } | { miss: { target: string; name: string } } | "ignore" | "unresolved";

  const fromValue = (v: Value | null, evidence: GraphSite["evidence"]): Outcome => {
    if (!v) return "unresolved";
    if (v.v === "ext") return "ignore";
    if (v.v === "miss") return { miss: v };
    if (v.v === "sym") return { ids: v.ids, confidence: "high", evidence };
    // A CommonJS module called as a function calls what `module.exports` holds.
    if (v.v === "mod" && familyOf(facts.get(v.file)?.lang ?? "go") === "js" && facts.get(v.file)?.defaultExport) {
      return fromValue(lookupExport(v.file, "default", 0), evidence);
    }
    return "ignore"; // a module, a package or an outside module called as a function
  };

  const onClass = (key: string | null, name: string, side: Side, evidence: GraphSite["evidence"]): Outcome => {
    if (!key) return "unresolved";
    const info = classes.get(key);
    if (name === "new" && side === "s" && info?.family === "ruby") return { ids: info.ids, confidence: "high", evidence };
    const ids = methodOn(key, name, side, 0);
    return ids ? { ids, confidence: "high", evidence } : { miss: { target: key, name } };
  };

  const followPath = (key: string | null, path: string[]): string | null => {
    let k = key;
    for (const p of path) {
      if (!k) return null;
      k = fieldKey(k, p);
    }
    return k;
  };

  const rbGlobal = (name: string): Outcome => {
    const ids = rbTop.get(name);
    const files = filesByName.get(`ruby:${name}`)?.size ?? 0;
    if (ids && ids.length === 1 && files <= HUB_FILES) return { ids, confidence: "low", evidence: "autoload" };
    return "unresolved";
  };

  const resolveCall = (file: string, family: Family, call: CallFact, caller: Def | undefined): Outcome => {
    const r = call.recv;
    const builtin = BUILTINS[family].has(call.name);
    switch (r.kind) {
      case "none": {
        if (family === "ruby") return builtin ? "ignore" : rbGlobal(call.name);
        if (call.local !== undefined) {
          const ids = [symbolId(file, facts.get(file)?.defs[call.local] as DefFact)];
          return { ids, confidence: "high", evidence: "binding" };
        }
        if (call.bound) return fromValue(boundValue(file, call.name, call.bound), "binding");
        if (call.shadowed) return "unresolved";
        const v = resolveLocal(file, call.name);
        if (!v) {
          if (builtin) return "ignore";
          return { miss: { target: family === "go" ? `go:${pkgOf(file)}` : file, name: call.name } };
        }
        return fromValue(v, "binding");
      }
      case "self": {
        // self in a static method or a class body is the class; a field of it is an instance.
        const side: Side = call.static && r.path.length === 0 ? "s" : "i";
        const key = followPath(enclosingClass(file, family, caller), r.path);
        const out = onClass(key, call.name, side, "receiver-type");
        if (family === "ruby" && r.path.length === 0 && typeof out === "object" && "miss" in out) {
          const global = rbGlobal(call.name);
          if (global !== "unresolved") return global;
          if (builtin) return "ignore";
        }
        return out;
      }
      case "super": {
        const key = enclosingClass(file, family, caller);
        const base = key ? basesOf(key)[0] : undefined;
        return base ? onClass(base, call.name, call.static ? "s" : "i", "receiver-type") : "unresolved";
      }
      case "type": {
        const key = followPath(typeKey(file, family, r.type), r.path);
        return onClass(key, call.name, "i", "receiver-type");
      }
      case "name": {
        if (family === "ruby") {
          const key = rbConst(r.name, r.nesting);
          return key ? onClass(key, call.name, "s", "autoload") : "ignore";
        }
        let v = r.bound ? boundValue(file, r.name, r.bound) : resolveLocal(file, r.name);
        if (!v) return BUILTINS[family].has(r.name) ? "ignore" : "unresolved";
        // A path through a module or package; a field of a class value is not followed.
        for (const p of r.path) v = v?.v === "sym" ? null : attr(v, p);
        if (!v) return "unresolved";
        if (v.v === "sym") {
          const key = v.ids.length === 1 ? classOfId.get(v.ids[0] as string) : undefined;
          return key ? onClass(key, call.name, "s", "receiver-type") : "unresolved";
        }
        return fromValue(attr(v, call.name), "binding");
      }
      default:
        return "unresolved";
    }
  };

  for (const { path, facts: f } of input.files) {
    const family = familyOf(f.lang);
    const defIds = f.defs.map((d) => symbolId(path, d));
    for (const call of f.calls) {
      const callerId = call.caller >= 0 ? (defIds[call.caller] as string) : path;
      const caller = call.caller >= 0 ? defById.get(callerId) : undefined;
      const out = resolveCall(path, family, call, caller);
      if (out === "ignore") continue;
      if (out === "unresolved") {
        if (!call.implicit) unresolvedSites++;
        continue;
      }
      if ("miss" in out) {
        misses.push({ target: out.miss.target, name: out.miss.name, from: callerId, site: { file: path, line: call.line, column: call.column, confidence: "high", evidence: "binding" } });
        if (!call.implicit) unresolvedSites++;
        continue;
      }
      // Several ids only when one name has several definitions in one place
      // (overloads, a reopened Ruby class): each gets the site.
      // A recursive call is kept as a self-edge; the impact walk stops cycles.
      for (const to of out.ids) {
        addEdge(callerId, to, "calls", { file: path, line: call.line, column: call.column, confidence: out.confidence, evidence: out.evidence });
      }
    }
    // Inheritance: class to base class.
    f.defs.forEach((d, i) => {
      if (d.bases.length === 0) return;
      for (const b of d.bases) {
        const key = typeKey(path, family, b);
        const info = key ? classes.get(key) : undefined;
        if (!info) continue;
        for (const to of info.ids) {
          if (to === defIds[i]) continue;
          addEdge(defIds[i] as string, to, "inherits", { file: path, line: b.line, column: b.column, confidence: "high", evidence: family === "ruby" ? "autoload" : "binding" });
        }
      }
    });
  }

  // ---------- importers ----------
  const importers = new Map<string, GraphEdge[]>();
  for (const { path, facts: f } of input.files) {
    bindings(path);
    const family = familyOf(f.lang);
    const seen = new Set<string>();
    for (const t of importTargets.get(path) ?? []) {
      // Go: the target is a package folder; files of one package do not import each other.
      const key = family === "go" ? `go:${t.target}` : t.target;
      if (seen.has(key) || (family === "go" && t.target === dirOf(path))) continue;
      seen.add(key);
      push(importers, key, { from: path, to: key, kind: "imports", confidence: "high", sites: [{ file: path, line: t.line, column: t.column, confidence: "high", evidence: "binding" }] } as GraphEdge);
    }
  }

  return { nodes, edges: [...edgeMap.values()], importers, defsByFile, misses, unresolvedSites };
}

// The name an unaliased Go import is used by when its package is not in the
// repo: the last path element without a major version suffix.
function goGuess(spec: string): string {
  const parts = spec.split("/");
  let last = parts[parts.length - 1] ?? spec;
  if (/^v\d+$/.test(last) && parts.length > 1) last = parts[parts.length - 2] ?? last;
  return last.replace(/^go-/, "").replace(/[.-].*$/, "");
}
