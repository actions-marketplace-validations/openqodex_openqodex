// The collector: what the graph folder keeps, what it removes, and the size
// bound. It runs inside the folder lock (store.ts takes it), so a reader's
// lease and a collection never interleave.
//
// Kept: the generation `current` names, the one being published, the newest
// KEEP_COMPLETE complete generations, and every generation a lease protects
// (leases.ts). Every other valid generation is removed. A folder without a
// valid manifest may be a build still writing (manifests are written inside
// the lock), so it is removed only once it is an hour old.
//
// Facts no kept inventory names are removed only when every kept generation
// is complete: a partial build never justifies removing facts it did not
// visit (PLAN.md decision row 34). Facts under an hour old are also left:
// they may belong to a build that has not published yet.
//
// Over the size bound, oldest first: facts no kept inventory names, then
// facts no leased generation names. A kept or leased generation, a folder
// still being written, and facts a leased or publishing generation names
// are never removed; when they alone exceed the bound the report says so.
//
// Only folders the store verified (no link from the repo root down) are
// listed, and every removal goes through the Guard, which never follows a
// link: a link in the folder is removed as itself.
import { lstatSync, readdirSync, type Stats } from "node:fs";
import { join } from "node:path";
import { safeGit, type Guard } from "@openqodex/core";
import { LEASE_MAX_BYTES, LEASE_NAME, leaseProtects, parseLease } from "./leases.js";
import {
  BUILD_ID_PATTERN,
  FACTS_KEY_PATTERN,
  KEEP_COMPLETE,
  TREE_SHA_PATTERN,
  buildIdTime,
  type BuildId,
  type CollectReport,
  type GenerationManifest,
  type OverBudget,
} from "./types.js";

// How long a folder without a manifest, a temp file or facts no generation
// names may belong to a build still running.
export const STAGING_MS = 3600_000;
export const REF_PREFIX = "refs/openqodex/graph/";

// What the graph folder itself holds. Anything else there, such as a cache
// entry of the layout before this one (`graph/<sha1>.json`) or a temp file
// a crash left, is removed once it is an hour old.
const LAYOUT = new Set(["meta.json", "lock", "lock.takeover", "current", "facts", "generations", "leases", "complete"]);

export type CollectorContext = {
  repoRoot: string;
  guard: Guard;
  now: () => number;
  boundBytes: number;
  // The absolute path of a folder under the graph folder ("" for the graph
  // folder) when every folder from the repo root down to it is a real
  // folder; null otherwise.
  folder(rel: string): string | null;
  // The manifest of a generation whose every file matches it; else null.
  load(id: BuildId): GenerationManifest | null;
  // A file under the graph folder, read without following a link.
  read(rel: string, maxBytes: number): Buffer | null;
  // The build id a pointer file names (`current`, `complete/<tree>`).
  pointer(rel: string): BuildId | null;
  // The facts keys a valid generation's inventory names; null when it lists
  // an inventory that cannot be read.
  inventoryKeys(manifest: GenerationManifest): Set<string> | null;
};

type Entry = { abs: string; name: string; bytes: number; mtimeMs: number; folder: boolean };

function lstatQuiet(abs: string): Stats | null {
  try {
    return lstatSync(abs);
  } catch {
    return null;
  }
}

// Bytes of the files under `abs`, never following a link (a link counts
// its own size).
export function treeBytes(abs: string, st = lstatQuiet(abs)): number {
  if (st === null) return 0;
  if (!st.isDirectory()) return st.size;
  let names: string[];
  try {
    names = readdirSync(abs);
  } catch {
    return 0;
  }
  let total = 0;
  for (const name of names) total += treeBytes(join(abs, name));
  return total;
}

// What a verified folder holds, each entry by lstat.
function entries(ctx: CollectorContext, rel: string): Entry[] {
  const abs = ctx.folder(rel);
  if (abs === null) return [];
  let names: string[];
  try {
    names = readdirSync(abs);
  } catch {
    return [];
  }
  const out: Entry[] = [];
  for (const name of names) {
    const path = join(abs, name);
    const st = lstatQuiet(path);
    if (st !== null) out.push({ abs: path, name, bytes: treeBytes(path, st), mtimeMs: st.mtimeMs, folder: st.isDirectory() });
  }
  return out;
}

type Fact = { entry: Entry; key: string | null; gone: boolean };

// facts/<xx>/<key>.json; anything else there (a temp file, a link, a
// stray folder) has key null.
function factEntries(ctx: CollectorContext): Fact[] {
  const out: Fact[] = [];
  for (const sub of entries(ctx, "facts")) {
    if (!sub.folder || !/^[0-9a-f]{2}$/.test(sub.name)) {
      out.push({ entry: sub, key: null, gone: false });
      continue;
    }
    for (const entry of entries(ctx, `facts/${sub.name}`)) {
      const key = entry.name.endsWith(".json") ? entry.name.slice(0, -5) : "";
      const ok = !entry.folder && FACTS_KEY_PATTERN.test(key) && key.startsWith(sub.name) && lstatQuiet(entry.abs)?.isFile() === true;
      out.push({ entry, key: ok ? key : null, gone: false });
    }
  }
  return out;
}

export async function collectLocked(ctx: CollectorContext, incoming: BuildId | null): Promise<CollectReport> {
  const removedGenerations: BuildId[] = [];
  const removedRefs: string[] = [];
  let removedFacts = 0;
  const dir = ctx.folder("");
  if (dir === null) return { removedGenerations, removedFacts, removedRefs, bytesBefore: 0, bytesAfter: 0, overBudget: null };
  const now = ctx.now();
  const bytesBefore = treeBytes(dir);
  let total = bytesBefore;
  const remove = (entry: Entry): boolean => {
    try {
      ctx.guard.removeTree(entry.abs);
      total -= entry.bytes;
      return true;
    } catch {
      // changed or refused: left for the next collection
      return false;
    }
  };
  const old = (born: number): boolean => now - born > STAGING_MS;

  for (const e of entries(ctx, "")) if (!LAYOUT.has(e.name) && old(e.mtimeMs)) remove(e);

  // The generations, each checked against its manifest.
  const generations = entries(ctx, "generations");
  const valid = new Map<BuildId, GenerationManifest>();
  for (const g of generations) {
    if (!g.folder || !BUILD_ID_PATTERN.test(g.name)) continue;
    const manifest = ctx.load(g.name);
    if (manifest !== null) valid.set(g.name, manifest);
  }

  // Leases: one that protects nothing is removed with its file.
  const leased = new Set<BuildId>();
  for (const l of entries(ctx, "leases")) {
    const lease = !l.folder && LEASE_NAME.test(l.name) ? parseLease(ctx.read(`leases/${l.name}`, LEASE_MAX_BYTES), BUILD_ID_PATTERN) : null;
    if (lease !== null && (await leaseProtects(lease, now))) leased.add(lease.id);
    else if (lease !== null || old(l.mtimeMs)) remove(l);
  }

  const keep = new Set<BuildId>(leased);
  const current = ctx.pointer("current");
  if (current !== null && valid.has(current)) keep.add(current);
  if (incoming !== null) keep.add(incoming);
  const complete = [...valid.values()].filter((m) => m.complete).map((m) => m.id);
  for (const id of complete.sort().reverse().slice(0, KEEP_COMPLETE)) keep.add(id);

  const present = new Set<BuildId>();
  for (const g of generations) {
    const isId = BUILD_ID_PATTERN.test(g.name);
    if (isId && keep.has(g.name)) {
      present.add(g.name);
      continue;
    }
    // A folder without a valid manifest may still be written by its build.
    const removable = valid.has(g.name) || old(isId ? Math.max(buildIdTime(g.name), g.mtimeMs) : g.mtimeMs);
    if (removable && remove(g)) {
      valid.delete(g.name);
      if (isId) removedGenerations.push(g.name);
    } else if (isId) present.add(g.name);
  }

  // A complete pointer whose generation is gone, or that names another tree.
  for (const p of entries(ctx, "complete")) {
    const id = !p.folder && TREE_SHA_PATTERN.test(p.name) ? ctx.pointer(`complete/${p.name}`) : null;
    if (id !== null && valid.get(id)?.capture.treeSha === p.name) continue;
    if (id !== null || old(p.mtimeMs)) remove(p);
  }

  // Facts: what the kept generations name, and whether every one of them
  // is complete.
  const kept = [...keep].filter((id) => present.has(id));
  let allComplete = true;
  const named = new Set<string>();
  const inventories = new Map<BuildId, Set<string>>();
  for (const id of kept) {
    const manifest = valid.get(id);
    const keys = manifest === undefined ? null : ctx.inventoryKeys(manifest);
    if (manifest === undefined || !manifest.complete || keys === null) allComplete = false;
    if (keys === null) continue;
    inventories.set(id, keys);
    for (const k of keys) named.add(k);
  }
  const facts = factEntries(ctx);
  for (const f of facts) {
    if (!old(f.entry.mtimeMs)) continue;
    if (f.key === null) remove(f.entry);
    else if (allComplete && !named.has(f.key) && remove(f.entry)) {
      f.gone = true;
      removedFacts++;
    }
  }

  // The size bound, oldest first.
  let overBudget: OverBudget | null = null;
  if (total > ctx.boundBytes) {
    const pinned = new Set<string>();
    for (const id of [...leased, ...(incoming === null ? [] : [incoming])]) for (const k of inventories.get(id) ?? []) pinned.add(k);
    const live = facts.filter((f): f is Fact & { key: string } => f.key !== null && !f.gone).sort((a, b) => a.entry.mtimeMs - b.entry.mtimeMs);
    const removeFacts = (which: (f: Fact & { key: string }) => boolean) => {
      for (const f of live) {
        if (total <= ctx.boundBytes) break;
        if (f.gone || !which(f)) continue;
        if (remove(f.entry)) {
          f.gone = true;
          removedFacts++;
        }
      }
    };
    // First the facts no kept build names; then the older kept builds no
    // one holds (an index is rebuilt from facts, facts are parsed again),
    // never the newest build or `current`; then the facts only those builds
    // named; last the facts of kept builds no one holds.
    removeFacts((f) => !named.has(f.key));
    // `current` is held unless the incoming build replaces it (a newer id).
    const replaced = current !== null && incoming !== null && incoming > current;
    const holds = new Set<BuildId>([...leased, ...(incoming === null ? [] : [incoming]), ...(current !== null && !replaced ? [current] : [])]);
    for (const id of [...kept].sort()) {
      if (total <= ctx.boundBytes) break;
      if (holds.has(id)) continue;
      const g = generations.find((x) => x.name === id);
      if (g && remove(g)) {
        valid.delete(id);
        removedGenerations.push(id);
        kept.splice(kept.indexOf(id), 1);
      }
    }
    const stillNamed = new Set<string>();
    for (const id of kept) for (const k of inventories.get(id) ?? []) stillNamed.add(k);
    removeFacts((f) => !stillNamed.has(f.key));
    removeFacts((f) => !pinned.has(f.key));
    if (total > ctx.boundBytes) overBudget = { boundBytes: ctx.boundBytes, totalBytes: total, protectedBytes: total, protected: kept.sort() };
  }

  // Refs of captures no remaining generation names.
  const trees = new Set([...valid.values()].map((m) => m.capture.treeSha).filter((t): t is string => t !== null));
  const refs = await safeGit(ctx.repoRoot, ["for-each-ref", "--format=%(refname)", REF_PREFIX]);
  if (refs.code === 0) {
    for (const ref of refs.stdout.toString("utf8").split("\n")) {
      const tree = ref.startsWith(REF_PREFIX) ? ref.slice(REF_PREFIX.length) : "";
      if (!TREE_SHA_PATTERN.test(tree) || trees.has(tree)) continue;
      if ((await safeGit(ctx.repoRoot, ["update-ref", "-d", ref])).code === 0) removedRefs.push(ref);
    }
  }

  return { removedGenerations, removedFacts, removedRefs, bytesBefore, bytesAfter: total, overBudget };
}
