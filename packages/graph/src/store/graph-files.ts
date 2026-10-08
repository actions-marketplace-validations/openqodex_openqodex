// The files of a generation that hold a graph: the project model
// (projects.json) and, for a build kept as an index, the resolved graph as
// JSON lines (index/*.jsonl). Reading an index back gives the same Graph
// the build made: retained equals fresh (test/session.test.ts checks).
import type { ProjectModel } from "../discovery/projects.js";
import { projectFolder } from "../resolve.js";
import type { Graph, GraphEdge, GraphNode, GraphStatus, Miss, UnknownSite } from "../types.js";
import type { OpenGeneration } from "./types.js";

type Plain = Record<string, unknown>;

export function serializeModel(m: ProjectModel): Plain {
  return {
    node: m.node.map((p) => ({ dir: p.dir, file: p.file, pkg: { ...p.pkg, deps: [...p.pkg.deps] } })),
    members: [...m.members].map(([k, v]) => [k, v.map((p) => p.file)]),
    workspaceFiles: m.workspaceFiles,
    tsconfigs: [...m.tsconfigs.values()],
    pyRoots: m.pyRoots,
    pyDeclared: [...m.pyDeclared],
    goRequires: m.goRequires,
    gems: [...m.gems],
    pnpmLinks: [...m.pnpmLinks].map(([k, v]) => [k, [...v]]),
    npmLock: [...m.npmLock],
    yarnWorkspace: [...m.yarnWorkspace],
    yarnPublished: [...m.yarnPublished],
  };
}

export function deserializeModel(v: Plain): ProjectModel {
  const node = (v.node as { dir: string; file: string; pkg: Plain & { deps: [string, string][] } }[]).map((p) => ({ dir: p.dir, file: p.file, pkg: { ...(p.pkg as object), deps: new Map(p.pkg.deps) } })) as ProjectModel["node"];
  const byFile = new Map(node.map((p) => [p.file, p]));
  return {
    node,
    members: new Map((v.members as [string, string[]][]).map(([k, files]) => [k, files.map((f) => byFile.get(f)).filter((p): p is ProjectModel["node"][number] => p !== undefined)])),
    workspaceFiles: v.workspaceFiles as string[],
    tsconfigs: new Map((v.tsconfigs as ProjectModel["tsconfigs"] extends Map<string, infer T> ? T[] : never).map((t) => [t.dir, t])),
    pyRoots: v.pyRoots as string[],
    pyDeclared: new Set(v.pyDeclared as string[]),
    goRequires: v.goRequires as string[],
    gems: new Set(v.gems as string[]),
    pnpmLinks: new Map((v.pnpmLinks as [string, [string, "workspace" | "published" | "unknown"][]][]).map(([k, list]) => [k, new Map(list)])),
    npmLock: new Map(v.npmLock as [string, "workspace" | "published" | "unknown"][]),
    yarnWorkspace: new Set(v.yarnWorkspace as string[]),
    yarnPublished: new Set(v.yarnPublished as string[]),
  };
}

const lines = (items: unknown[]) => items.map((x) => JSON.stringify(x)).join("\n");
const parseLines = <T>(text: string | null): T[] | null => {
  if (text === null) return null;
  try {
    return text === "" ? [] : text.split("\n").map((l) => JSON.parse(l) as T);
  } catch {
    return null;
  }
};

// The resolved graph as files of a generation.
export function writeIndex(g: Graph): Record<string, string> {
  return {
    "index/nodes.jsonl": lines([...g.nodes.values()]),
    "index/edges.jsonl": lines(g.edges),
    "index/importers.jsonl": lines([...g.importers.values()].flat()),
    "index/misses.jsonl": lines(g.misses),
    "index/unknowns.jsonl": lines(g.unknowns),
    "index/status.json": JSON.stringify(g.status),
  };
}

// A graph read back from a generation's index; null when the generation
// has no index or a file of it does not parse.
export function readIndex(gen: OpenGeneration): Omit<Graph, "repoRoot"> & { repoRoot: string } | null {
  if (!gen.manifest.hasIndex) return null;
  const nodes = parseLines<GraphNode>(gen.read("index/nodes.jsonl"));
  const edges = parseLines<GraphEdge>(gen.read("index/edges.jsonl"));
  const importerEdges = parseLines<GraphEdge>(gen.read("index/importers.jsonl"));
  const misses = parseLines<Miss>(gen.read("index/misses.jsonl"));
  const unknowns = parseLines<UnknownSite>(gen.read("index/unknowns.jsonl"));
  const statusText = gen.read("index/status.json");
  const projectsText = gen.read("projects.json");
  if (!nodes || !edges || !importerEdges || !misses || !unknowns || statusText === null || projectsText === null) return null;
  let status: GraphStatus;
  let projects: { model: Plain; goModules: [string, string][] };
  try {
    status = JSON.parse(statusText) as GraphStatus;
    projects = JSON.parse(projectsText) as typeof projects;
  } catch {
    return null;
  }
  return assemble(nodes, edges, importerEdges, misses, unknowns, status, deserializeModel(projects.model), projects.goModules);
}

export function assemble(
  nodeList: GraphNode[],
  edges: GraphEdge[],
  importerEdges: GraphEdge[],
  misses: Miss[],
  unknowns: UnknownSite[],
  status: GraphStatus,
  model: ProjectModel,
  goModules: [string, string][],
): Graph {
  const nodes = new Map<string, GraphNode>();
  const defsByFile = new Map<string, GraphNode[]>();
  for (const n of nodeList) {
    nodes.set(n.id, n);
    if (n.kind !== "file") (defsByFile.get(n.file) ?? defsByFile.set(n.file, []).get(n.file))?.push(n);
    else if (!defsByFile.has(n.file)) defsByFile.set(n.file, []);
  }
  const graphIn = new Map<string, GraphEdge[]>();
  const graphOut = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    (graphIn.get(e.to) ?? graphIn.set(e.to, []).get(e.to))?.push(e);
    (graphOut.get(e.from) ?? graphOut.set(e.from, []).get(e.from))?.push(e);
  }
  const importers = new Map<string, GraphEdge[]>();
  for (const e of importerEdges) (importers.get(e.to) ?? importers.set(e.to, []).get(e.to))?.push(e);
  const projectOf = (file: string) => projectFolder(model, goModules, file);
  const unknownNames = new Map<string, number>();
  const valueCalls = new Map<string, number>();
  for (const u of unknowns) {
    if (u.name !== "") unknownNames.set(u.name, (unknownNames.get(u.name) ?? 0) + 1);
    if (u.scope === "project") valueCalls.set(projectOf(u.file), (valueCalls.get(projectOf(u.file)) ?? 0) + 1);
  }
  return {
    repoRoot: "",
    nodes,
    edges,
    in: graphIn,
    out: graphOut,
    importers,
    defsByFile,
    removed: new Map(),
    misses,
    unknowns,
    unknownNames,
    valueCalls,
    model,
    projectOf,
    exportChanges: [],
    status,
  };
}
