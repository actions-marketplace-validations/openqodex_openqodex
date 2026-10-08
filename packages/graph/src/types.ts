// The code graph's own types. What the brief and the report see is
// ImpactSummary in @openqodex/core; these are the pieces it is built from.
import type { ImpactExportChange, ImpactKind, ImpactSite, ImpactSymbol } from "@openqodex/core";
import type { ProjectModel } from "./discovery/projects.js";
import type { Cause, Cut, Shape, Tier } from "./model/records.js";

export type Lang = "typescript" | "tsx" | "javascript" | "python" | "go" | "ruby";
// Calls bind only inside one family: a TypeScript file never calls Python.
export type Family = "js" | "python" | "go" | "ruby";

export function familyOf(lang: Lang): Family {
  if (lang === "python" || lang === "go" || lang === "ruby") return lang;
  return "js";
}

// ---------- facts one parse of one file yields (cached by content) ----------

// A type named in source: `Repo`, `pkg.Repo` (qualifier "pkg"), Ruby `A::B`
// (whole path in `name`, the lexical nesting in `qualifier`).
// `result`: the type is what calling the function `name` returns, at that
// position of its results (Go has several). `elem`: a slice, array, map or
// list of the type; a loop over it or an index into it yields the type.
// `declared`: from a type annotation, so a reassignment cannot change it.
// `bound`: the head name (`name`, or the first part of `qualifier`) is
// bound by a scoped import where the type was read.
export type TypeRef = { name: string; qualifier: string | null; line: number; column: number; result?: number; elem?: boolean; declared?: boolean; bound?: BoundImport };

export type DefFact = {
  name: string;
  kind: Exclude<ImpactKind, "file">;
  owner: string | null; // enclosing class or module; Go: the receiver type
  line: number;
  column: number;
  endLine: number;
  exported: boolean;
  topLevel: boolean; // bindable by name from the rest of the file
  bases: TypeRef[]; // classes: extends, superclasses, include; Go: embedded fields
  fields: Record<string, TypeRef>; // classes and structs: field name to its declared or constructed type
  results?: (TypeRef | null)[]; // functions and methods: the declared result types
  static?: boolean; // methods called on the class itself: JS `static`, Ruby `def self.x`
  // A hash of the definition without its name, comments and whitespace
  // (top-level definitions and members of top-level classes only).
  bodyHash?: string;
  // A TypeScript type alias: the type it stands for (`type Loose = any`).
  alias?: TypeRef;
};

// A name bound by an import made inside a function or a block, in that
// scope only: the import (an index into FileFacts.imports) and the name it
// imports, "*" for the whole module.
export type BoundImport = { import: number; imported: string };

// What stands before the dot of a call.
export type Receiver =
  | { kind: "none" } // a bare call: f()
  | { kind: "self"; path: string[] } // this, self, cls (path: this.a.b)
  | { kind: "super" }
  | { kind: "type"; type: TypeRef; path: string[] } // a local whose type a constructor or an annotation gives
  // An identifier: maybe a module, a package or a class; `bound` when a scoped import gives it.
  | { kind: "name"; name: string; path: string[]; nesting: string | null; bound?: BoundImport }
  | { kind: "other" };

export type CallFact = {
  name: string;
  line: number;
  column: number;
  caller: number; // index into defs, -1 for the file's top level
  recv: Receiver;
  // Ruby: a bare identifier that may be a method call. Bound only when the
  // enclosing class defines it, never counted as unresolved.
  implicit?: boolean;
  // A bare call bound by the enclosing scopes: `local` is a nested
  // definition (index into defs); `shadowed` means a parameter or local
  // variable of that name hides every outer definition.
  local?: number;
  shadowed?: boolean;
  bound?: BoundImport; // a bare call to a name a scoped import binds

  static?: boolean; // the caller runs on the class itself (static method, Ruby class body)
  // A computed callee (`table[key]()`): no name to bind. `name` is empty.
  dynamic?: boolean;
};

export type ImportFact = {
  spec: string; // the specifier as written: "./x.js", ".models", "example.com/m/pkg", "lib/x"
  line: number;
  column: number;
  names: { imported: string; local: string }[]; // "default" for a default import
  namespace: string | null; // a local bound to the whole module
  star: boolean; // `export * from`, Python `from x import *`
  reexport: boolean; // `export ... from`
  typeOnly: boolean;
  relative?: boolean; // Ruby require_relative
  alias?: boolean; // Python `import a.b as c`
  // Made inside a function or a block (`await import()`, a require, a Python
  // import in a function): it binds no name for the whole file, only through `bound`.
  scoped?: boolean;
};

export type FileFacts = {
  lang: Lang;
  defs: DefFact[];
  calls: CallFact[];
  imports: ImportFact[];
  exportsLocal: { local: string; exported: string; line?: number }[]; // `export { a as b }` without a source
  defaultExport: string | null; // the local name `export default` names
  goPackage: string | null;
};

// ---------- the graph ----------

export type GraphNode = ImpactSymbol & { exported: boolean; lang: Lang | null; bodyHash?: string };

export type GraphSite = ImpactSite;

export type GraphEdge = {
  from: string;
  to: string;
  kind: "calls" | "inherits" | "imports";
  tier: Tier; // the strongest tier among its sites
  sites: GraphSite[];
};

// A call site whose evidence named a place (a file, a class, a Go package)
// where no symbol of that name exists now. A removed symbol's surviving
// callers are found here.
export type Miss = { target: string; name: string; from: string; site: GraphSite };

// A call site no rule could bind, kept small: the full Unknown record of
// model/records.ts is made from it when an answer shows it. `scope`
// "project": the call goes through a value (a parameter, a computed
// member), so it could reach any function of its project.
export type UnknownSite = {
  file: string;
  line: number;
  column: number;
  name: string; // "" for a computed callee
  cause: Cause;
  shape: Shape;
  caller: string; // symbol id, or the file for top-level code
  scope: "file" | "project";
  note?: string;
  candidates?: string[];
};

// An eligible file the graph did not read, and why.
export type NotRead = { file: string; reason: "size" | "budget" | "parse-cap" | "memory" | "parse-error" | "slow-parse" | "unreadable" };

export type GraphStatus = {
  status: "ok" | "partial";
  reason: string | null;
  reasons: string[];
  filesParsed: number; // files in the graph: facts from a parse or the cache
  filesSkipped: number; // eligible but left out (size, budget, parse cap, memory)
  durationMs: number;
  eligibleFiles: number;
  cacheHits: number;
  parses: number; // files actually parsed this build (cache misses)
  unresolvedSites: number; // call sites in the repository no rule bound
  externalSites: number; // calls into declared dependencies and standard libraries
  mode: "fresh" | "retained";
  generation: string | null; // the build id the store published, null when not saved
  predictedMs: number | null;
  stages: Record<string, number>;
  cuts: Cut[];
  notRead: NotRead[];
};

export type Graph = {
  repoRoot: string; // the folder the files were read from
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  in: Map<string, GraphEdge[]>;
  out: Map<string, GraphEdge[]>;
  importers: Map<string, GraphEdge[]>; // target file or Go package folder to its import edges
  defsByFile: Map<string, GraphNode[]>; // current symbols per file
  removed: Map<string, GraphNode[]>; // per changed file: symbols in the base version and gone now; `movedTo` on a move the build found
  misses: Miss[];
  unknowns: UnknownSite[];
  // In-repo unbound call sites per called name, and value calls per project
  // folder: what makes a caller count a floor.
  unknownNames: Map<string, number>;
  valueCalls: Map<string, number>;
  model: ProjectModel;
  projectOf(file: string): string;
  exportChanges: ImpactExportChange[]; // set when the build compared a base; every consumer, never cut
  status: GraphStatus;
};

export type HotSymbol = { symbol: GraphNode; callers: number; sites: number; files: number };
