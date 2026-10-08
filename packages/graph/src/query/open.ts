// Opening a graph for questions: one way for the command line and the MCP
// server, so the two never answer from different builds of one tree.
//
// A pin captures the work tree, builds or reuses the graph in the owning
// repository's `.openqodex/graph/`, and holds the build it got with a lease,
// so no collection removes it while questions are answered from it (PLAN.md
// 3.2.7). A pin of a kept build (`--generation`) never builds. Each pin
// keeps the content of every eligible file as it was read (by facts key),
// so a later question can say that files changed since (`laterEditsKnown`)
// without building again.
import { getChange } from "@openqodex/core";
import type { Change } from "@openqodex/core";
import { buildGraph, factsKey } from "../build.js";
import { detectImpact } from "../impact.js";
import { langOf, takeInventory } from "../capture/inventory.js";
import { RepoReader } from "../safe-fs.js";
import { graphOf } from "../session.js";
import { BUILD_ID_PATTERN } from "../store/types.js";
import type { GraphStore, Lease, Purpose } from "../store/types.js";
import type { Graph } from "../types.js";
import type { ChangesExtra, Session } from "./answer.js";

export type GraphSettings = { budgetMs: number; maxFiles: number; maxFileBytes: number; maxHeapMb: number };

// The ten-minute budget and no parse cap of `graph build`, the memory bound kept.
export const BUILD_ALL_MS = 600_000;

// What a pin read: path to facts key for each eligible file whose content
// it knows, and the paths it knows were there without their content (left
// out of the build: too large, past a cap).
export type Reference = { keys: Map<string, string>; present: Set<string> };

export type Pinned = {
  session: Session;
  lease: Lease | null;
  // Set when the pin compared the work tree with a base.
  changes?: ChangesExtra;
  change?: Change;
  reference: Reference | null;
  release(): void;
};

// The facts key of every eligible file of the work tree now.
async function currentKeys(repoRoot: string, maxFileBytes: number): Promise<Reference> {
  const inv = await takeInventory(repoRoot, new RepoReader(repoRoot), { maxFileBytes });
  const keys = new Map<string, string>();
  for (const e of inv.entries) keys.set(e.path, factsKey(e.lang, e.blob));
  return { keys, present: new Set([...inv.tooBig, ...inv.unreadable]) };
}

// True when an eligible file was added, removed or changed since the pin read it.
export async function laterEdits(repoRoot: string, ref: Reference, maxFileBytes: number): Promise<boolean> {
  const now = await currentKeys(repoRoot, maxFileBytes);
  for (const [path, key] of now.keys) {
    const was = ref.keys.get(path);
    if (was === undefined ? !ref.present.has(path) : was !== key) return true;
  }
  for (const path of ref.keys.keys()) if (!now.keys.has(path) && !now.present.has(path)) return true;
  for (const path of ref.present) if (!now.keys.has(path) && !now.present.has(path) && langOf(path) !== null) return true;
  return false;
}

function sessionOf(store: GraphStore | null, graph: Graph): Session {
  const id = graph.status.generation;
  const m = store && id ? store.open({ id })?.manifest : undefined;
  return { graph, generation: id, treeSha: m?.capture.treeSha ?? null, builtAt: m?.createdAt ?? null, laterEditsKnown: false };
}

async function leaseOf(store: GraphStore | null, graph: Graph, purpose: Purpose): Promise<Lease | null> {
  if (!store || !graph.status.generation) return null;
  try {
    return (await store.lease({ id: graph.status.generation }, purpose))?.lease ?? null;
  } catch {
    // The folder's lock stayed busy or the lease file could not be written:
    // the answers still come from the graph in memory.
    return null;
  }
}

export type PinArgs = {
  repoRoot: string;
  store: GraphStore | null;
  storeRefused?: string;
  settings: GraphSettings;
  purpose: Purpose;
  // `graph build`: every file, no parse cap, the long budget.
  whole?: boolean;
  // Build fresh from facts even over the five-second line.
  full?: boolean;
  // Compare the work tree with its base: `changes`, and `impact` of the diff.
  compare?: { base?: string; exclude: string[]; defaultBase?: string | null };
  onProgress?: (line: string) => void;
};

// A capture of the work tree, built or reused, held by a lease.
export async function pinWorkTree(args: PinArgs): Promise<Pinned> {
  const { repoRoot, store, settings } = args;
  // Read before the build: an edit made while it runs shows as a later edit.
  const reference = await currentKeys(repoRoot, settings.maxFileBytes);
  let change: Change | undefined;
  if (args.compare) change = await getChange({ repoRoot, scope: args.compare.base !== undefined ? { base: args.compare.base } : {}, exclude: args.compare.exclude, defaultBase: args.compare.defaultBase });
  const graph = await buildGraph({
    repoRoot,
    store,
    storeRefused: args.storeRefused,
    capture: "working-tree",
    files: change?.changedPaths,
    base: change ? { sha: change.baseSha, files: change.files } : undefined,
    budgetMs: args.whole ? BUILD_ALL_MS : settings.budgetMs,
    maxFiles: args.whole ? Number.MAX_SAFE_INTEGER : settings.maxFiles,
    maxFileBytes: settings.maxFileBytes,
    maxHeapMb: settings.maxHeapMb,
    mode: args.full ? "fresh" : undefined,
    onProgress: args.onProgress,
  });
  let changes: ChangesExtra | undefined;
  if (change) {
    const impact = detectImpact(graph, change);
    const removed = impact.symbols.filter((s) => impact.removed.includes(s.id));
    // Every consumer of each changed public name: the summary's cap is for the brief only.
    changes = { exports: graph.exportChanges, removed: removed.filter((s) => !s.movedTo), moved: removed.filter((s) => s.movedTo) };
  }
  const lease = await leaseOf(store, graph, args.purpose);
  return { session: sessionOf(store, graph), lease, changes, change, reference, release: () => lease?.release() };
}

export type PinnedOrError = Pinned | { error: "generation-unavailable" | "unreadable"; message: string };

// A kept build by its id, held by a lease; it never builds.
export async function pinGeneration(store: GraphStore, id: string, purpose: Purpose): Promise<PinnedOrError> {
  if (!BUILD_ID_PATTERN.test(id)) return { error: "generation-unavailable", message: `${id} is not a build id` };
  const held = await store.lease({ id }, purpose);
  if (!held) return { error: "generation-unavailable", message: `no kept build ${id}` };
  const graph = graphOf(store, held.generation);
  if (!graph) {
    held.lease.release();
    return { error: "unreadable", message: `build ${id} could not be read back` };
  }
  let reference: Reference | null = null;
  try {
    const inv = JSON.parse(held.generation.read("inventory.json") ?? "null") as { files: Record<string, { key: string }> } | null;
    const cov = JSON.parse(held.generation.read("coverage.json") ?? "null") as { notRead: { file: string }[] } | null;
    if (inv?.files) reference = { keys: new Map(Object.entries(inv.files).map(([p, v]) => [p, v.key])), present: new Set((cov?.notRead ?? []).map((n) => n.file)) };
  } catch {
    reference = null;
  }
  const m = held.generation.manifest;
  const session: Session = { graph, generation: m.id, treeSha: m.capture.treeSha, builtAt: m.createdAt, laterEditsKnown: false };
  return { session, lease: held.lease, reference, release: () => held.lease.release() };
}
