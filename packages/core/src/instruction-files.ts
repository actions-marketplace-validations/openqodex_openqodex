// The owners choose paths. Reviews never discover convention files.
// One resolver admits whole files, keeps their raw hashes and records every
// omission. Finalize verifies that exact selection without expanding it again.
import { createHash } from "node:crypto";
import { isAbsolute, win32 } from "node:path";
import { FolderReader } from "./guarded-fs.js";
import { matchesGlob } from "./glob.js";
import { isShippedInstructionFile, stripInstructionSections } from "./instruction-sections.js";
import { safeGit, SERVER_GIT_ENV } from "./safe-git.js";
import { OpenQodexError } from "./types.js";
import type { InstructionFile, InstructionProvenance } from "./types.js";

export const CONVENTION_FILE_MAX_BYTES = 32 * 1024;
export const CONVENTIONS_MAX_BYTES = 64 * 1024;
export type InstructionSet = { files: InstructionFile[]; provenance: InstructionProvenance[]; notes: string[]; hash: string | null };
const sha256 = (raw: string | Buffer): string => createHash("sha256").update(raw).digest("hex");
const FULL_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const plain = (path: string): boolean => !isAbsolute(path) && !win32.isAbsolute(path) && !path.includes("\\") && !/[\0\r\n]/.test(path) && path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git");
const glob = (path: string): boolean => /[*?]/.test(path);

// With no convention files, preserve the earlier owners-only hash.
export function instructionSetHash(owners: string, files: readonly { path: string; raw: string }[]): string | null {
  if (files.length === 0) return owners === "" ? null : sha256(owners);
  return sha256(JSON.stringify([owners, ...files.map((file) => [file.path, file.raw])]));
}

async function commitOf(repoRoot: string, source: string): Promise<string> {
  const got = await safeGit(repoRoot, ["rev-parse", "--verify", "--end-of-options", `${source}^{commit}`], undefined, { ...SERVER_GIT_ENV }, 1024);
  const sha = got.stdout.toString("utf8").trim();
  if (got.code !== 0 || !FULL_ID.test(sha)) throw new OpenQodexError(`--instructions-ref ${source} is not a commit in this repository`);
  return sha;
}

// CLI values never select the internal work-tree source.
export async function resolveInstructionRef(repoRoot: string, ref: string): Promise<string> {
  return ref === "none" ? "none" : commitOf(repoRoot, ref);
}

// Bound metadata before matching. A rejected expansion is omitted as a whole.
const PATH_LIST_MAX_BYTES = 4 * 1024 * 1024;
const PATH_LIST_MAX_FILES = 50_000;
function listedPaths(data: Buffer, pattern: string): string[] {
  const entries = data.toString("utf8").split("\0").filter(Boolean);
  if (entries.length > PATH_LIST_MAX_FILES) throw new Error("matches a source with more than 50000 indexed paths");
  return entries.filter((entry) => /^(100644|100755) /.test(entry)).map((entry) => entry.slice(entry.indexOf("\t") + 1)).filter((path) => matchesGlob(path, pattern)).sort();
}

type Reader = { paths(pattern: string): Promise<string[]>; read(path: string): Promise<Buffer> };
function workTreeReader(repoRoot: string): Reader {
  const reader = new FolderReader(repoRoot);
  return {
    async paths(pattern) {
      const got = await safeGit(repoRoot, ["ls-files", "--cached", "--stage", "-z"], undefined, { ...SERVER_GIT_ENV }, PATH_LIST_MAX_BYTES);
      if (got.code !== 0) throw new Error("could not list tracked convention paths");
      return listedPaths(got.stdout, pattern).filter((path) => {
        const entry = reader.entry(path.split("/"));
        return entry.ok && entry.stat.isFile();
      });
    },
    async read(path) {
      const entry = reader.entry(path.split("/"));
      if (!entry.ok) throw new Error(entry.why === "missing" ? "is missing" : "could not be read safely");
      if (entry.stat.isSymbolicLink()) throw new Error("is a symbolic link");
      if (!entry.stat.isFile()) throw new Error("is not a regular file");
      if (entry.stat.size > BigInt(CONVENTION_FILE_MAX_BYTES)) throw new Error(`is ${Math.ceil(Number(entry.stat.size) / 1024)} KB, over the 32 KB limit`);
      const got = reader.read(path.split("/"), CONVENTION_FILE_MAX_BYTES);
      if (!got.ok || got.stat.dev !== entry.stat.dev || got.stat.ino !== entry.stat.ino || got.stat.size !== entry.stat.size || got.stat.mtimeNs !== entry.stat.mtimeNs || got.stat.ctimeNs !== entry.stat.ctimeNs) throw new Error("changed or could not be read safely");
      return got.data;
    },
  };
}

function commitReader(repoRoot: string, sha: string): Reader {
  const git = (args: string[], maxBytes?: number) => safeGit(repoRoot, args, undefined, { ...SERVER_GIT_ENV }, maxBytes);
  return {
    async paths(pattern) {
      const got = await git(["ls-tree", "-r", "-z", "--full-tree", sha], PATH_LIST_MAX_BYTES);
      if (got.code !== 0) throw new Error("could not list the convention paths in the commit");
      return listedPaths(got.stdout, pattern);
    },
    async read(path) {
      const entry = await git(["ls-tree", "-z", "--full-tree", sha, "--", `:(literal)${path}`], 4096);
      const record = entry.stdout.toString("utf8").split("\0").find((line) => line.slice(line.indexOf("\t") + 1) === path);
      if (entry.code !== 0 || !record) throw new Error("is missing from the source commit");
      const [mode, type, id] = record.slice(0, record.indexOf("\t")).split(" ");
      if (mode === "120000") throw new Error("is a symbolic link in the source commit");
      if (type !== "blob" || !["100644", "100755"].includes(mode!) || !FULL_ID.test(id!)) throw new Error("is not a regular file in the source commit");
      const size = await git(["cat-file", "-s", id!], 1024);
      const bytes = Number(size.stdout.toString("utf8").trim());
      if (size.code !== 0 || !Number.isSafeInteger(bytes) || bytes < 0) throw new Error("could not be read from the source commit");
      if (bytes > CONVENTION_FILE_MAX_BYTES) throw new Error(`is ${Math.ceil(bytes / 1024)} KB, over the 32 KB limit`);
      const blob = await git(["cat-file", "blob", id!], CONVENTION_FILE_MAX_BYTES);
      if (blob.code !== 0 || blob.stdout.length !== bytes) throw new Error("could not be read whole from the source commit");
      return blob.stdout;
    },
  };
}

export function instructionNotes(provenance: readonly InstructionProvenance[]): string[] {
  const supplied = provenance.filter((file) => file.omitted === null);
  return [
    ...(supplied.length > 0 ? [`Conventions supplied: ${supplied.map((file) => `${file.path} (${file.source}, ${file.bytes} bytes)`).join(", ")}`] : []),
    ...provenance.flatMap((file) => [
      ...(file.omitted ? [`Convention omitted: ${file.path} ${file.omitted}; not shown to the reviewer`] : []),
      ...(file.transformed ? [`Convention transformed: ${file.path}: ${file.transformed}`] : []),
    ]),
  ];
}

export async function resolveInstructionFiles(args: { repoRoot: string; paths: readonly string[]; owners?: string; source?: string; admit?: (path: string) => boolean }): Promise<InstructionSet> {
  const owners = args.owners ?? "";
  const files: InstructionFile[] = [];
  const provenance: InstructionProvenance[] = [];
  const rawFiles: { path: string; raw: string }[] = [];
  if (args.paths.length === 0) return { files, provenance, notes: [], hash: instructionSetHash(owners, rawFiles) };
  const source = args.source === undefined || args.source === "work tree" || args.source === "none" ? (args.source ?? "work tree") : await commitOf(args.repoRoot, args.source);
  const reader = source === "none" ? null : source === "work tree" ? workTreeReader(args.repoRoot) : commitReader(args.repoRoot, source);
  const seen = new Set<string>();
  let total = 0;
  for (const chosen of args.paths) {
    let paths = [chosen];
    let expansionError: string | null = null;
    try {
      if (plain(chosen) && glob(chosen) && reader) paths = await reader.paths(chosen);
    } catch (error) {
      expansionError = `could not expand the glob: ${(error as Error).message}`;
    }
    for (const path of paths) {
      if (seen.has(path)) continue;
      seen.add(path);
      const record: InstructionProvenance = { path, source, sha256: null, bytes: null, omitted: null };
      provenance.push(record);
      try {
        if (expansionError) throw new Error(expansionError);
        if (!plain(path)) throw new Error("is not a repo-relative path inside the repository");
        if (args.admit && !args.admit(path)) throw new Error("is outside the review's scopes; supply it through instructions if needed");
        if (!reader) throw new Error("has no convention source selected");
        const bytes = await reader.read(path);
        record.bytes = bytes.length;
        if (total + bytes.length > CONVENTIONS_MAX_BYTES) throw new Error("would exceed the 64 KB total limit");
        const raw = bytes.toString("utf8");
        if (isShippedInstructionFile(raw)) throw new Error("is an unchanged OpenQodex rule file");
        const text = stripInstructionSections(raw);
        if (text !== raw) record.transformed = "shipped OpenQodex section removed";
        if (text.trim() === "") throw new Error("has no conventions after removing any shipped OpenQodex section");
        total += bytes.length;
        record.sha256 = sha256(bytes);
        rawFiles.push({ path, raw });
        files.push({ path, text, source });
      } catch (error) {
        record.omitted = (error as Error).message;
      }
    }
  }
  return { files, provenance, notes: instructionNotes(provenance), hash: instructionSetHash(owners, rawFiles) };
}

// No discovery or cap admission here. A formerly skipped file stays skipped.
export async function verifyInstructionFiles(repoRoot: string, provenance: readonly InstructionProvenance[], owners = ""): Promise<string | null> {
  const files: { path: string; raw: string }[] = [];
  for (const file of provenance) {
    if (file.omitted !== null) continue;
    try {
      if (!plain(file.path) || (file.source !== "work tree" && !FULL_ID.test(file.source))) throw new Error("invalid provenance");
      const reader = file.source === "work tree" ? workTreeReader(repoRoot) : commitReader(repoRoot, file.source);
      const bytes = await reader.read(file.path);
      if (sha256(bytes) !== file.sha256) throw new Error("content changed");
      files.push({ path: file.path, raw: bytes.toString("utf8") });
    } catch {
      throw new OpenQodexError(`${file.path} changed since the brief, was deleted, linked or could not be read; run review again (openqodex review --agent)`);
    }
  }
  return instructionSetHash(owners, files);
}
