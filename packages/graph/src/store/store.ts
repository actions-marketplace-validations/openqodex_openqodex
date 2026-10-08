// The graph's folder in the owning repository, `.openqodex/graph/` (the
// layout is in types.ts). Facts are a cache checked on every read. A
// generation is immutable and checked against its manifest on every open
// and every read. The manifest, the pointers, the leases and meta change
// only inside the folder lock (lock.ts), and the collector (gc.ts) runs
// inside it too.
//
// Nothing here follows a link. Writes and removals go through the Guard
// (packages/core/src/guarded-fs.ts), which decides by filesystem identity
// and refuses a link anywhere in the work tree. Reads go through core's
// FolderReader, on every read, listing and lstat alike: it walks from the
// repo root, known by its identity since the store opened, down to the
// file one name at a time (each a real folder, never a link), opens the
// file without following a link, within a bound, then walks again and
// requires the same folders by device and inode and the opened file at
// its name. No read is answered from a folder remembered from before.
//
// Facts and the files of a generation are written by a faster path than
// Guard.write, measured on this Mac at 4.3 ms a file against 0.16 ms for
// 2,000 facts files: the folder is verified through the guard once, the
// folders from the repo root down to it are walked again by identity
// before each file is made and after it is renamed into place, each file
// is created exclusively without following a link and checked to be the
// file written, and nothing is synced to disk. Both are checked on every
// read, so a file lost in a crash is a cache miss, never a wrong answer.
//
// Trust. The graph folder, every folder in it and every file read from it
// must be the developer's alone: owned by this user and closed to writes
// by group and others (core's writableByMeAlone). A graph folder or layout
// folder that is not is refused at open (the build then runs in memory);
// a folder or file deeper down that is not is never read (a facts file is
// then a cache miss, counted in refusedFacts). A facts key is public (it
// is derived from the blob id) and a manifest carries its own checksums,
// so neither proves a file is the store's own: a build is opened, listed
// or leased only when its manifest is the one this user's store recorded
// for it in OpenQodex's home (trust.ts).
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, renameSync, unlinkSync, writeSync, type BigIntStats } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ensureStateDir, FolderReader, Guard, safeGit, writableByMeAlone } from "@openqodex/core";
import { isFileFacts } from "../safe-fs.js";
import type { FileFacts } from "../types.js";
import { collectLocked, REF_PREFIX, treeBytes, type CollectorContext } from "./gc.js";
import { leaseFileName, type LeaseRecord } from "./leases.js";
import { FolderLock, ownStart, type HeldLock } from "./lock.js";
import { notMineAlone, TrustRecord } from "./trust.js";
import {
  BUILD_ID_PATTERN,
  DEFAULT_MAX_CACHE_MB,
  FACTS_KEY_PATTERN,
  STORE_LAYOUT_VERSION,
  TREE_SHA_PATTERN,
  buildIdTime,
  type BuildId,
  type CollectReport,
  type GenerationManifest,
  type GenerationSelector,
  type GraphStore,
  type Lease,
  type Meta,
  type OpenGeneration,
  type PublishInput,
  type PublishResult,
  type Purpose,
  type StoreOpenResult,
  type WriteFactsResult,
} from "./types.js";

const FACTS_MAX_BYTES = 32 * 1024 * 1024;
const MANIFEST_MAX_BYTES = 64 * 1024 * 1024;
const GENERATION_FILE_MAX_BYTES = 256 * 1024 * 1024;
const POINTER_MAX_BYTES = 256;
const META_MAX_BYTES = 8 * 1024 * 1024;
const LOCK_MAX_BYTES = 4096;
const STATE = [".openqodex", "graph"];
const FOLDERS = ["facts", "generations", "leases", "complete"];
// Plain names joined by "/": no name starts with a dot, so none is "." or
// "..", and none can be taken for a temp file.
const FILE_PATH = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BUSY = "another openqodex process held the graph folder's lock for 10 seconds";

type Id = { dev: bigint; ino: bigint };

function lstatBig(abs: string): BigIntStats | null {
  try {
    return lstatSync(abs, { bigint: true });
  } catch {
    return null;
  }
}

function same(st: BigIntStats | null, id: Id | null | undefined): boolean {
  return st !== null && id != null && st.dev === id.dev && st.ino === id.ino;
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function isDiskFull(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOSPC" || code === "EDQUOT";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameId(a: Id | undefined, b: Id | undefined): boolean {
  return a !== undefined && b !== undefined && a.dev === b.dev && a.ino === b.ino;
}

// Two walks from the repo root that found the same folders.
function sameChain(a: Id[] | null, b: Id[]): boolean {
  return a !== null && a.length === b.length && a.every((id, i) => sameId(id, b[i]));
}

// ---------- build ids ----------

// Time-ordered for one store even when its clock steps back, and apart for
// builds made in one millisecond. One sequence per store, as each store
// has its own clock.
class BuildIds {
  private lastTime = 0;
  private counter = 0;

  next(time: number): BuildId {
    if (time <= this.lastTime) {
      time = this.lastTime;
      this.counter++;
      if (this.counter >= 36 ** 4) {
        time = ++this.lastTime;
        this.counter = 0;
      }
    } else {
      this.lastTime = time;
      this.counter = 0;
    }
    return `${time.toString(36).padStart(9, "0")}${this.counter.toString(36).padStart(4, "0")}-${process.pid.toString(36)}-${randomBytes(4).toString("hex")}`;
  }
}

// ---------- the manifest ----------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) >= 0;
const isNum = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v);
const isStrings = (v: unknown): boolean => Array.isArray(v) && v.every((s) => typeof s === "string");
const hasAll = (v: unknown, keys: string[], each: (x: unknown) => boolean): boolean => isObj(v) && keys.every((k) => each(v[k]));

// The fields of a manifest the build fills in; null when they have the
// shape types.ts gives them, else what is wrong.
function manifestBodyProblem(m: Record<string, unknown>): string | null {
  const c = m.capture;
  if (
    !isObj(c) ||
    !["working-tree", "snapshot", "revision"].includes(c.kind as string) ||
    !(c.treeSha === null || (typeof c.treeSha === "string" && TREE_SHA_PATTERN.test(c.treeSha))) ||
    typeof c.digest !== "string" ||
    !(c.dirtyPaths === null || isStrings(c.dirtyPaths))
  ) {
    return "the manifest's capture is not a capture identity (a tree is 40 or 64 lowercase hex)";
  }
  const shaped =
    hasAll(m.versions, ["model", "extractor", "resolver", "policy"], isNum) &&
    hasAll(m.config, ["budgetMs", "maxFiles", "maxFileBytes", "maxHeapMb"], isNum) &&
    (m.status === "ok" || m.status === "partial") &&
    typeof m.complete === "boolean" &&
    hasAll(m.counts, ["eligible", "inGraph", "parsed", "fromCache", "skipped"], isCount) &&
    (m.mode === "fresh" || m.mode === "retained") &&
    isStrings(m.reasons) &&
    isObj(m.stages) &&
    Object.values(m.stages).every(isNum) &&
    isNum(m.wallMs) &&
    typeof m.hasIndex === "boolean";
  return shaped ? null : "the manifest does not have the shape of GenerationManifest";
}

// Plain paths, none of them manifest.json, and none under another file.
function filePathsOk(paths: string[]): boolean {
  const all = new Set(paths);
  return paths.every((p) => {
    if (p.length > 512 || !FILE_PATH.test(p) || p === "manifest.json") return false;
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) if (all.has(parts.slice(0, i).join("/"))) return false;
    return true;
  });
}

function isManifest(v: unknown, id: BuildId): v is GenerationManifest {
  if (!isObj(v) || v.layout !== STORE_LAYOUT_VERSION || v.id !== id || typeof v.createdAt !== "string") return false;
  if (manifestBodyProblem(v) !== null || !isObj(v.files)) return false;
  const files = v.files;
  return (
    filePathsOk(Object.keys(files)) &&
    Object.values(files).every(
      (f) => isObj(f) && isCount(f.bytes) && (f.bytes as number) <= GENERATION_FILE_MAX_BYTES && typeof f.sha256 === "string" && SHA256.test(f.sha256) && (f.stamp === undefined || (typeof f.stamp === "string" && f.stamp.length <= 128)),
    )
  );
}

function inputProblem(input: PublishInput): string | null {
  if (!isObj(input) || !isObj(input.manifest) || !isObj(input.files)) return "publish takes a manifest and a map of files";
  const body = manifestBodyProblem(input.manifest);
  if (body !== null) return body;
  if (!filePathsOk(Object.keys(input.files))) {
    return "a generation file is named by plain names joined by /, none starting with a dot, not manifest.json, and never under another file";
  }
  for (const [path, text] of Object.entries(input.files)) {
    if (typeof text !== "string") return `the generation file ${path} is not text`;
    if (Buffer.byteLength(text, "utf8") > GENERATION_FILE_MAX_BYTES) return `the generation file ${path} is over ${GENERATION_FILE_MAX_BYTES / 1024 / 1024} MiB`;
  }
  return null;
}

// A file's size, modification time and inode, by lstat; null when it is
// not a regular file. Any write to the file changes it.
function stampOf(st: BigIntStats | null): string | null {
  return st?.isFile() ? `${st.size}:${st.mtimeNs}:${st.ino}` : null;
}

// ---------- the store ----------

class Store implements GraphStore {
  readonly dir: string;
  diskFull = false;
  refusedFacts = 0;
  private readonly lock: FolderLock;
  private readonly ids = new BuildIds();
  // For writes: the folders the guard verified, by their path under the
  // graph folder, each known by identity. A write still walks the folders
  // from the repo root down to it on every file (writeFast).
  private writeIds = new Map<string, Id>();

  constructor(
    readonly repoRoot: string,
    private readonly guard: Guard,
    private readonly reader: FolderReader,
    private readonly trust: TrustRecord,
    private readonly now: () => number,
    readonly boundBytes: number,
  ) {
    this.dir = join(repoRoot, ...STATE);
    this.lock = new FolderLock(guard, this.dir, (name) => this.readRel(name, LOCK_MAX_BYTES));
  }

  // ---------- reads ----------

  // The names from the repo root down to `rel` under the graph folder
  // ("/"-separated, "" for the graph folder itself).
  private names(rel: string): string[] {
    return rel === "" ? [...STATE] : [...STATE, ...rel.split("/")];
  }

  // The folder `rel` under the graph folder as an absolute path, when every
  // folder from the repo root down to it is a real folder; null otherwise.
  private folderOk(rel: string): string | null {
    return this.reader.folder(this.names(rel));
  }

  // The names in the folder `rel`, listed between two walks from the repo
  // root that find the same folders; null otherwise.
  private listRel(rel: string): { dir: string; names: string[] } | null {
    return this.reader.list(this.names(rel));
  }

  // A file under the graph folder, read without following a link anywhere
  // from the repo root down; null when it is not a regular file there or is
  // over `maxBytes`.
  private readRel(rel: string, maxBytes: number): Buffer | null {
    const read = this.reader.read(this.names(rel), maxBytes);
    return read.ok ? read.data : null;
  }

  // The lstat of an entry under the graph folder, between two walks from
  // the repo root that find the same folders; null otherwise.
  private entryRel(rel: string): BigIntStats | null {
    const entry = this.reader.entry(this.names(rel));
    return entry.ok ? entry.stat : null;
  }

  // The build id a pointer file names; null when it names none.
  private pointer(rel: string): BuildId | null {
    const id = this.readRel(rel, POINTER_MAX_BYTES)?.toString("utf8").trim() ?? "";
    return BUILD_ID_PATTERN.test(id) ? id : null;
  }

  // The manifest of generation `id` when it is the one this user's store
  // recorded for it (trust.ts) and every file it lists matches it.
  private load(id: BuildId): GenerationManifest | null {
    if (!BUILD_ID_PATTERN.test(id)) return null;
    const raw = this.readRel(`generations/${id}/manifest.json`, MANIFEST_MAX_BYTES);
    if (raw === null || !this.trust.trusted(id, sha256(raw))) return null;
    let manifest: unknown;
    try {
      manifest = JSON.parse(raw.toString("utf8"));
    } catch {
      return null;
    }
    if (!isManifest(manifest, id)) return null;
    for (const [path, f] of Object.entries(manifest.files)) {
      // A file with the stamp it was published with is as published: no
      // read, once the folders from the repo root down to it are checked.
      // Any other is read and hashed; every read checks it again.
      if (f.stamp !== undefined && stampOf(this.entryRel(`generations/${id}/${path}`)) === f.stamp) continue;
      const data = this.readRel(`generations/${id}/${path}`, f.bytes);
      if (data === null || data.length !== f.bytes || sha256(data) !== f.sha256) return null;
    }
    return manifest;
  }

  // A file of a generation when it matches the manifest; null when the
  // manifest does not list it or it differs.
  private readChecked(manifest: GenerationManifest, path: string): string | null {
    const f = Object.hasOwn(manifest.files, path) ? manifest.files[path] : undefined;
    if (f === undefined) return null;
    const data = this.readRel(`generations/${manifest.id}/${path}`, f.bytes);
    return data !== null && data.length === f.bytes && sha256(data) === f.sha256 ? data.toString("utf8") : null;
  }

  private openId(id: BuildId): OpenGeneration | null {
    const manifest = this.load(id);
    if (manifest === null) return null;
    return { manifest, read: (path: string): string | null => this.readChecked(manifest, path) };
  }

  private select(selector: GenerationSelector): OpenGeneration | null {
    if (selector === "current") {
      const id = this.pointer("current");
      return id === null ? null : this.openId(id);
    }
    if ("tree" in selector) {
      if (!TREE_SHA_PATTERN.test(selector.tree)) return null;
      const id = this.pointer(`complete/${selector.tree}`);
      const g = id === null ? null : this.openId(id);
      return g !== null && g.manifest.complete && g.manifest.capture.treeSha === selector.tree ? g : null;
    }
    return this.openId(selector.id);
  }

  // The facts keys a generation's inventory names: { files: { path: { key } } }.
  private inventoryKeys(manifest: GenerationManifest): Set<string> | null {
    if (!Object.hasOwn(manifest.files, "inventory.json")) return new Set();
    const text = this.readChecked(manifest, "inventory.json");
    if (text === null) return null;
    try {
      const inventory = JSON.parse(text) as { files?: unknown };
      if (!isObj(inventory.files)) return null;
      const keys = new Set<string>();
      for (const entry of Object.values(inventory.files)) {
        if (isObj(entry) && typeof entry.key === "string" && FACTS_KEY_PATTERN.test(entry.key)) keys.add(entry.key);
      }
      return keys;
    } catch {
      return null;
    }
  }

  // ---------- writes ----------

  // The folders from the repo root down to `rel` under the graph folder, by
  // identity. The last one is made through the guard (0700) when missing
  // and verified by it once; every call walks the whole chain again from
  // the repo root, so a folder above it swapped for a link is refused.
  private verifiedFolder(rel: string): Id[] {
    const names = this.names(rel);
    const known = this.writeIds.get(rel);
    if (known !== undefined) {
      const chain = this.reader.ids(names);
      if (chain !== null && sameId(chain[chain.length - 1], known)) return chain;
    }
    const abs = join(this.dir, ...rel.split("/"));
    if (lstatBig(abs) === null) {
      try {
        this.guard.makeFolder(abs);
      } catch (error) {
        if (isDiskFull(error)) throw error;
        // made by another writer meanwhile, or refused: the checks decide
      }
    }
    const w = this.guard.check(abs, false);
    const chain = this.reader.ids(names);
    if (w.stat === null || !w.stat.isDirectory() || chain === null || !sameId(chain[chain.length - 1], { dev: w.stat.dev, ino: w.stat.ino })) {
      throw new Error(`${relative(this.repoRoot, abs)} is not a folder openqodex may write in`);
    }
    if (this.writeIds.size > 4096) this.writeIds.clear();
    this.writeIds.set(rel, chain[chain.length - 1]!);
    return chain;
  }

  // Writes `data` as `name` in the folder `rel` under the graph folder: a
  // temp file created exclusively without following a link (0600), renamed
  // over the name; after it, the name must hold the file written, and the
  // folders from the repo root down must be the ones verified.
  private writeFast(rel: string, name: string, data: Buffer): void {
    const chain = this.verifiedFolder(rel);
    const dirAbs = join(this.dir, ...rel.split("/"));
    const held = (): boolean => sameChain(this.reader.ids(this.names(rel)), chain);
    const final = join(dirAbs, name);
    const tmp = join(dirAbs, `.${name}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    let fd: number | null = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let written: Id | null = null;
    try {
      const st = fstatSync(fd, { bigint: true });
      written = { dev: st.dev, ino: st.ino };
      if (!held() || !same(lstatBig(tmp), written)) throw new Error(`${relative(this.repoRoot, dirAbs)} changed while openqodex was writing in it`);
      for (let off = 0; off < data.length; ) off += writeSync(fd, data, off, data.length - off);
      closeSync(fd);
      fd = null;
      renameSync(tmp, final);
      if (!same(lstatBig(final), written) || !held()) {
        if (same(lstatBig(final), written)) unlinkSync(final);
        throw new Error(`${relative(this.repoRoot, final)} is not where openqodex wrote it; the write was undone`);
      }
    } catch (error) {
      if (fd !== null) closeSync(fd);
      try {
        if (same(lstatBig(tmp), written)) unlinkSync(tmp);
      } catch {
        // nothing of ours is left there
      }
      throw error;
    }
  }

  // ---------- facts ----------

  private factsPath(key: string): string {
    return `facts/${key.slice(0, 2)}/${key}.json`;
  }

  // A facts file another user owns or other users can write is a cache
  // miss, counted in refusedFacts.
  readFacts(key: string): FileFacts | null {
    if (!FACTS_KEY_PATTERN.test(key)) return null;
    const read = this.reader.read(this.names(this.factsPath(key)), FACTS_MAX_BYTES);
    if (!read.ok) {
      if (read.why === "untrusted") this.refusedFacts++;
      return null;
    }
    try {
      const entry = JSON.parse(read.data.toString("utf8")) as { key?: unknown; facts?: unknown };
      if (entry.key === key && isFileFacts(entry.facts)) return entry.facts;
    } catch {
      // corrupt: the build parses the file again and rewrites it
    }
    return null;
  }

  hasFacts(key: string): boolean {
    if (!FACTS_KEY_PATTERN.test(key)) return false;
    return this.entryRel(this.factsPath(key))?.isFile() === true;
  }

  // Bytes under the folder, counted once and then kept up to date by the
  // writes of this process; a publication or a collection counts again.
  private used: number | null = null;

  writeFacts(key: string, facts: FileFacts): WriteFactsResult {
    if (this.diskFull) return "disk-full";
    if (!FACTS_KEY_PATTERN.test(key)) return "refused";
    const data = Buffer.from(JSON.stringify({ key, facts }), "utf8");
    // The size bound holds while a build writes: a write that would pass
    // it is not made.
    this.used ??= treeBytes(this.dir);
    if (this.used + data.length > this.boundBytes) return "over-budget";
    try {
      this.writeFast(`facts/${key.slice(0, 2)}`, `${key}.json`, data);
      this.used += data.length;
      return "ok";
    } catch (error) {
      if (!isDiskFull(error)) return "refused";
      this.diskFull = true;
      return "disk-full";
    }
  }

  // ---------- generations ----------

  list(): GenerationManifest[] {
    return (this.listRel("generations")?.names ?? [])
      .filter((n) => BUILD_ID_PATTERN.test(n))
      .sort()
      .reverse()
      .map((id) => this.load(id))
      .filter((m): m is GenerationManifest => m !== null);
  }

  open(selector: GenerationSelector): OpenGeneration | null {
    return this.select(selector);
  }

  // Moves a pointer to `id` unless it names a newer valid generation: two
  // builds publishing out of order never move it back.
  private movePointer(rel: string, id: BuildId): void {
    const now = this.pointer(rel);
    if (now !== null && now > id && this.load(now) !== null) return;
    this.guard.write(join(this.dir, ...rel.split("/")), `${id}\n`);
  }

  private discard(folder: string): void {
    try {
      this.guard.removeTree(folder);
    } catch {
      // left for the collector: without a manifest it is never opened
    }
  }

  private failed(error: unknown): PublishResult {
    if (isDiskFull(error)) {
      this.diskFull = true;
      return { ok: false, error: "disk-full", reason: "the disk is full; the graph keeps the build it published last" };
    }
    return { ok: false, error: "invalid", reason: message(error) };
  }

  private collector(): CollectorContext {
    return {
      repoRoot: this.repoRoot,
      folder: (rel) => this.folderOk(rel),
      list: (rel) => this.listRel(rel),
      guard: this.guard,
      now: this.now,
      boundBytes: this.boundBytes,
      load: (id) => this.load(id),
      read: (rel, maxBytes) => this.readRel(rel, maxBytes),
      pointer: (rel) => this.pointer(rel),
      inventoryKeys: (m) => this.inventoryKeys(m),
    };
  }

  // The files are written outside the lock: the id is new, and a folder
  // without a manifest is never opened, listed or pointed at. The manifest
  // is written inside the lock, so every valid generation the collector
  // sees has been through it.
  async publish(input: PublishInput): Promise<PublishResult> {
    this.used = null;
    const problem = inputProblem(input);
    if (problem !== null) return { ok: false, error: "invalid", reason: problem };
    // After the build `current` names, even when this clock is behind.
    const current = this.pointer("current");
    const id = this.ids.next(Math.max(this.now(), current === null ? 0 : buildIdTime(current) + 1));
    const rel = `generations/${id}`;
    const folder = join(this.dir, "generations", id);
    const files: [string, { bytes: number; sha256: string }][] = [];
    try {
      this.guard.makeFolder(folder);
      for (const [path, text] of Object.entries(input.files)) {
        const data = Buffer.from(text, "utf8");
        const cut = path.lastIndexOf("/");
        this.writeFast(cut === -1 ? rel : `${rel}/${path.slice(0, cut)}`, path.slice(cut + 1), data);
        const stamp = stampOf(this.entryRel(`${rel}/${path}`));
        files.push([path, { bytes: data.length, sha256: sha256(data), ...(stamp !== null ? { stamp } : {}) }]);
      }
    } catch (error) {
      this.discard(folder);
      return this.failed(error);
    } finally {
      this.forgetFolders(rel);
    }

    let held: HeldLock | null;
    try {
      held = await this.lock.acquire();
    } catch (error) {
      this.discard(folder);
      return this.failed(error);
    }
    if (held === null) {
      this.discard(folder);
      return { ok: false, error: "busy", reason: BUSY };
    }
    let published = false;
    try {
      const manifest: GenerationManifest = {
        ...input.manifest,
        layout: STORE_LAYOUT_VERSION,
        id,
        createdAt: new Date(buildIdTime(id)).toISOString(),
        files: Object.fromEntries(files),
      };
      const text = `${JSON.stringify(manifest)}\n`;
      this.guard.write(join(folder, "manifest.json"), text);
      // Recorded before it is read back: only a recorded build loads.
      this.trust.record(id, sha256(Buffer.from(text, "utf8")), (other) => this.buildThere(other));
      if (this.load(id) === null) {
        this.discard(folder);
        return { ok: false, error: "invalid", reason: `generation ${id} did not read back as it was written` };
      }
      // The new generation is counted before `current` moves: the build
      // reserves its room.
      const collected = await collectLocked(this.collector(), id);
      if (collected.removedGenerations.length > 0) this.pruneTrust();
      const tree = manifest.capture.treeSha;
      // A tree the object store does not hold gets no ref; its sources then
      // read as unavailable.
      if (tree !== null) await safeGit(this.repoRoot, ["update-ref", `${REF_PREFIX}${tree}`, tree]);
      this.movePointer("current", id);
      published = true;
      if (manifest.complete && tree !== null) {
        try {
          this.movePointer(`complete/${tree}`, id);
        } catch (error) {
          // The build is published; only the tree's pointer stays where it was.
          if (isDiskFull(error)) this.diskFull = true;
        }
      }
      return { ok: true, id, overBudget: collected.overBudget, collected };
    } catch (error) {
      if (!published) this.discard(folder);
      return this.failed(error);
    } finally {
      held.release();
    }
  }

  private forgetFolders(rel: string): void {
    for (const key of this.writeIds.keys()) if (key === rel || key.startsWith(`${rel}/`)) this.writeIds.delete(key);
  }

  // Whether the folder of build `id` is still there.
  private buildThere(id: BuildId): boolean {
    return this.entryRel(`generations/${id}`)?.isDirectory() === true;
  }

  // Drops from the record the builds the collector removed. A record that
  // cannot be written keeps them: an id names one build only, so a stale
  // entry vouches for nothing else.
  private pruneTrust(): void {
    try {
      this.trust.prune((id) => this.buildThere(id));
    } catch {
      // left for the next publication or collection
    }
  }

  private async locked<T>(fn: () => T | Promise<T>): Promise<T> {
    const held = await this.lock.acquire();
    if (held === null) throw new Error(BUSY);
    try {
      return await fn();
    } finally {
      held.release();
    }
  }

  // Throws when the lock stays busy for 10 seconds or the lease file cannot
  // be written; the caller then reads without a lease or builds afresh.
  async lease(selector: GenerationSelector, purpose: Purpose): Promise<{ lease: Lease; generation: OpenGeneration } | null> {
    const start = await ownStart();
    return this.locked(() => {
      const generation = this.select(selector);
      if (generation === null) return null;
      const file = leaseFileName(process.pid, start);
      const path = join(this.dir, "leases", file);
      const record: LeaseRecord = { id: generation.manifest.id, pid: process.pid, start, purpose, time: this.now() };
      try {
        this.guard.write(path, `${JSON.stringify(record)}\n`);
      } catch (error) {
        if (isDiskFull(error)) this.diskFull = true;
        throw error;
      }
      let released = false;
      const lease: Lease = {
        id: record.id,
        file,
        release: () => {
          if (released) return;
          released = true;
          try {
            this.guard.remove(path);
          } catch {
            // gone already: the collector removes a lease that protects nothing
          }
        },
      };
      return { lease, generation };
    });
  }

  // Throws when the lock stays busy for 10 seconds.
  collect(): Promise<CollectReport> {
    this.used = null;
    return this.locked(async () => {
      const report = await collectLocked(this.collector(), null);
      if (report.removedGenerations.length > 0) this.pruneTrust();
      return report;
    });
  }

  // ---------- meta ----------

  readMeta(): Meta | null {
    const raw = this.readRel("meta.json", META_MAX_BYTES);
    if (raw === null) return null;
    try {
      const meta = JSON.parse(raw.toString("utf8")) as unknown;
      return isObj(meta) ? meta : null;
    } catch {
      return null;
    }
  }

  // Read, apply and write inside the lock, so two builds never lose each
  // other's update. A full disk sets diskFull and keeps the old meta.json;
  // a lock busy for 10 seconds throws.
  updateMeta(update: (current: Meta | null) => Meta): Promise<void> {
    return this.locked(() => {
      const next = update(this.readMeta());
      try {
        this.guard.write(join(this.dir, "meta.json"), `${JSON.stringify(next, null, 2)}\n`);
      } catch (error) {
        if (!isDiskFull(error)) throw error;
        this.diskFull = true;
      }
    });
  }
}

// ---------- opening ----------

// The first of the graph folder and its layout folders that is there and is
// not the developer's alone, as the reason the store is refused; null when
// none is.
function untrustedLayout(root: string): string | null {
  for (const rel of [STATE.join("/"), ...FOLDERS.map((f) => `${STATE.join("/")}/${f}`)]) {
    const st = lstatBig(join(root, ...rel.split("/")));
    const problem = st === null ? null : notMineAlone(st);
    if (problem !== null) return `${rel} ${problem}, so what it holds may not be yours: remove ${STATE.join("/")} and openqodex makes a new one`;
  }
  return null;
}

// Opens the graph folder of the repository at `repoRoot`, making it when
// missing. Refused, with one plain line, when a link stands anywhere from
// the repo root down to the layout's folders, when git tracks any file
// under .openqodex/graph (a commit could ship forged facts or builds), when
// the graph folder or a layout folder belongs to another user or other
// users can write it (it is left as it is: closing it would make what was
// planted look trusted), or when the record of builds cannot be kept in
// OpenQodex's home `opts.home` (trust.ts). A graph folder only others can
// read is closed to 0700.
export async function openStore(repoRoot: string, opts: { home: string; maxCacheMb?: number; now?: () => number }): Promise<StoreOpenResult> {
  const root = resolve(repoRoot);
  const refuse = (reason: string): StoreOpenResult => ({ ok: false, reason });
  try {
    // First, so .openqodex/.gitignore ignores graph/ from its first file.
    ensureStateDir(root);
  } catch (error) {
    return refuse(message(error));
  }
  for (const rel of [STATE[0]!, STATE.join("/"), ...FOLDERS.map((f) => `${STATE.join("/")}/${f}`)]) {
    const st = lstatBig(join(root, ...rel.split("/")));
    if (st?.isSymbolicLink()) return refuse(`${rel} is a symbolic link; openqodex keeps its graph only in real folders: remove the link`);
    if (st !== null && !st.isDirectory()) return refuse(`${rel} is not a folder; openqodex keeps its graph there: remove it`);
  }
  let tracked;
  try {
    tracked = await safeGit(root, ["ls-files", "-z", "--", ":(icase).openqodex/graph"]);
  } catch (error) {
    return refuse(message(error));
  }
  if (tracked.code !== 0) return refuse(`git could not list the files of ${root}: ${tracked.stderr.trim() || `git exited ${tracked.code}`}`);
  if (tracked.stdout.length > 0) {
    return refuse(".openqodex/graph holds files git tracks; the graph never uses files a commit can supply: remove them with git rm -r --cached .openqodex/graph");
  }
  // Before anything is made in it, and again after, for a folder another
  // process made meanwhile.
  const before = untrustedLayout(root);
  if (before !== null) return refuse(before);
  let trust: TrustRecord;
  try {
    trust = TrustRecord.open(opts.home, root);
  } catch (error) {
    return refuse(message(error));
  }
  const guard = new Guard({ repoRoot: root, gitFolders: [], roots: [] });
  const dir = join(root, ...STATE);
  try {
    for (const abs of [dir, ...FOLDERS.map((f) => join(dir, f))]) {
      if (lstatBig(abs) !== null) continue;
      try {
        guard.makeFolder(abs);
      } catch (error) {
        // Another process made it meanwhile; anything else is refused.
        if (!lstatBig(abs)?.isDirectory()) throw error;
      }
    }
    const after = untrustedLayout(root);
    if (after !== null) return refuse(after);
    // An older version made the folder 0755: what it holds quotes the code.
    guard.narrowFolder(dir, 0o700);
  } catch (error) {
    return refuse(message(error));
  }
  let reader: FolderReader;
  try {
    // .openqodex (depth 0) is the repository's; from the graph folder down,
    // every folder and file read must be the developer's alone.
    reader = new FolderReader(root, (st, depth) => depth < 1 || writableByMeAlone(st));
  } catch (error) {
    return refuse(message(error));
  }
  await ownStart();
  const mb = opts.maxCacheMb !== undefined && Number.isFinite(opts.maxCacheMb) && opts.maxCacheMb > 0 ? opts.maxCacheMb : DEFAULT_MAX_CACHE_MB;
  return { ok: true, store: new Store(root, guard, reader, trust, opts.now ?? Date.now, Math.floor(mb * 1024 * 1024)) };
}
