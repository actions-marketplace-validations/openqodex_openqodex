// The shape of a question and of its answer, one for the review packet, the
// command line and the MCP tools (PLAN.md 3.3). Every answer carries what
// the graph does not know (`unknown`, with `floor` and the causes) and which
// build answered (`graph`). A count that cannot be known is null, never
// zero; search hits are leads and are never counted.
import type { Change, ImpactExportChange, ImpactSymbol } from "@openqodex/core";
import { toImpactUnknown } from "../impact.js";
import { API_VERSION } from "../model/records.js";
import type { Tier } from "../model/records.js";
import type { Graph, GraphNode } from "../types.js";
import type { Truncated } from "./page.js";

export const OPERATIONS = [
  "search",
  "symbol",
  "callers",
  "callees",
  "importers",
  "implementers",
  "references",
  "routes",
  "tests",
  "path",
  "impact",
  "outline",
  "packages",
  "cycles",
  "changes",
  "unknowns",
  "explain",
  "status",
  "capabilities",
] as const;
export type Operation = (typeof OPERATIONS)[number];

// A symbol by its id, a file and line (the innermost definition around
// it), a name (`name` or `Owner.name`, narrowed by `file`), a file or
// folder by its path, or a project by its folder.
export type Target = { id?: string; name?: string; file?: string; line?: number; project?: string };

export type Request = {
  apiVersion: number;
  kind: Operation;
  target?: Target;
  to?: Target; // path: the other end
  text?: string; // search
  tiers?: Tier[];
  edges?: string[]; // path: the relations to walk; default calls and inherits
  depth?: number;
  level?: "files" | "projects"; // cycles
  limit?: number;
  cursor?: string;
  // items: a page size; tokens: a cut of the items by their size, never of
  // the counts; ms: the time the question may take (default 1 s).
  budget?: { items?: number; tokens?: number; ms?: number };
  generation?: string; // omitted: the build the session holds
};

export type Candidate = { id: string; name: string; kind: string; file: string; line: number; project: string; score: number };

export type ErrorCode = "ambiguous" | "not-found" | "bad-request" | "generation-unavailable" | "unsupported" | "refused";

export type Answer = {
  apiVersion: number;
  kind: Operation;
  error: null | { code: ErrorCode; message: string };
  target: Candidate | Candidate[] | null;
  items: unknown[];
  counts: { certain: number | null; likely: number | null; possible: number | null };
  leads: Candidate[];
  unknown: { floor: boolean; reasons: string[]; causes: Record<string, number | null>; examples: ReturnType<typeof toImpactUnknown>[] };
  truncated: Truncated;
  graph: { generation: string | null; treeSha: string | null; builtAt: string | null; status: "ok" | "partial"; reasons: string[]; mode: "fresh" | "retained"; freshness: { laterEditsKnown: boolean } };
};

export type Session = {
  graph: Graph;
  generation: string | null;
  treeSha: string | null;
  builtAt: string | null;
  laterEditsKnown: boolean;
};

// What some questions need beyond the graph: the change compared with its
// base (`changes`), the diff the review walks (`impact`), and the caller's
// cancellation.
export type ChangesExtra = { exports: ImpactExportChange[]; removed: ImpactSymbol[]; moved: ImpactSymbol[] };
export type Extra = { changes?: ChangesExtra; change?: Pick<Change, "files" | "coverage">; signal?: AbortSignal };

export function graphBlock(s: Session): Answer["graph"] {
  const st = s.graph.status;
  return { generation: s.generation, treeSha: s.treeSha, builtAt: s.builtAt, status: st.status, reasons: st.reasons, mode: st.mode, freshness: { laterEditsKnown: s.laterEditsKnown } };
}

export function empty(s: Session, kind: Operation): Answer {
  const partial = s.graph.status.status === "partial";
  return {
    apiVersion: API_VERSION,
    kind,
    error: null,
    target: null,
    items: [],
    counts: { certain: null, likely: null, possible: null },
    leads: [],
    unknown: { floor: partial, reasons: partial ? s.graph.status.reasons : [], causes: {}, examples: [] },
    truncated: { by: null, omitted: 0, omittedExact: true, cursor: null },
    graph: graphBlock(s),
  };
}

export function fail(s: Session, kind: Operation, code: ErrorCode, message: string): Answer {
  return { ...empty(s, kind), error: { code, message } };
}

export const BAD_CURSOR = "the cursor belongs to another request or build";

export function candidate(g: Graph, n: GraphNode, score: number): Candidate {
  return { id: n.id, name: n.name, kind: n.kind, file: n.file, line: n.startLine, project: g.projectOf(n.file), score };
}

// "Owner.name" when the symbol has an owner, else the name.
export function qualified(n: GraphNode): string {
  const inner = n.id.slice(n.id.indexOf("#") + 1, n.id.lastIndexOf("@"));
  return inner || n.name;
}

// The symbols a target names: an id, a file and line (the innermost
// definition around it), or a name (`name` or `Owner.name`), narrowed by file.
export function resolveTarget(g: Graph, t: Target): GraphNode[] {
  if (t.id) {
    const n = g.nodes.get(t.id);
    return n ? [n] : [];
  }
  if (t.file && t.line !== undefined) {
    let inner: GraphNode | null = null;
    for (const d of g.defsByFile.get(t.file) ?? []) {
      if (t.line < d.startLine || t.line > d.endLine) continue;
      if (!inner || d.endLine - d.startLine < inner.endLine - inner.startLine) inner = d;
    }
    return inner ? [inner] : [];
  }
  if (t.file && !t.name) {
    const n = g.nodes.get(t.file);
    return n ? [n] : [];
  }
  if (!t.name) return [];
  const out: GraphNode[] = [];
  for (const n of g.nodes.values()) {
    if (n.kind === "file") continue;
    if (n.name !== t.name && qualified(n) !== t.name) continue;
    if (t.file && n.file !== t.file) continue;
    out.push(n);
  }
  return out;
}

// A target as a person or an agent writes it: `file:line`, or a name
// (`name` or `Owner.name`) narrowed to `file` when one is given. The
// command line and the MCP tools read targets with this one function.
export function parseTarget(value: string | undefined, file?: string): Target {
  if (value === undefined || value === "") return file ? { file } : {};
  const m = /^(.+):(\d+)$/.exec(value);
  if (m) return { file: m[1] as string, line: Number(m[2]) };
  return { name: value, ...(file ? { file } : {}) };
}

// One symbol or file for a question about one point, or the answer that
// says why there is none: not found, or several candidates and no silent pick.
export function onePoint(s: Session, kind: Operation, t: Target | undefined): GraphNode | Answer {
  const found = resolveTarget(s.graph, t ?? {});
  if (found.length === 0) return fail(s, kind, "not-found", "no symbol or file of that name in this graph; try `search`");
  if (found.length > 1) return { ...fail(s, kind, "ambiguous", `${found.length} definitions match; name one by its id or file and line`), target: found.map((n) => candidate(s.graph, n, 1)) };
  return found[0] as GraphNode;
}

export function counts(items: readonly { site: { tier: Tier } }[]): Answer["counts"] {
  const c = { certain: 0, likely: 0, possible: 0 };
  for (const i of items) c[i.site.tier]++;
  return c;
}
