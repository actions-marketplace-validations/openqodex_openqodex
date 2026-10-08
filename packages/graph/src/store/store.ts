// The graph's folder in the owning repository, `.openqodex/graph/` (the
// layout is in types.ts). Facts are a cache checked on every read. A
// generation is immutable and checked against its manifest on every open
// and every read. The manifest, the pointers, the leases and meta change
// only inside the folder lock (lock.ts), and the collector (gc.ts) runs
// inside it too.
//
// Nothing here follows a link. Writes and removals go through the Guard
// (packages/core/src/guarded-fs.ts), which decides by filesystem identity
// and refuses a link anywhere in the work tree. Reads check every folder
// from the repo root down with lstat, remember each folder by its device
// and inode, and open the file without following a link, within a bound.
//
// Facts and the files of a generation are written by a faster path than
// Guard.write, measured on this Mac at 4.3 ms a file against 0.16 ms for
// 2,000 facts files: the folder is verified through the guard once and
// known by its identity after, each file is created exclusively without
// following a link, renamed into place and checked to be the file written
// in the folder verified, and nothing is synced to disk. Both are checked
// on every read, so a file lost in a crash is a cache miss, never a wrong
// answer.
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, renameSync, unlinkSync, writeSync, type BigIntStats } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ensureStateDir, Guard, safeGit } from "@openqodex/core";
import { isFileFacts } from "../safe-fs.js";
import type { FileFacts } from "../types.js";
import { collectLocked, REF_PREFIX, type CollectorContext } from "./gc.js";
import { leaseFileName, type LeaseRecord } from "./leases.js";
import { FolderLock, ownStart, type HeldLock } from "./lock.js";
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

// A regular file at `abs`, opened without following a link and read whole
// when it holds at most `maxBytes`; null otherwise.
function readNoFollow(abs: string, maxBytes: number): Buffer | null {
  let fd: number;
  try {
    // Non-blocking, so a named pipe here cannot hold the open.
    fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return null;
    const data = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, data, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return off === st.size ? data : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
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
    Object.values(files).every((f) => isObj(f) && isCount(f.bytes) && (f.bytes as number) <= GENERATION_FILE_MAX_BYTES && typeof f.sha256 === "string" && SHA256.test(f.sha256))
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

// ---------- the store ----------

class Store implements GraphStore {
  readonly dir: string;
  diskFull = false;
  private readonly lock: FolderLock;
  private readonly ids = new BuildIds();
  // Folders known by identity: for reads, every folder from the repo root
  // down was a real folder; for writes, the guard verified the folder.
  private readIds = new Map<string, Id>();
  private writeIds = new Map<string, Id>();

  constructor(
    readonly repoRoot: string,
    private readonly guard: Guard,
    private readonly now: () => number,
    private readonly boundBytes: number,
  ) {
    this.dir = join(repoRoot, ...STATE);
    this.lock = new FolderLock(guard, this.dir, (name) => this.readRel(name, LOCK_MAX_BYTES));
  }

  // ---------- reads ----------

  // The folder `rel` under the graph folder ("" for the graph folder) as an
  // absolute path, when every folder from the repo root down to it is a
  // real folder; null otherwise.
  private folderOk(rel: string): string | null {
    const parts = rel === "" ? [] : rel.split("/");
    const abs = join(this.dir, ...parts);
    const known = this.readIds.get(rel);
    if (known !== undefined && same(lstatBig(abs), known)) return abs;
    let at = this.repoRoot;
    let st: BigIntStats | null = null;
    for (const part of [...STATE, ...parts]) {
      at = join(at, part);
      st = lstatBig(at);
      // isDirectory is false for a link: lstat does not follow it.
      if (st === null || !st.isDirectory()) return null;
    }
    if (this.readIds.size > 4096) this.readIds.clear();
    this.readIds.set(rel, { dev: st!.dev, ino: st!.ino });
    return abs;
  }

  // A file under the graph folder ("/"-separated), read without following
  // a link anywhere from the repo root down; null when it is not a regular
  // file there or is over `maxBytes`.
  private readRel(rel: string, maxBytes: number): Buffer | null {
    const cut = rel.lastIndexOf("/");
    const dir = this.folderOk(cut === -1 ? "" : rel.slice(0, cut));
    return dir === null ? null : readNoFollow(join(dir, rel.slice(cut + 1)), maxBytes);
  }

  // The build id a pointer file names; null when it names none.
  private pointer(rel: string): BuildId | null {
    const id = this.readRel(rel, POINTER_MAX_BYTES)?.toString("utf8").trim() ?? "";
    return BUILD_ID_PATTERN.test(id) ? id : null;
  }

  // The manifest of generation `id` when every file it lists matches it.
  private load(id: BuildId): GenerationManifest | null {
    if (!BUILD_ID_PATTERN.test(id)) return null;
    const raw = this.readRel(`generations/${id}/manifest.json`, MANIFEST_MAX_BYTES);
    if (raw === null) return null;
    let manifest: unknown;
    try {
      manifest = JSON.parse(raw.toString("utf8"));
    } catch {
      return null;
    }
    if (!isManifest(manifest, id)) return null;
    for (const [path, f] of Object.entries(manifest.files)) {
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

  // The folder `abs`, made through the guard (0700) when missing, known by
  // the identity the guard verified: no link on the way.
  private verifiedFolder(abs: string): Id {
    const known = this.writeIds.get(abs);
    if (known !== undefined && same(lstatBig(abs), known)) return known;
    if (lstatBig(abs) === null) {
      try {
        this.guard.makeFolder(abs);
      } catch (error) {
        if (isDiskFull(error)) throw error;
        // made by another writer meanwhile, or refused: the check decides
      }
    }
    const w = this.guard.check(abs, false);
    if (w.stat === null || !w.stat.isDirectory()) throw new Error(`${relative(this.repoRoot, abs)} is not a folder openqodex may write in`);
    if (this.writeIds.size > 4096) this.writeIds.clear();
    const id = { dev: w.stat.dev, ino: w.stat.ino };
    this.writeIds.set(abs, id);
    return id;
  }

  // Writes `data` as `name` in the folder `dirAbs`: a temp file created
  // exclusively without following a link (0600), renamed over the name;
  // after it, the name must hold the file written, in the folder verified.
  private writeFast(dirAbs: string, name: string, data: Buffer): void {
    const folder = this.verifiedFolder(dirAbs);
    const final = join(dirAbs, name);
    const tmp = join(dirAbs, `.${name}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    let fd: number | null = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let written: Id | null = null;
    try {
      const st = fstatSync(fd, { bigint: true });
      written = { dev: st.dev, ino: st.ino };
      if (!same(lstatBig(dirAbs), folder)) throw new Error(`${relative(this.repoRoot, dirAbs)} changed while openqodex was writing in it`);
      for (let off = 0; off < data.length; ) off += writeSync(fd, data, off, data.length - off);
      closeSync(fd);
      fd = null;
      renameSync(tmp, final);
      if (!same(lstatBig(final), written) || !same(lstatBig(dirAbs), folder)) {
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

  readFacts(key: string): FileFacts | null {
    if (!FACTS_KEY_PATTERN.test(key)) return null;
    const raw = this.readRel(this.factsPath(key), FACTS_MAX_BYTES);
    if (raw === null) return null;
    try {
      const entry = JSON.parse(raw.toString("utf8")) as { key?: unknown; facts?: unknown };
      if (entry.key === key && isFileFacts(entry.facts)) return entry.facts;
    } catch {
      // corrupt: the build parses the file again and rewrites it
    }
    return null;
  }

  hasFacts(key: string): boolean {
    if (!FACTS_KEY_PATTERN.test(key)) return false;
    const dir = this.folderOk(`facts/${key.slice(0, 2)}`);
    return dir !== null && lstatBig(join(dir, `${key}.json`))?.isFile() === true;
  }

  writeFacts(key: string, facts: FileFacts): WriteFactsResult {
    if (this.diskFull) return "disk-full";
    if (!FACTS_KEY_PATTERN.test(key)) return "refused";
    try {
      this.writeFast(join(this.dir, "facts", key.slice(0, 2)), `${key}.json`, Buffer.from(JSON.stringify({ key, facts }), "utf8"));
      return "ok";
    } catch (error) {
      if (!isDiskFull(error)) return "refused";
      this.diskFull = true;
      return "disk-full";
    }
  }

  // ---------- generations ----------

  list(): GenerationManifest[] {
    const dir = this.folderOk("generations");
    if (dir === null) return [];
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    return names
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
    const problem = inputProblem(input);
    if (problem !== null) return { ok: false, error: "invalid", reason: problem };
    // After the build `current` names, even when this clock is behind.
    const current = this.pointer("current");
    const id = this.ids.next(Math.max(this.now(), current === null ? 0 : buildIdTime(current) + 1));
    const folder = join(this.dir, "generations", id);
    const files: [string, { bytes: number; sha256: string }][] = [];
    try {
      this.guard.makeFolder(folder);
      for (const [path, text] of Object.entries(input.files)) {
        const data = Buffer.from(text, "utf8");
        const cut = path.lastIndexOf("/");
        this.writeFast(cut === -1 ? folder : join(folder, ...path.slice(0, cut).split("/")), path.slice(cut + 1), data);
        files.push([path, { bytes: data.length, sha256: sha256(data) }]);
      }
    } catch (error) {
      this.discard(folder);
      return this.failed(error);
    } finally {
      this.forgetFolders(folder);
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
      this.guard.write(join(folder, "manifest.json"), `${JSON.stringify(manifest)}\n`);
      if (this.load(id) === null) {
        this.discard(folder);
        return { ok: false, error: "invalid", reason: `generation ${id} did not read back as it was written` };
      }
      // The new generation is counted before `current` moves: the build
      // reserves its room.
      const collected = await collectLocked(this.collector(), id);
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

  private forgetFolders(folder: string): void {
    for (const key of this.writeIds.keys()) if (key === folder || key.startsWith(`${folder}/`)) this.writeIds.delete(key);
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
    return this.locked(() => collectLocked(this.collector(), null));
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

// Opens the graph folder of the repository at `repoRoot`, making it when
// missing. Refused, with one plain line, when a link stands anywhere from
// the repo root down to the layout's folders, or when git tracks any file
// under .openqodex/graph (a commit could ship forged facts or builds).
export async function openStore(repoRoot: string, opts: { maxCacheMb?: number; now?: () => number } = {}): Promise<StoreOpenResult> {
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
    // An older version made the folder 0755: what it holds quotes the code.
    guard.narrowFolder(dir, 0o700);
  } catch (error) {
    return refuse(message(error));
  }
  await ownStart();
  const mb = opts.maxCacheMb !== undefined && Number.isFinite(opts.maxCacheMb) && opts.maxCacheMb > 0 ? opts.maxCacheMb : DEFAULT_MAX_CACHE_MB;
  return { ok: true, store: new Store(root, guard, opts.now ?? Date.now, Math.floor(mb * 1024 * 1024)) };
}
