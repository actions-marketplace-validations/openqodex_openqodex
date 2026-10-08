// Turns every file's local facts into a graph. A call becomes an edge only
// with evidence: a definition in the same file or Go package, an import that
// names it, a receiver whose type a constructor or an annotation gives, or
// (Ruby) a constant found by the autoload convention. A method call is never
// matched by its name alone. Every call site is kept on its edge, with the
// evidence that bound it and its tier (model/records.ts): a binding is no
// stronger than its weakest step, so a call through a workspace package
// reached by the dist to src convention is likely, never certain.
//
// A call no rule binds is never dropped: it becomes an unknown site with a
// cause (a declared dependency is "external", a value of unknown type is
// "no-receiver-type", a call through a parameter or a computed member is
// "dynamic", ...). An unresolved name alone is never "external": that needs
// a declared dependency or a standard library module.
//
// Every cross-file read goes through the `index` object below (the exports
// of a module, the bindings of a file, the members of a class, the module a
// specifier names), so a later phase can record what each file's resolution
// read. Everything is maps keyed by name or path: no step scans every file
// for every call, so resolution stays linear in the number of call sites.
import { dirname, posix } from "node:path";
import type { ImpactKind } from "@openqodex/core";
import type { ProjectModel } from "./discovery/projects.js";
import { governingTsconfig, isGoStdlib, isNodeBuiltin, isPyStdlib, isRubyStdlib, linkageOf, nodeProjectOf, normalisePy, packageName } from "./discovery/projects.js";
import type { Cause, Cut, EvidenceKind, Shape, Tier, Via } from "./model/records.js";
import { weakest } from "./model/records.js";
import type { BoundImport, CallFact, DefFact, Family, FileFacts, GraphEdge, GraphNode, GraphSite, Miss, TypeRef, UnknownSite } from "./types.js";
import { familyOf } from "./types.js";

const MAX_DEPTH = 8; // re-export and base-class chains
// Files the walk of `export *` may open in one world. Each file is walked
// once (its names are kept), so this bounds only a walk through cycles or a
// barrel chain longer than any real repository holds.
export const EXPORT_WALK_STEPS = 4096;
export const HUB_FILES = 8; // a name defined in more files never binds without evidence
export const RESOLVER_VERSION = 3;

const BUILTINS: Record<Family, ReadonlySet<string>> = {
  js: new Set(
    "require console setTimeout setInterval clearTimeout clearInterval setImmediate parseInt parseFloat isNaN isFinite String Number Boolean Array Object Promise Symbol Error TypeError RangeError SyntaxError Map Set WeakMap WeakSet Date RegExp JSON Math Reflect Proxy BigInt encodeURIComponent decodeURIComponent encodeURI decodeURI structuredClone fetch queueMicrotask describe it test expect beforeEach afterEach beforeAll afterAll jest vi process Buffer URL URLSearchParams TextEncoder TextDecoder AbortController Uint8Array ArrayBuffer Intl globalThis window document Function Int8Array Int16Array Int32Array Uint16Array Uint32Array Uint8ClampedArray Float32Array Float64Array BigInt64Array BigUint64Array DataView SharedArrayBuffer Atomics WeakRef FinalizationRegistry AggregateError EvalError ReferenceError URIError eval escape unescape performance crypto atob btoa Blob File FormData Headers Request Response Event EventTarget CustomEvent MessageChannel clearImmediate setImmediate module exports __dirname __filename WebAssembly".split(
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

// Built-in types whose methods are the language's: a call on a value of
// one is external, never a gap of the repository.
const BUILTIN_TYPES: Record<Family, ReadonlySet<string>> = {
  js: new Set(
    "string number boolean bigint symbol never void undefined null String Number Boolean BigInt Symbol Object Array ReadonlyArray Map ReadonlyMap Set ReadonlySet WeakMap WeakSet Promise PromiseLike Date RegExp Error TypeError RangeError Function Record Partial Required Readonly Pick Omit Iterable IterableIterator AsyncIterable AsyncIterableIterator Iterator Generator AsyncGenerator ArrayBuffer SharedArrayBuffer DataView Uint8Array Int8Array Uint16Array Int16Array Uint32Array Int32Array Float32Array Float64Array BigInt64Array BigUint64Array Buffer URL URLSearchParams AbortController AbortSignal TextEncoder TextDecoder".split(" "),
  ),
  python: new Set("str int float bool bytes bytearray list dict set frozenset tuple complex List Dict Set FrozenSet Tuple Sequence Mapping MutableMapping MutableSequence Iterable Iterator".split(" ")),
  go: new Set("string int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 uintptr float32 float64 complex64 complex128 byte rune bool error".split(" ")),
  ruby: new Set("String Integer Float Array Hash Symbol Range Proc".split(" ")),
};

// Types that say nothing about a value's methods: a call on a value of one
// may reach any method of that name, so it is an untyped receiver, never
// external and never bound.
const UNTYPED: Record<Family, ReadonlySet<string>> = {
  js: new Set(["any", "unknown", "object", "{}"]),
  python: new Set(["object", "Any"]),
  go: new Set(["any"]),
  ruby: new Set(),
};

export type FileInput = { path: string; facts: FileFacts };

// The evidence a value carries: how it was bound, how surely, through which line.
type Ev = { kind: EvidenceKind; tier: Tier; via: Via | null; note: string | null; rule: string };

const SAME_SCOPE: Ev = { kind: "same-scope", tier: "certain", via: null, note: null, rule: "same-scope" };

// A step through a module: the outer binding (the import the call read)
// keeps its kind and line; the tier is the weaker of the two and the notes
// add up.
function chain(outer: Ev | null, inner: Ev): Ev {
  if (outer === null) return inner;
  const notes = [outer.note, inner.note].filter((n): n is string => n !== null && n !== "");
  return { kind: outer.kind, tier: weakest(outer.tier, inner.tier), via: outer.via ?? inner.via, note: notes.length > 0 ? [...new Set(notes)].join(" ") : null, rule: outer.rule };
}

// What a module specifier names.
type Mod =
  | { file: string; ev: Ev } // a file in the repository (Go: a package folder)
  | { ext: string } // a declared dependency or a standard library module
  | { gap: Cause; note: string; candidates: string[] | null }
  | null; // a path specifier that names nothing here: a miss

// What a name or an expression stands for.
type Value =
  | { v: "sym"; ids: string[]; ev: Ev }
  | { v: "mod"; file: string; ev: Ev }
  | { v: "pkg"; dir: string; ev: Ev }
  | { v: "pyns"; dir: string; ev: Ev } // a Python namespace package: a folder without __init__.py
  | { v: "pymod"; from: string; dotted: string } // Python `import a.b`: a dotted module path
  | { v: "ext" }
  | { v: "gap"; cause: Cause; note: string; candidates: string[] | null }
  | { v: "miss"; target: string; name: string; ev: Ev };

type Def = DefFact & { id: string; file: string; family: Family };

type ClassInfo = { file: string; family: Family; ids: string[]; files: Set<string>; bases: TypeRef[]; fields: Map<string, TypeRef>; nesting: string | null };

export type ResolveInput = {
  files: FileInput[];
  known: ReadonlySet<string>; // every path import resolution may land on: eligible files and removed ones
  model: ProjectModel;
  goModules: [string, string][]; // module path, folder ("" for the root)
  // Checked between files while calls are resolved: true stops; the files
  // left are listed in `budgetFiles`.
  stop?: () => boolean;
};

export type Resolved = {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  importers: Map<string, GraphEdge[]>;
  defsByFile: Map<string, GraphNode[]>;
  misses: Miss[];
  unknowns: UnknownSite[];
  unresolvedSites: number;
  externalSites: number;
  budgetFiles: string[]; // files whose calls were not resolved: the budget ran out
};

// One call site or import binding, resolved with a record of the exports it
// read on the way: what the export diff compares between two worlds.
export type SiteTrace = { file: string; line: number; column: number; from: string; reads: string[]; targets: string[] | null };

// An exported name's target: the stable keys of the definitions it names,
// or "ext" for a name a declared dependency supplies.
export type ExportTarget = { keys: string[]; ids: string[] } | "ext";

export type World = {
  resolveAll(): Resolved;
  // Call sites and import bindings of these files, resolved with the
  // exports each read.
  trace(files: Iterable<string>): SiteTrace[];
  // Every name the module exports and what it names; null for a name the
  // module lists but that resolves to nothing.
  surface(file: string): Map<string, { target: ExportTarget | null; line: number | null }>;
  // The modules a file's imports and re-exports name (in-repo only), and
  // whether each is a re-export.
  importsOf(file: string): { target: string; reexport: boolean }[];
  // The node of an id or a stable key (the first of its overloads).
  node(idOrKey: string): GraphNode | null;
  // The cuts the walk of `export *` made in this world (at most one).
  walkCuts(): Cut[];
};

export function symbolId(file: string, d: Pick<DefFact, "owner" | "name" | "line" | "column">): string {
  return `${file}#${d.owner ? `${d.owner}.` : ""}${d.name}@${d.line}:${d.column}`;
}

// A symbol id without its position: equal across two versions of a file
// whose lines moved. Overloads share it.
export function stableKey(id: string): string {
  const at = id.lastIndexOf("@");
  return id.includes("#") && at > id.indexOf("#") ? id.slice(0, at) : id;
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
  return createWorld(input).resolveAll();
}

export function createWorld(input: ResolveInput): World {
  const facts = new Map<string, FileFacts>();
  for (const f of input.files) facts.set(f.path, f.facts);
  const model = input.model;

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
      if (d.bodyHash) node.bodyHash = d.bodyHash;
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
          info = { file: path, family, ids: [], files: new Set(), bases: [], fields: new Map(), nesting: d.owner };
          classes.set(key, info);
        }
        info.ids.push(id);
        info.files.add(path);
        info.bases.push(...d.bases);
        for (const [k, t] of Object.entries(d.fields)) info.fields.set(k, t);
      }
    }
    defsByFile.set(path, list);
  }

  // ---------- module resolution ----------
  const known = input.known;
  const viaOf = (from: string, line: number, spec: string): Via => ({ file: from, line, spec });

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

  // A `paths` pattern match: the longest prefix wins, as TypeScript picks.
  const matchPaths = (paths: [string, string[]][], spec: string): { targets: string[]; rest: string } | null => {
    let best: { targets: string[]; rest: string; len: number } | null = null;
    for (const [pattern, targets] of paths) {
      const star = pattern.indexOf("*");
      if (star === -1) {
        if (pattern === spec && (!best || pattern.length > best.len)) best = { targets, rest: "", len: pattern.length };
      } else {
        const pre = pattern.slice(0, star);
        const post = pattern.slice(star + 1);
        if (spec.startsWith(pre) && spec.endsWith(post) && spec.length >= pre.length + post.length && (!best || pre.length > best.len)) {
          best = { targets, rest: spec.slice(pre.length, spec.length - post.length), len: pre.length };
        }
      }
    }
    return best;
  };

  // The entry an `exports` value selects for the active conditions, in the
  // object's own key order (Node's rule): a string, or the first key whose
  // condition is active. `types` is never active: a declaration file is
  // not an implementation.
  const pickExport = (value: unknown, active: ReadonlySet<string>, depth = 0): { target: string; condition: string | null } | null => {
    if (depth > 8) return null;
    if (typeof value === "string") return { target: value, condition: null };
    if (Array.isArray(value)) {
      for (const v of value) {
        const hit = pickExport(v, active, depth + 1);
        if (hit) return hit;
      }
      return null;
    }
    if (typeof value !== "object" || value === null) return null;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "types" || !active.has(k)) continue;
      const hit = pickExport(v, active, depth + 1);
      if (hit) return { target: hit.target, condition: hit.condition ?? k };
    }
    return null;
  };

  // The `exports` entry for a subpath ("." or "./sub"), with `./*` patterns.
  const exportsEntry = (exportsField: unknown, sub: string): unknown => {
    if (typeof exportsField === "string" || Array.isArray(exportsField)) return sub === "." ? exportsField : undefined;
    if (typeof exportsField !== "object" || exportsField === null) return undefined;
    const map = exportsField as Record<string, unknown>;
    const keys = Object.keys(map);
    if (!keys.some((k) => k.startsWith("."))) return sub === "." ? exportsField : undefined; // conditions at the top: the "." entry
    if (sub in map) return map[sub];
    for (const k of keys) {
      const star = k.indexOf("*");
      if (star === -1) continue;
      const pre = k.slice(0, star);
      const post = k.slice(star + 1);
      if (sub.startsWith(pre) && sub.endsWith(post)) {
        const rest = sub.slice(pre.length, sub.length - post.length);
        const replace = (v: unknown): unknown =>
          typeof v === "string" ? v.replaceAll("*", rest) : Array.isArray(v) ? v.map(replace) : typeof v === "object" && v !== null ? Object.fromEntries(Object.entries(v).map(([a, b]) => [a, replace(b)])) : v;
        return replace(map[k]);
      }
    }
    return undefined;
  };

  // A built file of a member mapped back to its source: through the member
  // tsconfig's outDir and rootDir when both are set, else `dist/` (or
  // `build/`, `lib/`) to `src/`.
  const builtToSource = (memberDir: string, built: string): string | null => {
    const config = model.tsconfigs.get(memberDir);
    const strip = built.replace(/\.d\.[cm]?ts$/, ".js");
    if (config?.outDir && config.rootDir && strip.startsWith(`${config.outDir}/`)) {
      const hit = jsCandidates(join(config.rootDir, strip.slice(config.outDir.length + 1)).replace(/\.[cm]?js$/, ""));
      if (hit) return hit;
    }
    const rel = strip.slice(memberDir === "" ? 0 : memberDir.length + 1);
    const m = /^(dist|build|lib|out)\/(.*)$/.exec(rel);
    if (!m) return null;
    return jsCandidates(join(memberDir, "src", (m[2] as string).replace(/\.[cm]?jsx?$/, "")));
  };

  // A bare specifier that names a workspace package.
  const workspaceSpec = (from: string, line: number, spec: string, name: string): Mod => {
    const members = model.members.get(name) ?? [];
    const via = viaOf(from, line, spec);
    if (members.length > 1) return { gap: "ambiguous", note: `${members.length} workspace packages are named ${name}`, candidates: members.map((m) => m.dir) };
    const member = members[0];
    if (!member) return null;
    // A package importing itself by name (Node resolves a self-reference through its own exports).
    const self = nodeProjectOf(model, from)?.dir === member.dir;
    const link = self ? { linkage: "workspace" as const, declaredIn: member.file, spec: "itself" } : linkageOf(model, from, name);
    if (link === null) {
      return { gap: "ambiguous", note: `the package of this file does not declare ${name}, so the workspace package ${member.dir} is not assumed`, candidates: [member.dir] };
    }
    if (link.linkage === "published") return { ext: name };
    const linkNote = link.linkage === "unknown" ? `${link.declaredIn} declares ${name} as ${link.spec} and no lockfile says it links the workspace package.` : null;
    const capped = (ev: Ev): Ev => (linkNote ? { ...ev, tier: weakest(ev.tier, "likely"), note: [ev.note, linkNote].filter(Boolean).join(" ") } : ev);
    const sub = spec.length > name.length ? `.${spec.slice(name.length)}` : ".";
    const gov = governingTsconfig(model, from);
    const referenced = gov?.config.references.some((r) => r === member.dir) ?? false;
    const active = new Set(["import", "node", "default", "module", ...(gov?.config.customConditions ?? [])]);
    const missing = `no tsconfig paths, project reference or active source condition maps ${name} to its source`;
    // The entry the package declares, through `exports`, then `module` and `main`.
    let entry: string | null = null;
    let condition: string | null = null;
    if (member.pkg.exports !== null) {
      // An exports map is the whole public surface: a path it does not
      // expose, under the conditions this import uses, is refused by Node.
      const listed = exportsEntry(member.pkg.exports, sub);
      const picked = listed === undefined ? null : pickExport(listed, active);
      if (!picked) {
        const what = sub === "." ? "its root" : sub;
        return {
          gap: "not-exported",
          note: `${member.file} has an exports map that does not expose ${what}${listed === undefined ? "" : " under the conditions this import uses"}`,
          candidates: [member.dir],
        };
      }
      entry = join(member.dir, picked.target);
      condition = picked.condition;
    } else if (sub === ".") {
      const field = member.pkg.module ?? member.pkg.main;
      if (field) entry = join(member.dir, field);
    }
    if (entry !== null) {
      const direct = jsCandidates(entry.replace(/\.[cm]?jsx?$/, "")) === entry || known.has(entry) ? entry : null;
      if (direct) {
        // The declared entry is a source file of the repository.
        const rule = condition === null ? "workspace-main" : `workspace-exports-${condition}`;
        return { file: direct, ev: capped({ kind: "workspace-package", tier: "certain", via, note: null, rule }) };
      }
      const source = builtToSource(member.dir, entry);
      if (source) {
        if (referenced) return { file: source, ev: capped({ kind: "workspace-package", tier: "certain", via, note: null, rule: "workspace-references" }) };
        return {
          file: source,
          ev: capped({ kind: "workspace-package", tier: "likely", via, note: `Bound through ${name}'s entry ${entry}, built from ${source}; ${missing}.`, rule: "workspace-dist-src" }),
        };
      }
    }
    if (sub === ".") {
      for (const fallback of ["src/index", "index"]) {
        const hit = jsCandidates(join(member.dir, fallback));
        if (hit) {
          return { file: hit, ev: capped({ kind: "workspace-package", tier: "likely", via, note: `Bound to ${hit} by the src/index convention; ${missing}.`, rule: "workspace-index" }) };
        }
      }
    } else if (member.pkg.exports === null) {
      // No exports map: Node finds a subpath by the package's folder layout.
      const hit = jsCandidates(join(member.dir, sub.slice(2)));
      if (hit) return { file: hit, ev: capped({ kind: "workspace-package", tier: "certain", via, note: null, rule: "workspace-subpath" }) };
    }
    return { gap: "unsupported-rule", note: `the entry of the workspace package ${name} could not be mapped to a source file`, candidates: [member.dir] };
  };

  const jsSpec = (from: string, line: number, spec: string): Mod => {
    const via = viaOf(from, line, spec);
    if (spec.startsWith(".")) {
      const hit = jsCandidates(join(dirOf(from), spec));
      return hit ? { file: hit, ev: { kind: "import", tier: "certain", via, note: null, rule: "js-relative" } } : null;
    }
    const gov = governingTsconfig(model, from);
    if (gov) {
      const { config, admits } = gov;
      const tier: Tier = admits ? "certain" : "likely";
      const note = admits ? null : `${config.file} governs this file by its folder, but its files, include and exclude do not list it.`;
      const best = config.paths.length > 0 ? matchPaths(config.paths, spec) : null;
      if (best) {
        for (const t of best.targets) {
          const hit = jsCandidates(join(config.pathsBase, t.replace("*", best.rest)));
          if (hit) return { file: hit, ev: { kind: "ts-paths", tier, via, note, rule: "ts-paths" } };
        }
      }
      if (config.baseUrl !== null) {
        const hit = jsCandidates(join(config.baseUrl, spec));
        if (hit) return { file: hit, ev: { kind: "ts-paths", tier, via, note, rule: "ts-baseurl" } };
      }
    }
    if (isNodeBuiltin(spec)) return { ext: spec };
    const name = packageName(spec);
    const ws = workspaceSpec(from, line, spec, name);
    if (ws !== null) return ws;
    // Not in the repository: external only when a package.json declares it.
    if (linkageOf(model, from, name) !== null) return { ext: name };
    return { gap: "miss", note: `the module ${name} is not in the repository and no package.json declares it`, candidates: null };
  };

  const pyRoots = new Map<string, string[]>();
  const pyWalkRoots = (from: string): string[] => {
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
  // Folders that hold Python files: a folder without __init__.py among
  // them is a namespace package.
  const pyDirs = new Set<string>();
  for (const k of known) {
    if (!k.endsWith(".py")) continue;
    for (let d = dirOf(k); d !== "" && !pyDirs.has(d); d = dirOf(d)) pyDirs.add(d);
  }
  type PyHit = { file: string } | { ns: string };
  const pyFind = (root: string, rest: string): PyHit | null => {
    const file = pyModule(join(root, rest));
    if (file) return { file };
    const dir = join(root, rest);
    return rest !== "" && pyDirs.has(dir) ? { ns: dir } : null;
  };
  const pySpec = (from: string, line: number, spec: string): Mod | { ns: string; ev: Ev } => {
    const via = viaOf(from, line, spec);
    const dots = /^\.*/.exec(spec)?.[0].length ?? 0;
    const rest = spec.slice(dots).split(".").filter(Boolean).join("/");
    if (dots > 0) {
      let d = dirOf(from);
      for (let i = 1; i < dots; i++) d = dirOf(d);
      const hit = pyModule(join(d, rest));
      return hit ? { file: hit, ev: { kind: "import", tier: "certain", via, note: null, rule: "py-relative" } } : null;
    }
    // Every module the name finds, from the importer's own folders and from
    // the source roots of the repository's projects: one binds, several are
    // ambiguous. A module or a regular package wins over a namespace
    // package wherever it is, as Python's path finder does.
    const files = new Map<string, string>(); // file to the rule that found it
    for (const root of pyWalkRoots(from)) {
      const hit = pyModule(join(root, rest));
      if (hit && !files.has(hit)) files.set(hit, "py-walk-root");
    }
    const spaces = new Set<string>();
    for (const root of model.pyRoots) {
      const hit = pyFind(root, rest);
      if (hit && "file" in hit && !files.has(hit.file)) files.set(hit.file, "py-src-root");
      else if (hit && "ns" in hit) spaces.add(hit.ns);
    }
    if (files.size === 1) {
      const [file, rule] = [...files.entries()][0] as [string, string];
      return { file, ev: { kind: "py-root", tier: "certain", via, note: null, rule } };
    }
    if (files.size > 1) return { gap: "ambiguous", note: `${rest.replaceAll("/", ".")} is found in ${files.size} places on the import path`, candidates: [...files.keys()].sort() };
    if (spaces.size === 1) return { ns: [...spaces][0] as string, ev: { kind: "py-root", tier: "certain", via, note: null, rule: "py-src-root" } };
    if (spaces.size > 1) return { gap: "ambiguous", note: `${rest.replaceAll("/", ".")} is found under ${spaces.size} source roots`, candidates: [...spaces].sort().map((d) => `ns:${d}`) };
    // A namespace package next to the importer.
    for (const root of pyWalkRoots(from)) {
      const hit = pyFind(root, rest);
      if (hit && "ns" in hit) return { ns: hit.ns, ev: { kind: "py-root", tier: "certain", via, note: null, rule: "py-namespace" } };
    }
    const top = spec.split(".")[0] as string;
    if (isPyStdlib(spec) || model.pyDeclared.has(normalisePy(top))) return { ext: top };
    return { gap: "miss", note: `the module ${spec} is not in the repository and no Python manifest declares ${top}`, candidates: null };
  };
  const goModules = [...input.goModules].sort((a, b) => b[0].length - a[0].length);
  const goSpec = (from: string, line: number, spec: string): Mod => {
    for (const [mod, dir] of goModules) {
      const via = viaOf(from, line, spec);
      if (spec === mod) return { file: dir, ev: { kind: "go-module", tier: "certain", via, note: null, rule: "go-module" } };
      if (spec.startsWith(`${mod}/`)) return { file: join(dir, spec.slice(mod.length + 1)), ev: { kind: "go-module", tier: "certain", via, note: null, rule: "go-module" } };
    }
    if (isGoStdlib(spec) || model.goRequires.some((r) => spec === r || spec.startsWith(`${r}/`))) return { ext: spec };
    return { gap: "miss", note: `the package ${spec} is not in the repository and no go.mod requires it`, candidates: null };
  };
  const rbSpec = (from: string, line: number, spec: string, relative: boolean): Mod => {
    const base = relative ? join(dirOf(from), spec) : spec;
    const file = base.endsWith(".rb") ? base : `${base}.rb`;
    const via = viaOf(from, line, spec);
    if (known.has(file)) return { file, ev: { kind: "import", tier: "certain", via, note: null, rule: "rb-require" } };
    if (!relative && known.has(join("lib", file))) return { file: join("lib", file), ev: { kind: "import", tier: "certain", via, note: null, rule: "rb-require-lib" } };
    if (relative) return null;
    if (isRubyStdlib(spec) || model.gems.has(spec) || model.gems.has(spec.split("/")[0] as string)) return { ext: spec };
    return { gap: "miss", note: `${spec} is not in the repository and the Gemfile does not name it`, candidates: null };
  };

  // ---------- the index: every cross-file read goes through here ----------
  type Binding =
    | { kind: "named"; mod: Mod | { ns: string; ev: Ev }; imported: string }
    | { kind: "ns"; mod: Mod | { ns: string; ev: Ev } }
    | { kind: "pyns"; dotted: string };
  type FileBindings = { names: Map<string, Binding>; stars: (Mod | { ns: string; ev: Ev })[] };
  const bindingsCache = new Map<string, FileBindings>();
  const importTargets = new Map<string, { target: string; line: number; column: number; ev: Ev; reexport: boolean }[]>();
  // The export reads of the site being traced, when one is.
  let reading: Set<string> | null = null;

  const moduleOf = (file: string, family: Family, imp: { spec: string; line: number; relative?: boolean }): Mod | { ns: string; ev: Ev } => {
    if (family === "js") return jsSpec(file, imp.line, imp.spec);
    if (family === "python") return pySpec(file, imp.line, imp.spec);
    if (family === "go") return goSpec(file, imp.line, imp.spec);
    return rbSpec(file, imp.line, imp.spec, imp.relative === true);
  };

  const index = {
    bindings(file: string): FileBindings {
      let b = bindingsCache.get(file);
      if (b) return b;
      b = { names: new Map(), stars: [] };
      bindingsCache.set(file, b);
      const f = facts.get(file);
      if (!f) return b;
      const family = familyOf(f.lang);
      const targets: { target: string; line: number; column: number; ev: Ev; reexport: boolean }[] = [];
      for (const imp of f.imports) {
        const mod = moduleOf(file, family, imp);
        if (mod !== null && "file" in mod) targets.push({ target: mod.file, line: imp.line, column: imp.column, ev: mod.ev, reexport: imp.reexport });
        if (family === "ruby") continue;
        if (imp.reexport) continue; // re-exports bind nothing locally
        if (imp.scoped) continue; // binds only in its own scope, through CallFact.bound
        if (imp.star) {
          b.stars.push(mod);
          continue;
        }
        if (family === "go") {
          const local = imp.namespace ?? (mod !== null && "file" in mod ? pkgName.get(mod.file) : undefined) ?? goGuess(imp.spec);
          b.names.set(local, { kind: "ns", mod });
          continue;
        }
        if (imp.namespace && family === "python") {
          // `import a.b` binds `a`; `import a.b as c` binds `c` to `a.b`.
          b.names.set(imp.namespace, { kind: "pyns", dotted: imp.alias ? imp.spec : imp.namespace });
        } else if (imp.namespace) b.names.set(imp.namespace, { kind: "ns", mod });
        for (const n of imp.names) b.names.set(n.local, { kind: "named", mod, imported: n.imported });
      }
      importTargets.set(file, targets);
      return b;
    },

    // A name a module offers to importers.
    exports(file: string, name: string, depth: number): Value | null {
      if (depth > MAX_DEPTH) return null;
      if (reading) reading.add(`${file}\0${name}`);
      const f = facts.get(file);
      if (!f) return known.has(file) ? { v: "miss", target: file, name, ev: SAME_SCOPE } : null;
      const family = familyOf(f.lang);
      if (family === "go") return pkgValue(pkgOf(file), name);
      if (family === "js") {
        // The export table: exported declarations, `export { a as b }`,
        // `export default`, CommonJS assignments, then re-exports. A private
        // top-level definition is never an export.
        if (name === "default" && f.defaultExport) return resolveLocal(file, f.defaultExport, depth + 1);
        const top = topByFile.get(file)?.get(name)?.filter((id) => defById.get(id)?.exported);
        if (top && top.length > 0) return { v: "sym", ids: top, ev: SAME_SCOPE };
        for (const e of f.exportsLocal) if (e.exported === name) return resolveLocal(file, e.local, depth + 1);
        // Every `export *` that offers the name: one definition binds; two
        // different ones are ambiguous (JavaScript exports neither).
        const starHits: { v: Value; spec: string }[] = [];
        for (const imp of f.imports) {
          if (!imp.reexport) continue;
          const named = imp.names.find((n) => n.local === name);
          if (!named && !imp.star) continue;
          const mod = jsSpec(file, imp.line, imp.spec);
          if (mod === null) {
            if (named) return { v: "miss", target: file, name, ev: SAME_SCOPE };
            continue;
          }
          if ("ext" in mod) {
            if (named) return { v: "ext" };
            continue;
          }
          if ("gap" in mod) {
            if (named) return { v: "gap", cause: mod.gap, note: mod.note, candidates: mod.candidates };
            continue;
          }
          if (named) return named.imported === "*" ? { v: "mod", file: mod.file, ev: mod.ev } : withEv(index.exports(mod.file, named.imported, depth + 1), mod.ev);
          if (imp.star) {
            const hit = withEv(index.exports(mod.file, name, depth + 1), mod.ev);
            if (hit && hit.v !== "miss") starHits.push({ v: hit, spec: imp.spec });
          }
        }
        return starValue(file, name, starHits) ?? { v: "miss", target: file, name, ev: SAME_SCOPE };
      }
      // Python: definitions, then names the module imported, then submodules of a package.
      const top = topByFile.get(file)?.get(name);
      if (top) return { v: "sym", ids: top, ev: SAME_SCOPE };
      if (index.bindings(file).names.has(name)) return resolveLocal(file, name, depth + 1);
      if (file.endsWith("__init__.py")) {
        const sub = pyModule(join(dirOf(file), name));
        if (sub) return { v: "mod", file: sub, ev: { kind: "import", tier: "certain", via: null, note: null, rule: "py-submodule" } };
      }
      for (const star of index.bindings(file).stars) {
        if (star === null || !("file" in star)) continue;
        const hit = index.exports(star.file, name, depth + 1);
        if (hit && hit.v !== "miss") return withEv(hit, star.ev);
      }
      return { v: "miss", target: file, name, ev: SAME_SCOPE };
    },

    // The method and the evidence of the inheritance steps to the class
    // that defines it (null when the class itself does).
    members(key: string, name: string, side: Side): { ids: string[]; ev: Ev | null } | null {
      return methodOn(key, name, side, 0);
    },
  };

  // The value of a name several `export *` statements offer. The same
  // definition (or module) reached twice is one value; different ones are
  // ambiguous: every candidate at the possible tier, with a note.
  function starValue(file: string, name: string, hits: { v: Value; spec: string }[]): Value | null {
    if (hits.length === 0) return null;
    const keyOf = (v: Value): string | null => (v.v === "sym" ? [...new Set(v.ids.map(stableKey))].sort().join("\0") : v.v === "mod" ? `mod:${v.file}` : v.v === "ext" ? "ext" : null);
    const distinct = new Map<string, { v: Value; spec: string }>();
    for (const h of hits) {
      const k = keyOf(h.v);
      if (k === null) return (hits[0] as { v: Value }).v; // a gap or a namespace: the first decides, as before
      if (!distinct.has(k)) distinct.set(k, h);
    }
    const first = hits[0] as { v: Value };
    if (distinct.size === 1) return first.v;
    const syms = [...distinct.values()].filter((h): h is { v: Extract<Value, { v: "sym" }>; spec: string } => h.v.v === "sym");
    const note = `${file} re-exports ${name} through export * from ${distinct.size} modules (${[...distinct.values()].map((h) => h.spec).join(", ")}); JavaScript exports neither, and a bundler may pick one.`;
    if (syms.length < 2) return { v: "gap", cause: "ambiguous", note, candidates: [...distinct.keys()] };
    const base = syms[0]?.v.ev as Ev;
    return { v: "sym", ids: syms.flatMap((h) => h.v.ids), ev: { ...base, tier: "possible", note: [base.note, note].filter(Boolean).join(" "), rule: "js-star-ambiguous" } };
  }

  // A value reached through a module step keeps that step's evidence.
  function withEv(v: Value | null, ev: Ev): Value | null {
    if (!v) return v;
    if (v.v === "sym" || v.v === "mod" || v.v === "pkg" || v.v === "pyns" || v.v === "miss") return { ...v, ev: chain(ev, v.ev) };
    return v;
  }

  const pkgValue = (dir: string, name: string): Value => {
    const ids = pkgTop.get(dir)?.get(name);
    return ids ? { v: "sym", ids, ev: SAME_SCOPE } : { v: "miss", target: `go:${dir}`, name, ev: SAME_SCOPE };
  };

  const modValue = (mod: Mod | { ns: string; ev: Ev }, family: Family, name: string, file: string): Value => {
    if (mod === null) return { v: "miss", target: file, name, ev: SAME_SCOPE };
    if ("ext" in mod) return { v: "ext" };
    if ("gap" in mod) return { v: "gap", cause: mod.gap, note: mod.note, candidates: mod.candidates };
    if ("ns" in mod) return { v: "pyns", dir: mod.ns, ev: mod.ev };
    return family === "go" ? { v: "pkg", dir: mod.file, ev: mod.ev } : { v: "mod", file: mod.file, ev: mod.ev };
  };

  const bindingValue = (file: string, family: Family, name: string, b: Binding, depth: number): Value | null => {
    if (b.kind === "pyns") return { v: "pymod", from: file, dotted: b.dotted };
    const mod = b.mod;
    if (b.kind === "ns" || mod === null || "ext" in mod || "gap" in mod) return modValue(mod, family, name, file);
    if ("ns" in mod) return withEv(attr({ v: "pyns", dir: mod.ns, ev: SAME_SCOPE }, b.imported), mod.ev);
    return withEv(index.exports(mod.file, b.imported, depth + 1), mod.ev);
  };

  // What a name a scoped import binds means: the same as a file-wide import
  // of it would, for the one scope the import was made in.
  const boundValue = (file: string, name: string, ref: BoundImport): Value | null => {
    const f = facts.get(file);
    const imp = f?.imports[ref.import];
    if (!f || !imp) return null;
    const family = familyOf(f.lang);
    if (family === "python" && ref.imported === "*") return { v: "pymod", from: file, dotted: imp.alias ? imp.spec : (imp.namespace ?? imp.spec) };
    if (family !== "python" && family !== "js") return null;
    const mod = moduleOf(file, family, imp);
    const b: Binding = ref.imported === "*" ? { kind: "ns", mod } : { kind: "named", mod, imported: ref.imported };
    return bindingValue(file, family, name, b, 0);
  };

  // What a bare name means in a file.
  const resolveLocal = (file: string, name: string, depth = 0): Value | null => {
    const f = facts.get(file);
    if (!f || depth > MAX_DEPTH) return null;
    const family = familyOf(f.lang);
    if (family === "go") {
      const ids = pkgTop.get(pkgOf(file))?.get(name);
      if (ids) return { v: "sym", ids, ev: SAME_SCOPE };
    } else {
      const top = topByFile.get(file)?.get(name);
      if (top) return { v: "sym", ids: top, ev: SAME_SCOPE };
    }
    const b = index.bindings(file).names.get(name);
    if (b) return bindingValue(file, family, name, b, depth);
    for (const star of index.bindings(file).stars) {
      if (star === null || !("file" in star)) continue;
      const hit = index.exports(star.file, name, depth + 1);
      if (hit && hit.v !== "miss") return withEv(hit, star.ev);
    }
    if (family === "go") {
      // Dot imports bring a package's names into scope.
      for (const star of index.bindings(file).stars) if (star !== null && "ext" in star) return { v: "ext" };
    }
    return null;
  };

  const attr = (value: Value | null, name: string): Value | null => {
    if (!value) return null;
    if (value.v === "ext" || value.v === "gap") return value;
    if (value.v === "miss") return null;
    if (value.v === "mod") return withEv(index.exports(value.file, name, 0), value.ev);
    if (value.v === "pkg") return withEv(pkgValue(value.dir, name), value.ev);
    if (value.v === "pyns") {
      const sub = pyModule(join(value.dir, name));
      if (sub) return { v: "mod", file: sub, ev: value.ev };
      return pyDirs.has(join(value.dir, name)) ? { v: "pyns", dir: join(value.dir, name), ev: value.ev } : { v: "miss", target: value.dir, name, ev: value.ev };
    }
    if (value.v === "pymod") {
      const dotted = `${value.dotted}.${name}`;
      const sub = pySpec(value.from, 0, dotted);
      if (sub !== null && "file" in sub) return { v: "mod", file: sub.file, ev: sub.ev };
      if (sub !== null && "ns" in sub) return { v: "pyns", dir: sub.ns, ev: sub.ev };
      const mod = pySpec(value.from, 0, value.dotted);
      if (mod !== null && "ext" in mod) return { v: "ext" };
      // A module the name cannot settle (ambiguous, missing): the gap stands for every name read from it.
      if (mod !== null && "gap" in mod) return { v: "gap", cause: mod.gap, note: mod.note, candidates: mod.candidates };
      if (mod === null) return null;
      if ("ns" in mod) return attr({ v: "pyns", dir: mod.ns, ev: mod.ev }, name);
      return withEv(index.exports(mod.file, name, 0), mod.ev);
    }
    const key = value.ids.length === 1 ? classOfId.get(value.ids[0] as string) : undefined;
    if (!key) return null;
    const m = index.members(key, name, "s");
    return m ? { v: "sym", ids: m.ids, ev: m.ev ? chain(value.ev, m.ev) : value.ev } : { v: "miss", target: key, name, ev: value.ev };
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
  // A Ruby constant's evidence: defined in the caller's own file, or found
  // in another file by the autoload convention.
  const rbConstEv = (key: string, file: string): Ev =>
    classes.get(key)?.files.has(file)
      ? SAME_SCOPE
      : { kind: "autoload", tier: "likely", via: null, note: "The Ruby constant was found by the autoload convention, not by a require.", rule: "rb-autoload-const" };

  // The class a type name in `file` stands for, with the evidence of that
  // name's binding. A function's name stands for its declared result type
  // at the position the call took. `ext`: the type comes from a dependency.
  type TypeHit = { key: string; ev: Ev } | "ext" | null;
  const typeKey = (file: string, family: Family, t: TypeRef, depth = 0): TypeHit => {
    if (t.elem || depth > MAX_DEPTH) return null;
    if (family === "ruby") {
      const key = rbConst(t.name, t.qualifier);
      return key ? { key, ev: rbConstEv(key, file) } : null;
    }
    // The head name, through the scoped import that binds it where the type was read.
    const head = (name: string) => (t.bound ? boundValue(file, name, t.bound) : resolveLocal(file, name));
    let v: Value | null;
    if (t.qualifier) {
      const parts = t.qualifier.split(".");
      v = head(parts[0] as string);
      for (const p of parts.slice(1)) v = attr(v, p);
      v = v && v.v !== "sym" ? attr(v, t.name) : null;
    } else v = head(t.name);
    if (v?.v === "ext") return "ext";
    if (v?.v !== "sym" || v.ids.length !== 1) return null;
    const cls = classOfId.get(v.ids[0] as string);
    if (cls) return { key: cls, ev: v.ev };
    const def = defById.get(v.ids[0] as string);
    const result = def?.results?.[t.result ?? 0];
    if (!def || !result) return null;
    const inner = typeKey(def.file, def.family, { ...result, result: undefined }, depth + 1);
    return inner === null || inner === "ext" ? inner : { key: inner.key, ev: chain(v.ev, inner.ev) };
  };

  const baseKeys = new Map<string, { keys: string[]; evs: Ev[]; outside: boolean }>();
  // The in-repo base classes of a class, each with the evidence of the name
  // that binds it, and whether any base is outside the graph.
  const basesOf = (key: string): { keys: string[]; evs: Ev[]; outside: boolean } => {
    let out = baseKeys.get(key);
    if (out) return out;
    out = { keys: [], evs: [], outside: false };
    baseKeys.set(key, out);
    const info = classes.get(key);
    if (!info) return out;
    for (const b of info.bases) {
      const k = typeKey(info.file, info.family, b);
      if (k !== null && k !== "ext" && k.key !== key) {
        out.keys.push(k.key);
        out.evs.push(k.ev);
      } else if (k === null || k === "ext") out.outside = true;
    }
    return out;
  };

  // A step from a class to its base: the base binding's evidence, then
  // what was found past it. The weakest step decides the tier.
  const throughBase = (base: Ev, past: Ev | null): Ev => (past ? chain(base, past) : base);

  function methodOn(key: string, name: string, side: Side, depth: number): { ids: string[]; ev: Ev | null } | null {
    if (depth > MAX_DEPTH) return null;
    const own = methods.get(sideKey(key, side))?.get(name);
    if (own) return { ids: own, ev: null };
    // A Ruby module's instance methods are called on the module itself
    // through module_function or extend self.
    const info = classes.get(key);
    if (side === "s" && info?.family === "ruby" && info.ids.every((id) => defById.get(id)?.kind === "module")) {
      const viaModule = methods.get(sideKey(key, "i"))?.get(name);
      if (viaModule) return { ids: viaModule, ev: null };
    }
    const b = basesOf(key);
    for (let i = 0; i < b.keys.length; i++) {
      const hit = methodOn(b.keys[i] as string, name, side, depth + 1);
      if (hit) return { ids: hit.ids, ev: throughBase(b.evs[i] as Ev, hit.ev) };
    }
    return null;
  }

  // Whether any class in the base chain of `key` is outside the graph.
  const outsideBase = (key: string, depth = 0): boolean => {
    if (depth > MAX_DEPTH) return true;
    const b = basesOf(key);
    return b.outside || b.keys.some((k) => outsideBase(k, depth + 1));
  };

  const fieldKey = (key: string, field: string, depth = 0): TypeHit => {
    if (depth > MAX_DEPTH) return null;
    const info = classes.get(key);
    const t = info?.fields.get(field);
    if (info && t) return typeKey(info.file, info.family, t);
    const b = basesOf(key);
    for (let i = 0; i < b.keys.length; i++) {
      const hit = fieldKey(b.keys[i] as string, field, depth + 1);
      if (hit === "ext") return hit;
      if (hit) return { key: hit.key, ev: throughBase(b.evs[i] as Ev, hit.ev) };
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
  type Outcome =
    | { ids: string[]; ev: Ev }
    | { miss: { target: string; name: string }; ev: Ev; cause: Cause }
    | { ext: true }
    | "ignore"
    | { unknown: Cause; shape: Shape; note?: string; candidates?: string[] | null; scope?: "file" | "project" };

  const receiverKind = (t: TypeRef, path: string[]): EvidenceKind => {
    if (path.length > 0) return "receiver-field";
    if (t.declared) return "receiver-annotation";
    if (t.result !== undefined) return "receiver-result";
    return "receiver-constructor";
  };

  const fromValue = (v: Value | null, shape: Shape): Outcome => {
    if (!v) return { unknown: "no-receiver-type", shape };
    if (v.v === "ext") return { ext: true };
    if (v.v === "gap") return { unknown: v.cause, shape, note: v.note, candidates: v.candidates };
    if (v.v === "miss") return { miss: { target: v.target, name: v.name }, ev: v.ev, cause: "miss" };
    if (v.v === "sym") return { ids: v.ids, ev: v.ev };
    // A CommonJS module called as a function calls what `module.exports` holds.
    if (v.v === "mod" && familyOf(facts.get(v.file)?.lang ?? "go") === "js" && facts.get(v.file)?.defaultExport) {
      return fromValue(withEv(index.exports(v.file, "default", 0), v.ev), shape);
    }
    return "ignore"; // a module, a package or an outside module called as a function
  };

  const onClass = (key: string, name: string, side: Side, ev: Ev): Outcome => {
    const info = classes.get(key);
    if (name === "new" && side === "s" && info?.family === "ruby") return { ids: info.ids, ev };
    const hit = index.members(key, name, side);
    if (hit) return { ids: hit.ids, ev: hit.ev ? chain(ev, hit.ev) : ev };
    // Not on the class or its bases in the repository: inherited from a
    // base outside the graph, or gone.
    // An interface or a type alias: its members are not definitions the
    // graph follows yet (phase 2 binds calls through them).
    if (info && info.ids.every((id) => defById.get(id)?.kind === "type")) return { miss: { target: key, name }, ev, cause: "no-receiver-type" };
    return { miss: { target: key, name }, ev, cause: outsideBase(key) ? "no-receiver-type" : "miss" };
  };

  const followPath = (start: TypeHit, path: string[]): TypeHit => {
    let k = start;
    for (const p of path) {
      if (k === null || k === "ext") return k;
      const next = fieldKey(k.key, p);
      k = next === null || next === "ext" ? next : { key: next.key, ev: chain(k.ev, next.ev) };
    }
    return k;
  };

  const rbGlobal = (name: string): Outcome => {
    const ids = rbTop.get(name);
    const files = filesByName.get(`ruby:${name}`)?.size ?? 0;
    if (ids && ids.length === 1 && files <= HUB_FILES) {
      return { ids, ev: { kind: "autoload", tier: "likely", via: null, note: "The only Ruby definition of this name, in at most 8 files, bound by the autoload convention.", rule: "rb-autoload-global" } };
    }
    if (files > 0) return { unknown: "ambiguous", shape: "bare", note: `${files} files define ${name}`, candidates: [...(filesByName.get(`ruby:${name}`) ?? [])].slice(0, 8) };
    return { unknown: "miss", shape: "bare", note: `no definition of ${name} in the repository` };
  };

  const resolveCall = (file: string, family: Family, call: CallFact, caller: Def | undefined): Outcome => {
    const r = call.recv;
    if (call.dynamic) return { unknown: "dynamic", shape: "other", note: "a computed callee: the graph cannot tell which function it calls", scope: "project" };
    const builtin = BUILTINS[family].has(call.name);
    switch (r.kind) {
      case "none": {
        if (family === "ruby") return builtin ? { ext: true } : rbGlobal(call.name);
        if (call.local !== undefined) return { ids: [symbolId(file, facts.get(file)?.defs[call.local] as DefFact)], ev: SAME_SCOPE };
        if (call.bound) return fromValue(boundValue(file, call.name, call.bound), "bare");
        if (call.shadowed) return { unknown: "dynamic", shape: "bare", note: "a call through a parameter or a local value", scope: "project" };
        const v = resolveLocal(file, call.name);
        if (!v) {
          if (builtin) return { ext: true };
          return { miss: { target: family === "go" ? `go:${pkgOf(file)}` : file, name: call.name }, ev: SAME_SCOPE, cause: "miss" };
        }
        return fromValue(v, "bare");
      }
      case "self": {
        // self in a static method or a class body is the class; a field of it is an instance.
        const side: Side = call.static && r.path.length === 0 ? "s" : "i";
        const own = enclosingClass(file, family, caller);
        if (!own) return { unknown: "no-receiver-type", shape: "self", note: "this or self outside a method of a class" };
        const key = followPath({ key: own, ev: { kind: "receiver-self", tier: "certain", via: null, note: null, rule: "receiver-self" } }, r.path);
        if (key === "ext") return { ext: true };
        if (key === null) return { unknown: "no-receiver-type", shape: "self", note: "a field whose type no rule knows" };
        const ev: Ev = { ...key.ev, kind: r.path.length > 0 ? "receiver-field" : "receiver-self" };
        const out = onClass(key.key, call.name, side, ev);
        if (family === "ruby" && r.path.length === 0 && typeof out === "object" && "miss" in out) {
          const global = rbGlobal(call.name);
          if (typeof global === "object" && "ids" in global) return global;
          if (builtin) return { ext: true };
        }
        return out;
      }
      case "super": {
        const key = enclosingClass(file, family, caller);
        const bases = key ? basesOf(key) : null;
        const base = bases?.keys[0];
        if (!base) return key && outsideBase(key) ? { unknown: "no-receiver-type", shape: "self", note: "the base class is outside the graph" } : { unknown: "no-receiver-type", shape: "self" };
        // super is the base class as the class's own declaration binds it.
        const superEv = chain({ kind: "receiver-self", tier: "certain", via: null, note: null, rule: "receiver-super" }, bases.evs[0] as Ev);
        return onClass(base, call.name, call.static ? "s" : "i", superEv);
      }
      case "type": {
        // `any`, `unknown`, `object`, an object type written in place (Python
        // `object`, `typing.Any`; Go `any`), unless the file defines the name.
        const untyped = r.type.result === undefined && !r.type.elem && UNTYPED[family].has(r.type.name) && (r.type.qualifier === null || (family === "python" && r.type.qualifier === "typing"));
        if (untyped && resolveLocal(file, r.type.name)?.v !== "sym") {
          return { unknown: "untyped-receiver", shape: "typed", note: `a value typed ${r.type.name === "{}" ? "by an object type written in place" : r.type.name} may be anything with a method of this name` };
        }
        const t = typeKey(file, family, r.type);
        if (t === "ext") return { ext: true };
        // A collection itself (an array, a list, a slice) or a value of a
        // built-in type the file does not redefine: the method is the
        // language's own.
        if (t === null && r.path.length === 0 && (r.type.elem || (!r.type.qualifier && BUILTIN_TYPES[family].has(r.type.name) && resolveLocal(file, r.type.name) === null))) return { ext: true };
        if (t === null) {
          const named = `${r.type.qualifier ? `${r.type.qualifier}.` : ""}${r.type.name}`;
          // `result`: the value is what calling `named` returns, not a type of that name.
          const note = r.type.result !== undefined ? `what ${named} returns is not known to the graph` : `the type ${named} is not found in the graph`;
          return { unknown: "no-receiver-type", shape: "typed", note };
        }
        const key = followPath(t, r.path);
        if (key === "ext") return { ext: true };
        if (key === null) return { unknown: "no-receiver-type", shape: "typed", note: "a field whose type no rule knows" };
        return onClass(key.key, call.name, "i", { ...key.ev, kind: receiverKind(r.type, r.path), rule: "receiver-type" });
      }
      case "name": {
        if (family === "ruby") {
          const key = rbConst(r.name, r.nesting);
          if (!key) return { unknown: "no-receiver-type", shape: "name", note: `the constant ${r.name} is not defined in the repository` };
          return onClass(key, call.name, "s", rbConstEv(key, file));
        }
        let v = r.bound ? boundValue(file, r.name, r.bound) : resolveLocal(file, r.name);
        if (!v) return BUILTINS[family].has(r.name) ? { ext: true } : { unknown: "no-receiver-type", shape: "name" };
        // A path through a module or package; a field of a class value is not followed.
        for (const p of r.path) v = v?.v === "sym" ? null : attr(v, p);
        if (!v) return { unknown: "no-receiver-type", shape: "name" };
        if (v.v === "ext") return { ext: true };
        if (v.v === "gap") return { unknown: v.cause, shape: "name", note: v.note, candidates: v.candidates };
        if (v.v === "sym") {
          const key = v.ids.length === 1 ? classOfId.get(v.ids[0] as string) : undefined;
          return key ? onClass(key, call.name, "s", v.ev) : { unknown: "no-receiver-type", shape: "name", note: `${r.name} is not a class or a module` };
        }
        return fromValue(attr(v, call.name), "name");
      }
      default:
        return { unknown: "no-receiver-type", shape: "other" };
    }
  };

  const siteOf = (file: string, line: number, column: number, ev: Ev): GraphSite => ({ file, line, column, tier: ev.tier, evidence: ev.kind, via: ev.via ? { file: ev.via.file, line: ev.via.line, spec: ev.via.spec } : null, note: ev.note, rule: ev.rule });

  const stableTargets = (out: Outcome): string[] | null => (typeof out === "object" && "ids" in out ? [...new Set(out.ids.map(stableKey))].sort() : null);

  // ---------- the world ----------
  const resolveAll = (): Resolved => {
    const edgeMap = new Map<string, GraphEdge>();
    const addEdge = (from: string, to: string, kind: GraphEdge["kind"], site: GraphSite) => {
      const k = `${from}\u0000${to}\u0000${kind}`;
      let e = edgeMap.get(k);
      if (!e) {
        e = { from, to, kind, tier: site.tier, sites: [] };
        edgeMap.set(k, e);
      }
      if (weakest(e.tier, site.tier) === e.tier && e.tier !== site.tier) e.tier = site.tier;
      e.sites.push(site);
    };
    const misses: Miss[] = [];
    const unknowns: UnknownSite[] = [];
    let unresolvedSites = 0;
    let externalSites = 0;
    const budgetFiles: string[] = [];
    let stopped = false;

    for (const { path, facts: f } of input.files) {
      if (!stopped && input.stop?.()) stopped = true;
      if (stopped) {
        budgetFiles.push(path);
        continue;
      }
      const family = familyOf(f.lang);
      const defIds = f.defs.map((d) => symbolId(path, d));
      for (const call of f.calls) {
        const callerId = call.caller >= 0 ? (defIds[call.caller] as string) : path;
        const caller = call.caller >= 0 ? defById.get(callerId) : undefined;
        const out = resolveCall(path, family, call, caller);
        if (out === "ignore") continue;
        if ("ext" in out) {
          externalSites++;
          continue;
        }
        if ("unknown" in out) {
          if (call.implicit) continue;
          unresolvedSites++;
          const u: UnknownSite = { file: path, line: call.line, column: call.column, name: call.name, cause: out.unknown, shape: out.shape, caller: callerId, scope: out.scope ?? "file" };
          if (out.note) u.note = out.note;
          if (out.candidates) u.candidates = out.candidates;
          unknowns.push(u);
          continue;
        }
        if ("miss" in out) {
          misses.push({ target: out.miss.target, name: out.miss.name, from: callerId, site: siteOf(path, call.line, call.column, out.ev) });
          if (call.implicit) continue;
          unresolvedSites++;
          const shape: Shape = call.recv.kind === "none" ? "bare" : call.recv.kind === "self" || call.recv.kind === "super" ? "self" : call.recv.kind === "type" ? "typed" : call.recv.kind === "name" ? "name" : "other";
          unknowns.push({
            file: path,
            line: call.line,
            column: call.column,
            name: call.name,
            cause: out.cause,
            shape,
            caller: callerId,
            scope: "file",
            note:
              out.cause === "miss"
                ? `no definition of ${call.name} where the evidence points (${out.miss.target.split("\u0000").join(" ")})`
                : `${out.miss.target.split("::").pop()} is an interface or a type alias, or inherits from a class outside the graph`,
          });
          continue;
        }
        // Several ids only when one name has several definitions in one place
        // (overloads, a reopened Ruby class): each gets the site.
        // A recursive call is kept as a self-edge; the impact walk stops cycles.
        for (const to of out.ids) addEdge(callerId, to, "calls", siteOf(path, call.line, call.column, out.ev));
      }
      // Inheritance: class to base class.
      f.defs.forEach((d, i) => {
        if (d.bases.length === 0) return;
        for (const b of d.bases) {
          const key = typeKey(path, family, b);
          if (key === null || key === "ext") continue;
          const info = classes.get(key.key);
          if (!info) continue;
          for (const to of info.ids) {
            if (to === defIds[i]) continue;
            addEdge(defIds[i] as string, to, "inherits", siteOf(path, b.line, b.column, key.ev));
          }
        }
      });
    }

    // ---------- importers ----------
    const importers = new Map<string, GraphEdge[]>();
    for (const { path, facts: f } of input.files) {
      index.bindings(path);
      const family = familyOf(f.lang);
      const seen = new Set<string>();
      for (const t of importTargets.get(path) ?? []) {
        // Go: the target is a package folder; files of one package do not import each other.
        const key = family === "go" ? `go:${t.target}` : t.target;
        if (seen.has(key) || (family === "go" && t.target === dirOf(path))) continue;
        seen.add(key);
        const site = siteOf(path, t.line, t.column, t.ev);
        push(importers, key, { from: path, to: key, kind: "imports", tier: site.tier, sites: [site] } as GraphEdge);
      }
    }

    return { nodes, edges: [...edgeMap.values()], importers, defsByFile, misses, unknowns, unresolvedSites, externalSites, budgetFiles };
  };

  const trace = (files: Iterable<string>): SiteTrace[] => {
    const out: SiteTrace[] = [];
    for (const path of files) {
      const f = facts.get(path);
      if (!f) continue;
      const family = familyOf(f.lang);
      const defIds = f.defs.map((d) => symbolId(path, d));
      for (const call of f.calls) {
        const callerId = call.caller >= 0 ? (defIds[call.caller] as string) : path;
        const caller = call.caller >= 0 ? defById.get(callerId) : undefined;
        const record = new Set<string>();
        reading = record;
        const result = resolveCall(path, family, call, caller);
        reading = null;
        const reads = [...record];
        if (reads.length > 0) out.push({ file: path, line: call.line, column: call.column, from: callerId, reads, targets: stableTargets(result) });
      }
      // Import bindings: a named import reads the export it names even when
      // no call uses it.
      if (family === "js" || family === "python") {
        for (const imp of f.imports) {
          if (imp.reexport || imp.names.length === 0) continue;
          const mod = moduleOf(path, family, imp);
          if (mod === null || !("file" in mod)) continue;
          for (const n of imp.names) {
            if (n.imported === "*") continue;
            const record = new Set<string>();
            reading = record;
            const v = index.exports(mod.file, n.imported, 1);
            reading = null;
            const reads = [...record];
            out.push({ file: path, line: imp.line, column: imp.column, from: path, reads, targets: v?.v === "sym" ? [...new Set(v.ids.map(stableKey))].sort() : null });
          }
        }
      }
    }
    return out;
  };

  // The names a JS module exports and the line that exports each: its own
  // exports and named re-exports first, then every name an `export *`
  // brings that is not already there (never "default"). Walked without
  // recursion, each file once: a file's names are kept when its walk
  // finished without meeting a file still being walked (a cycle) or the
  // step budget, so a diamond of barrels costs one visit a file and a cycle
  // ends where it closes.
  const jsNames = new Map<string, Map<string, number | null>>();
  let walkSteps = 0;
  let walkCut: Cut | null = null;
  type Frame = { file: string; names: Map<string, number | null>; stars: { file: string; line: number }[]; next: number; partial: boolean };
  const ownJsNames = (file: string): Frame => {
    const names = new Map<string, number | null>();
    const stars: { file: string; line: number }[] = [];
    const f = facts.get(file);
    if (f) {
      for (const d of f.defs) if (d.topLevel && d.exported) names.set(d.name, d.line);
      for (const e of f.exportsLocal) names.set(e.exported, e.line ?? null);
      if (f.defaultExport) names.set("default", null);
      for (const imp of f.imports) {
        if (!imp.reexport) continue;
        for (const n of imp.names) names.set(n.local, imp.line);
        if (imp.star) {
          const mod = jsSpec(file, imp.line, imp.spec);
          if (mod !== null && "file" in mod) stars.push({ file: mod.file, line: imp.line });
        }
      }
    }
    return { file, names, stars, next: 0, partial: false };
  };
  const exportedJsNames = (root: string): Map<string, number | null> => {
    const kept = jsNames.get(root);
    if (kept) return kept;
    const merge = (into: Frame, from: Map<string, number | null>, line: number) => {
      for (const [k] of from) if (!into.names.has(k) && k !== "default") into.names.set(k, line);
    };
    const open = new Set<string>([root]);
    const stack: Frame[] = [ownJsNames(root)];
    for (;;) {
      const top = stack[stack.length - 1] as Frame;
      if (top.next < top.stars.length) {
        const star = top.stars[top.next++] as { file: string; line: number };
        const done = jsNames.get(star.file);
        if (done) merge(top, done, star.line);
        else if (open.has(star.file)) top.partial = true;
        else if (walkSteps >= EXPORT_WALK_STEPS) {
          top.partial = true;
          walkCut ??= {
            by: "export-walk",
            at: root,
            omitted: null,
            exact: false,
            unit: "files",
            note: `the walk of export * stopped after ${EXPORT_WALK_STEPS} files; names re-exported past it were not compared`,
          };
        } else {
          walkSteps++;
          open.add(star.file);
          stack.push(ownJsNames(star.file));
        }
        continue;
      }
      stack.pop();
      open.delete(top.file);
      if (!top.partial) jsNames.set(top.file, top.names);
      const parent = stack[stack.length - 1];
      if (!parent) return top.names;
      merge(parent, top.names, (parent.stars[parent.next - 1] as { line: number }).line);
      if (top.partial) parent.partial = true;
    }
  };

  const surface = (file: string): Map<string, { target: ExportTarget | null; line: number | null }> => {
    const out = new Map<string, { target: ExportTarget | null; line: number | null }>();
    const f = facts.get(file);
    if (!f) return out;
    const family = familyOf(f.lang);
    const targetOf = (v: Value | null): ExportTarget | null => {
      if (!v) return null;
      if (v.v === "ext") return "ext";
      if (v.v === "sym") return { keys: [...new Set(v.ids.map(stableKey))].sort(), ids: v.ids };
      if (v.v === "mod") return { keys: [v.file], ids: [v.file] };
      return null;
    };
    let names = new Map<string, number | null>();
    if (family === "js") {
      names = exportedJsNames(file);
    } else if (family === "python") {
      for (const d of f.defs) if (d.topLevel) names.set(d.name, d.line);
      for (const [k] of index.bindings(file).names) names.set(k, null);
    } else if (family === "go") {
      for (const d of f.defs) if (d.topLevel && d.exported) names.set(d.name, d.line);
    }
    for (const [name, line] of names) out.set(name, { target: targetOf(index.exports(file, name, 0)), line });
    return out;
  };

  const importsOf = (file: string): { target: string; reexport: boolean }[] => {
    index.bindings(file);
    return (importTargets.get(file) ?? []).map((t) => ({ target: t.target, reexport: t.reexport }));
  };

  let byKey: Map<string, GraphNode> | null = null;
  const node = (idOrKey: string): GraphNode | null => {
    const hit = nodes.get(idOrKey);
    if (hit) return hit;
    if (byKey === null) {
      byKey = new Map();
      for (const n of nodes.values()) if (!byKey.has(stableKey(n.id))) byKey.set(stableKey(n.id), n);
    }
    return byKey.get(idOrKey) ?? null;
  };

  return { resolveAll, trace, surface, importsOf, node, walkCuts: () => (walkCut ? [walkCut] : []) };
}

// The name an unaliased Go import is used by when its package is not in the
// repo: the last path element without a major version suffix.
function goGuess(spec: string): string {
  const parts = spec.split("/");
  let last = parts[parts.length - 1] ?? spec;
  if (/^v\d+$/.test(last) && parts.length > 1) last = parts[parts.length - 2] ?? last;
  return last.replace(/^go-/, "").replace(/[.-].*$/, "");
}

// The project folder of a file: its nearest package.json, go.mod,
// pyproject.toml, setup.cfg or Gemfile folder, else the repository root.
export function projectFolder(model: ProjectModel, goModules: [string, string][], file: string): string {
  let best = nodeProjectOf(model, file)?.dir ?? "";
  for (const [, dir] of goModules) if ((dir === "" || file.startsWith(`${dir}/`)) && dir.length > best.length) best = dir;
  for (const dir of model.pyRoots) if ((dir === "" || file.startsWith(`${dir}/`)) && dir.length > best.length) best = dir;
  return best;
}
