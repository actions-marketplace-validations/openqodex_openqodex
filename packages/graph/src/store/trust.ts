// The record of what this user's store wrote for one repository, kept in
// OpenQodex's home and never in the repository:
//
//   <home>/graph/<repo id>.json
//     { repo: { path, ino },
//       builds: { <build id>: <sha256 of its manifest.json> },
//       facts: { <facts key>: <sha256 of its facts file> } }
//
// The repo id is the sha256 of the repository's real root path, as for the
// gate receipts (packages/cli/src/receipts.ts). `repo` names the repository
// the record is for: the real path of its root folder and that folder's
// inode. A record whose `repo` is not this repository's vouches for
// nothing, no build and no facts: a record copied from another
// repository's name, or one kept from a repository that stood at this path
// before (deleted, moved away, or replaced by a copy), is read as empty and
// replaced at the next write. The device number is left out: it changes
// when a disk, a disk image or a network share is mounted again, and the
// path already says where the folder is.
//
// A build is opened, listed or leased only when its manifest.json hashes to
// what this record holds for its id. The manifest lists the sha256 of every
// other file of the build, so the record vouches for the whole build with
// no key and no signature. A facts file is read only when it hashes to what
// this record holds for its key. A facts key is public (a hash of the
// extractor, the language, the grammar and the git blob id) and a facts
// file describes itself, so only this record tells the file this store
// wrote from one written over it with the developer's own user, such as by
// an archive extracted over the repository. Whoever could write the graph
// folder can write a manifest that matches the files beside it, or facts
// under the right key, but not this record.
//
// Why the home and not the graph folder: whatever could plant a build in
// the graph folder could plant a record beside it. The home is the
// developer's own. Its graph/ folder and the record must be owned by the
// developer and closed to writes by others (writableByMeAlone), are read
// through a FolderReader rooted at the home (no link on the way), and are
// written only through the home guard, which refuses a link anywhere under
// the home.
//
// The record changes only inside the graph folder's lock, so two builds of
// one repository never lose each other's entries. The digest of each facts
// file a store writes is kept in memory and recorded in the store's next
// critical section (a publication, a collection, a lease or a meta update;
// every build ends with a publication or a meta update), all in one write:
// a facts file written by a process that stopped before then has no entry,
// and the next build parses it again. Every write drops the builds whose
// folder is gone; a collection also drops the facts whose file it did not
// find, so the record holds no more than the folder does.
import { createHash } from "node:crypto";
import { lstatSync, realpathSync, statSync, type BigIntStats } from "node:fs";
import { join, resolve } from "node:path";
import { FolderReader, homeGuard, writableByMeAlone, type Guard } from "@openqodex/core";
import { BUILD_ID_PATTERN, FACTS_KEY_PATTERN, type BuildId } from "./types.js";

const FOLDER = "graph";
// About 110 bytes a facts entry: room for some 600,000 facts files.
const RECORD_MAX_BYTES = 64 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

// The repository a record is for: the real path of its root folder and
// that folder's inode (a decimal string).
export type RepoIdentity = { path: string; ino: string };

// Why a file or folder is not the developer's alone, as the end of a
// sentence that starts with its path; null when it is.
export function notMineAlone(st: { uid: number | bigint; mode: number | bigint }): string | null {
  if (writableByMeAlone(st)) return null;
  const uid = process.getuid?.();
  if (uid !== undefined && Number(st.uid) !== uid) return `belongs to another user (uid ${st.uid})`;
  return `can be written by other users (mode 0${(Number(st.mode) & 0o777).toString(8)})`;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function sameRepo(v: unknown, repo: RepoIdentity): boolean {
  return isObj(v) && v.path === repo.path && v.ino === repo.ino;
}

// A file's size, times and inode: any write through the home guard (a new
// file renamed into place) changes it.
function stampOf(st: BigIntStats): string {
  return `${st.size}:${st.mtimeNs}:${st.ctimeNs}:${st.ino}`;
}

export class TrustRecord {
  private builds = new Map<BuildId, string>();
  private facts = new Map<string, string>();
  // The facts files this store wrote and has not recorded yet, by key.
  private readonly pending = new Map<string, string>();
  // The record file as it was last read or written; null when there was none.
  private stamp: string | null = null;

  private constructor(
    private readonly guard: Guard,
    private readonly reader: FolderReader,
    private readonly name: string,
    private readonly path: string,
    private readonly repo: RepoIdentity,
  ) {}

  // The record of the repository at `repoRoot` under OpenQodex's home
  // `home`, making <home>/graph (0700) when it is missing. Throws one plain
  // line when that folder cannot be made or is not the developer's alone.
  static open(homePath: string, repoRoot: string): TrustRecord {
    const home = resolve(homePath);
    const folder = join(home, FOLDER);
    const guard = homeGuard(home, true);
    if (lstatSync(folder, { throwIfNoEntry: false }) === undefined) {
      try {
        guard.makeFolder(folder);
      } catch (error) {
        // Made by another process meanwhile; anything else is said below.
        if (lstatSync(folder, { throwIfNoEntry: false }) === undefined) {
          throw new Error(`openqodex could not make ${folder} for the record of your graph builds: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    const st = lstatSync(folder, { bigint: true, throwIfNoEntry: false });
    if (st === undefined || !st.isDirectory()) throw new Error(`${folder} is not a folder; openqodex keeps the record of your graph builds there: remove it`);
    const problem = notMineAlone(st);
    if (problem !== null) throw new Error(`${folder} ${problem}, so the record of your graph builds there may not be yours: remove ${folder} and openqodex makes a new one`);
    let real = repoRoot;
    try {
      real = realpathSync(repoRoot);
    } catch {
      // keyed as given
    }
    const repo: RepoIdentity = { path: real, ino: statSync(real, { bigint: true }).ino.toString() };
    const name = `${createHash("sha256").update(real).digest("hex")}.json`;
    const record = new TrustRecord(guard, new FolderReader(home, (s) => writableByMeAlone(s)), name, join(folder, name), repo);
    record.load();
    return record;
  }

  // Reads the record again: empty when it is missing, not the developer's
  // alone, not a record, or a record of another repository. Entries that
  // are not a build id or a facts key with a sha256 are left out.
  private load(): void {
    const builds = new Map<BuildId, string>();
    const facts = new Map<string, string>();
    const read = this.reader.read([FOLDER, this.name], RECORD_MAX_BYTES);
    this.stamp = read.ok ? stampOf(read.stat) : null;
    if (read.ok) {
      try {
        const value = JSON.parse(read.data.toString("utf8")) as { repo?: unknown; builds?: unknown; facts?: unknown };
        if (sameRepo(value.repo, this.repo)) {
          if (isObj(value.builds)) for (const [id, sha] of Object.entries(value.builds)) if (BUILD_ID_PATTERN.test(id) && typeof sha === "string" && SHA256.test(sha)) builds.set(id, sha);
          if (isObj(value.facts)) for (const [key, sha] of Object.entries(value.facts)) if (FACTS_KEY_PATTERN.test(key) && typeof sha === "string" && SHA256.test(sha)) facts.set(key, sha);
        }
      } catch {
        // not a record: nothing in it is trusted
      }
    }
    this.builds = builds;
    this.facts = facts;
  }

  // Reads the record again when its file changed since it was last read:
  // a lstat, so a folder of planted builds costs no parse each.
  private refresh(): void {
    const entry = this.reader.entry([FOLDER, this.name]);
    if ((entry.ok ? stampOf(entry.stat) : null) !== this.stamp) this.load();
  }

  // True when this store recorded `sha256` as the manifest of build `id`.
  // A miss reads the record again when it changed: another process may
  // have published the build.
  trusted(id: BuildId, sha256: string): boolean {
    if (this.builds.get(id) === sha256) return true;
    this.refresh();
    return this.builds.get(id) === sha256;
  }

  // The sha256 the facts file of `key` must have: what this store wrote
  // last, else what the record holds; undefined when there is neither.
  // Facts another process recorded after this store last read the record
  // are a miss until then, and parsed again: no read of the record per
  // file.
  factsDigest(key: string): string | undefined {
    return this.pending.get(key) ?? this.facts.get(key);
  }

  // Keeps the sha256 of the facts file this store just wrote for `key`,
  // for its next critical section to record.
  wroteFacts(key: string, sha256: string): void {
    this.pending.set(key, sha256);
  }

  // Records build `build` (an id and the sha256 of its manifest) when
  // given, and the facts this store wrote; drops the builds `kept` says are
  // gone and, when `factsLeft` is given, every facts entry whose key it
  // does not hold. Writes only when something changed. Only inside the
  // graph folder's lock. Throws when the record cannot be written: the
  // build is then not published, and the facts wait for the next time.
  record(change: { build?: [BuildId, string]; factsLeft?: ReadonlySet<string> | null }, kept: (id: BuildId) => boolean): void {
    // Another process may have written it since: read again when it changed.
    this.refresh();
    let changed = false;
    const builds = new Map<BuildId, string>();
    for (const [id, sha] of this.builds) {
      if (id === change.build?.[0]) continue;
      if (kept(id)) builds.set(id, sha);
      else changed = true;
    }
    if (change.build !== undefined) {
      const [id, sha] = change.build;
      if (this.builds.get(id) !== sha) changed = true;
      builds.set(id, sha);
    }
    const left = change.factsLeft ?? null;
    const facts = new Map<string, string>();
    for (const [key, sha] of this.facts) {
      if (left === null || left.has(key)) facts.set(key, sha);
      else changed = true;
    }
    const written = [...this.pending];
    for (const [key, sha] of written) {
      if ((left === null || left.has(key)) && facts.get(key) !== sha) {
        facts.set(key, sha);
        changed = true;
      }
    }
    if (changed) this.write(builds, facts);
    // Recorded, or gone from the folder; a newer write of the same key waits.
    for (const [key, sha] of written) if (this.pending.get(key) === sha) this.pending.delete(key);
  }

  // Records the facts this store wrote, when there are any, dropping the
  // builds `kept` says are gone. Only inside the graph folder's lock. A
  // record that cannot be written keeps them for the next time.
  recordFacts(kept: (id: BuildId) => boolean): void {
    if (this.pending.size === 0) return;
    try {
      this.record({}, kept);
    } catch {
      // the next critical section tries again
    }
  }

  private write(builds: Map<BuildId, string>, facts: Map<string, string>): void {
    const sorted = Object.fromEntries([...builds].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    let text = `${JSON.stringify({ repo: this.repo, builds: sorted, facts: Object.fromEntries(facts) })}\n`;
    // A record past the read bound would vouch for nothing: the facts give
    // way, the builds stay, and those facts are parsed again.
    if (Buffer.byteLength(text, "utf8") > RECORD_MAX_BYTES) {
      facts = new Map();
      text = `${JSON.stringify({ repo: this.repo, builds: sorted, facts: {} })}\n`;
    }
    this.guard.write(this.path, text, { mode: 0o600, folderMode: 0o700 });
    this.builds = builds;
    this.facts = facts;
    const entry = this.reader.entry([FOLDER, this.name]);
    this.stamp = entry.ok ? stampOf(entry.stat) : null;
  }
}
