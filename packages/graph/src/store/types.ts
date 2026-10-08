// The contract of the graph's folder in the owning repository,
// `.openqodex/graph/`. store.ts implements it; the build, the review and the
// graph commands use only this.
//
//   .openqodex/graph/
//     meta.json                  rates measured on this machine and the last mode decisions
//     lock                       the folder lock: short critical sections only
//     facts/<xx>/<key>.json      one file per facts key ({ key, facts })
//     generations/<id>/          one immutable folder per build; manifest.json written last
//     leases/<name>.json         one per reader that holds a generation open
//     current                    one line: the newest usable build id
//     complete/<tree sha>        one line: the newest complete build of that capture
//
// Beside it, in OpenQodex's home and never in the repository:
//
//   <home>/graph/<repo id>.json  the sha256 of every manifest this user's store wrote (trust.ts)
//
// A generation is published by writing its files (outside the lock: the
// id is new), then, inside the lock: writing manifest.json last, recording
// its sha256 in the home, validating every file against the manifest's
// checksums, collecting,
// keeping the capture's git ref, and moving `current` (and
// `complete/<tree>` when the build is complete). The manifest is written
// inside the lock so a collection in another process never sees a valid
// generation whose publisher is still waiting for the lock.
import type { FileFacts } from "../types.js";

export const STORE_LAYOUT_VERSION = 1;
export const DEFAULT_MAX_CACHE_MB = 512;
export const LEASE_MAX_AGE_MS = 24 * 3600_000;
export const KEEP_COMPLETE = 2;

// Time-ordered and unique: a base-36 millisecond time padded to sort as
// text, then the process id and random hex.
export type BuildId = string;

// The time (9 base-36 digits) and a counter within one process and
// millisecond (4), then the process id and random hex. The counter keeps
// three builds of one process in one millisecond apart and in order.
export const BUILD_ID_PATTERN = /^[0-9a-z]{13}-[0-9a-z]{1,8}-[0-9a-f]{8}$/;
// A git tree (sha1 or sha256) and a facts key (sha1 or sha256 hex).
export const TREE_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const FACTS_KEY_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// The millisecond time a build id was made at.
export function buildIdTime(id: BuildId): number {
  return parseInt(id.slice(0, 9), 36);
}

export type CaptureIdentity = {
  kind: "working-tree" | "snapshot" | "revision";
  // The git tree the capture wrote; its blobs are kept under
  // refs/openqodex/graph/<treeSha> while a generation of it is kept.
  treeSha: string | null;
  // sha256 over the sorted inventory (path and content hash) plus the
  // analysis configuration: what the graph was built from.
  digest: string;
  // Files that differ from HEAD in the capture; null when not known.
  dirtyPaths: string[] | null;
};

export type GenerationManifest = {
  layout: number; // STORE_LAYOUT_VERSION
  id: BuildId;
  createdAt: string; // ISO time
  capture: CaptureIdentity;
  versions: { model: number; extractor: number; resolver: number; policy: number };
  config: { budgetMs: number; maxFiles: number; maxFileBytes: number; maxHeapMb: number };
  status: "ok" | "partial";
  // True when a later build of the same capture could add nothing: no
  // file was cut by the budget, the parse cap, the memory bound or a slow
  // parse (a file over the size cap is left out the same way every time).
  complete: boolean;
  counts: { eligible: number; inGraph: number; parsed: number; fromCache: number; skipped: number };
  mode: "fresh" | "retained";
  reasons: string[];
  stages: Record<string, number>; // milliseconds per stage
  wallMs: number;
  hasIndex: boolean;
  // Every other file of the generation folder, by its path in the folder:
  // byte length and sha256. A file missing or different makes the
  // generation unusable.
  // `stamp`: the file's size, modification time and inode when written; a
  // file that still has it is as published and is listed without a read.
  files: Record<string, { bytes: number; sha256: string; stamp?: string }>;
};

// What publish takes: the manifest without the fields the store fills in,
// and the files by their path in the generation folder ("inventory.json",
// "projects.json", "coverage.json", "index/edges.jsonl", ...).
export type PublishInput = {
  manifest: Omit<GenerationManifest, "layout" | "id" | "createdAt" | "files">;
  files: Record<string, string>;
};

export type PublishResult =
  | { ok: true; id: BuildId; overBudget: OverBudget | null; collected: CollectReport }
  | { ok: false; error: "disk-full" | "busy" | "invalid"; reason: string };

// Leased and kept content alone exceeds the size bound: the build still
// published, nothing pinned was deleted, and this says what is protected.
export type OverBudget = { boundBytes: number; totalBytes: number; protectedBytes: number; protected: BuildId[] };

export type CollectReport = {
  removedGenerations: BuildId[];
  removedFacts: number;
  removedRefs: string[];
  bytesBefore: number;
  bytesAfter: number;
  overBudget: OverBudget | null;
};

export type Purpose = "review" | "cli" | "mcp";

export type Lease = {
  id: BuildId; // the generation it holds open
  file: string; // the lease file's name under leases/
  release(): void; // removes the lease file; safe to call twice
};

export type OpenGeneration = {
  manifest: GenerationManifest;
  // A file of the generation, checked against the manifest; null when the
  // manifest does not list it.
  read(path: string): string | null;
};

export type GenerationSelector = { id: BuildId } | "current" | { tree: string };

// "over-budget": the write would take the folder past its size bound; nothing was written.
export type WriteFactsResult = "ok" | "disk-full" | "refused" | "over-budget";

export type Meta = Record<string, unknown>;

export interface GraphStore {
  readonly repoRoot: string;
  readonly dir: string; // absolute path of .openqodex/graph
  // True after a write hit a full disk: the build stops writing and says so.
  readonly diskFull: boolean;
  // Facts files readFacts refused since the store opened because another
  // user owns them or other users can write them (or the folder they are
  // in): each was a cache miss, and the build says how many it parsed again.
  readonly refusedFacts: number;
  // The folder's size bound in bytes (graph.max_cache_mb).
  readonly boundBytes: number;

  readFacts(key: string): FileFacts | null;
  writeFacts(key: string, facts: FileFacts): WriteFactsResult;
  // Whether a facts file for the key is there (an lstat, no read): what the
  // five-second rule counts as cached before the build reads anything.
  hasFacts(key: string): boolean;

  publish(input: PublishInput): Promise<PublishResult>;
  list(): GenerationManifest[]; // valid generations, newest first
  open(selector: GenerationSelector): OpenGeneration | null;
  // Selects (`current` or a tree's complete pointer, or an id) and leases in
  // one critical section, so a collector never deletes what a reader is
  // about to pin. Null when nothing matches.
  lease(selector: GenerationSelector, purpose: Purpose): Promise<{ lease: Lease; generation: OpenGeneration } | null>;
  collect(): Promise<CollectReport>;

  readMeta(): Meta | null;
  updateMeta(update: (current: Meta | null) => Meta): Promise<void>;
}

export type StoreOpenResult = { ok: true; store: GraphStore } | { ok: false; reason: string };
