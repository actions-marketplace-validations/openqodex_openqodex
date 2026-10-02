// The code graph's own types. What the brief and the report see is
// ImpactSummary in @openqodex/core; these are the pieces it is built from.
import type { ImpactKind, ImpactSite, ImpactSymbol } from "@openqodex/core";

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
export type TypeRef = { name: string; qualifier: string | null; line: number; column: number; result?: number; elem?: boolean };

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
};

// What stands before the dot of a call.
export type Receiver =
  | { kind: "none" } // a bare call: f()
  | { kind: "self"; path: string[] } // this, self, cls (path: this.a.b)
  | { kind: "super" }
  | { kind: "type"; type: TypeRef; path: string[] } // a local whose type a constructor or an annotation gives
  | { kind: "name"; name: string; path: string[]; nesting: string | null } // an identifier: maybe a module, a package or a class
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
};

export type FileFacts = {
  lang: Lang;
  defs: DefFact[];
  calls: CallFact[];
  imports: ImportFact[];
  exportsLocal: { local: string; exported: string }[]; // `export { a as b }` without a source
  defaultExport: string | null; // the local name `export default` names
  goPackage: string | null;
};

// ---------- the graph ----------

export type GraphNode = ImpactSymbol & { exported: boolean; lang: Lang | null };

export type GraphSite = ImpactSite;

export type GraphEdge = {
  from: string;
  to: string;
  kind: "calls" | "inherits" | "imports";
  confidence: "high" | "low"; // high when any site is high
  sites: GraphSite[];
};

// A call site whose evidence named a place (a file, a class, a Go package)
// where no symbol of that name exists now. A removed symbol's surviving
// callers are found here.
export type Miss = { target: string; name: string; from: string; site: GraphSite };

export type GraphStatus = {
  status: "ok" | "partial";
  reason: string | null;
  reasons: string[];
  filesParsed: number; // facts read from a parse or the cache
  filesSkipped: number; // eligible but left out (size, budget, file cap)
  durationMs: number;
  eligibleFiles: number;
  cacheHits: number;
  parses: number; // files actually parsed this build (cache misses)
  unresolvedSites: number;
};

export type Graph = {
  repoRoot: string;
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  in: Map<string, GraphEdge[]>;
  out: Map<string, GraphEdge[]>;
  importers: Map<string, GraphEdge[]>; // target file or Go package folder to its import edges
  defsByFile: Map<string, GraphNode[]>; // current symbols per file
  removed: Map<string, GraphNode[]>; // per changed file: symbols in the base version and gone now
  misses: Miss[];
  status: GraphStatus;
};

export type HotSymbol = { symbol: GraphNode; callers: number; sites: number; files: number };
