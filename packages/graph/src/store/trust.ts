// The record of the builds this user's store published, kept in
// OpenQodex's home and never in the repository:
//
//   <home>/graph/<repo id>.json   { repo, builds: { <build id>: <sha256 of its manifest.json> } }
//
// The repo id is the sha256 of the repository's real root path, as for the
// gate receipts (packages/cli/src/receipts.ts). A build is opened, listed
// or leased only when its manifest.json hashes to what this record holds
// for its id. The manifest lists the sha256 of every other file of the
// build, so the record vouches for the whole build with no key and no
// signature: whoever could write the graph folder (another user, when the
// folder was open to them; an archive extracted over the repository) can
// write a manifest that matches the files beside it, but not this record.
//
// Why the home and not the graph folder: whatever could plant a build in
// the graph folder could plant a record beside it. The home is the
// developer's own. Its graph/ folder and the record must be owned by the
// developer and closed to writes by others (writableByMeAlone), are read
// through a FolderReader rooted at the home (no link on the way), and are
// written only through the home guard, which refuses a link anywhere under
// the home.
//
// The record changes only inside the graph folder's lock (publish and
// collect hold it), so two builds of one repository never lose each
// other's entry. Each change drops the builds whose folder is gone.
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { FolderReader, homeGuard, writableByMeAlone, type Guard } from "@openqodex/core";
import { BUILD_ID_PATTERN, type BuildId } from "./types.js";

const FOLDER = "graph";
const RECORD_MAX_BYTES = 4 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

// Why a file or folder is not the developer's alone, as the end of a
// sentence that starts with its path; null when it is.
export function notMineAlone(st: { uid: number | bigint; mode: number | bigint }): string | null {
  if (writableByMeAlone(st)) return null;
  const uid = process.getuid?.();
  if (uid !== undefined && Number(st.uid) !== uid) return `belongs to another user (uid ${st.uid})`;
  return `can be written by other users (mode 0${(Number(st.mode) & 0o777).toString(8)})`;
}

export class TrustRecord {
  private builds = new Map<BuildId, string>();

  private constructor(
    private readonly guard: Guard,
    private readonly reader: FolderReader,
    private readonly name: string,
    private readonly path: string,
    private readonly repo: string,
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
    const name = `${createHash("sha256").update(real).digest("hex")}.json`;
    const record = new TrustRecord(guard, new FolderReader(home, (s) => writableByMeAlone(s)), name, join(folder, name), real);
    record.load();
    return record;
  }

  // Reads the record again: empty when it is missing, not the developer's
  // alone, or not a record. Entries that are not a build id and a sha256
  // are left out.
  private load(): void {
    const builds = new Map<BuildId, string>();
    const read = this.reader.read([FOLDER, this.name], RECORD_MAX_BYTES);
    if (read.ok) {
      try {
        const value = JSON.parse(read.data.toString("utf8")) as { builds?: unknown };
        if (typeof value.builds === "object" && value.builds !== null && !Array.isArray(value.builds)) {
          for (const [id, sha] of Object.entries(value.builds)) if (BUILD_ID_PATTERN.test(id) && typeof sha === "string" && SHA256.test(sha)) builds.set(id, sha);
        }
      } catch {
        // not a record: none of its builds are trusted
      }
    }
    this.builds = builds;
  }

  // True when this store recorded `sha256` as the manifest of build `id`.
  // A miss reads the record again: another process may have published it.
  trusted(id: BuildId, sha256: string): boolean {
    if (this.builds.get(id) === sha256) return true;
    this.load();
    return this.builds.get(id) === sha256;
  }

  // Records the manifest of build `id`, and drops the builds `kept` says
  // are gone. Only inside the graph folder's lock. Throws when the record
  // cannot be written: the build is then not published.
  record(id: BuildId, sha256: string, kept: (id: BuildId) => boolean): void {
    this.load();
    const next = new Map([...this.builds].filter(([other]) => other !== id && kept(other)));
    next.set(id, sha256);
    this.write(next);
  }

  // Drops the builds `kept` says are gone. Only inside the graph folder's
  // lock.
  prune(kept: (id: BuildId) => boolean): void {
    this.load();
    const next = new Map([...this.builds].filter(([id]) => kept(id)));
    if (next.size !== this.builds.size) this.write(next);
  }

  private write(builds: Map<BuildId, string>): void {
    const sorted = Object.fromEntries([...builds].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    this.guard.write(this.path, `${JSON.stringify({ repo: this.repo, builds: sorted }, null, 2)}\n`, { mode: 0o600, folderMode: 0o700 });
    this.builds = builds;
  }
}
