// Reads and writes inside the repo that a hostile repo cannot redirect: no
// path component may be a symbolic link, files are opened without following
// links, and every read is bounded.
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { FolderReader } from "@openqodex/core";
import type { FileFacts } from "./types.js";

// Repo-relative reads, each decided by what the filesystem holds at the
// moment of that read and by nothing kept from an earlier one. The root is
// known by its identity (device and inode) from the moment the reader is
// made. Every read walks from it one name at a time, each folder a real
// folder (lstat: a link is not one), opens the file without following a
// link and without blocking, then walks again and requires the same
// folders by identity and the opened file at its name (FolderReader,
// packages/core/src/guarded-fs.ts). A folder swapped for a link after one
// read stops the next read.
export class RepoReader {
  // Null when the root is not a folder: every read then gives null.
  private readonly folders: FolderReader | null;

  constructor(readonly root: string) {
    let folders: FolderReader | null = null;
    try {
      folders = new FolderReader(resolve(root));
    } catch {
      // not a folder: nothing below it can be read
    }
    this.folders = folders;
  }

  read(rel: string, maxBytes: number): string | null {
    return this.readBytes(rel, maxBytes)?.toString("utf8") ?? null;
  }

  // The regular file `rel` (a path from the root, `/` between names) when
  // it holds at most `maxBytes`; null otherwise. An empty name, `.` or `..`
  // anywhere in it is refused.
  readBytes(rel: string, maxBytes: number): Buffer | null {
    if (this.folders === null || isAbsolute(rel)) return null;
    const got = this.folders.read(rel.split("/"), maxBytes);
    return got.ok ? got.data : null;
  }
}

// The cache folder, made and checked component by component below the repo
// root (or, for a folder outside the repo, the folder itself): null when any
// component is a link or not a folder.
export function safeCacheDir(repoRoot: string, dir: string): string | null {
  const rel = relative(repoRoot, dir);
  const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  const steps = inside ? rel.split(sep) : [];
  let cur = inside ? repoRoot : dir;
  const check = (path: string): boolean => {
    try {
      mkdirSync(path);
    } catch {
      // already there, or the parent cannot hold it: lstat decides
    }
    try {
      const st = lstatSync(path);
      return st.isDirectory() && !st.isSymbolicLink();
    } catch {
      return false;
    }
  };
  if (!inside) return check(dir) ? dir : null;
  for (const step of steps) {
    cur = join(cur, step);
    if (!check(cur)) return null;
  }
  return cur;
}

// Written through a fresh temporary file (created exclusively, so never
// through a link) and renamed over the target entry.
export function writeExclusive(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, content, { flag: "wx" });
    renameSync(tmp, path);
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // nothing was written
    }
  }
}

// ---------- the cached facts must match their schema exactly ----------

const MAX_ITEMS = 200_000;
const isStr = (v: unknown): v is string => typeof v === "string" && v.length <= 4096;
const isInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= -1 && (v as number) <= 10_000_000;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const optBool = (v: unknown) => v === undefined || typeof v === "boolean";
const isList = (v: unknown, each: (x: unknown) => boolean, max = MAX_ITEMS): boolean => Array.isArray(v) && v.length <= max && v.every(each);

// A scoped import binding: absent, or an import of this file by index.
function optBound(b: unknown, imports: number): boolean {
  return b === undefined || (isObj(b) && isInt(b.import) && (b.import as number) >= 0 && (b.import as number) < imports && isStr(b.imported));
}

function isTypeRef(v: unknown, imports: number): boolean {
  return (
    isObj(v) &&
    isStr(v.name) &&
    (v.qualifier === null || isStr(v.qualifier)) &&
    isInt(v.line) &&
    isInt(v.column) &&
    (v.result === undefined || isInt(v.result)) &&
    optBool(v.elem) &&
    optBool(v.declared) &&
    optBound(v.bound, imports)
  );
}

function isReceiver(v: unknown, imports: number): boolean {
  if (!isObj(v)) return false;
  const path = (p: unknown) => isList(p, isStr, 64);
  switch (v.kind) {
    case "none":
    case "super":
    case "other":
      return true;
    case "self":
      return path(v.path);
    case "type":
      return isTypeRef(v.type, imports) && path(v.path);
    case "name":
      return isStr(v.name) && path(v.path) && (v.nesting === null || isStr(v.nesting)) && optBound(v.bound, imports);
    default:
      return false;
  }
}

const KINDS = new Set(["function", "method", "class", "module", "type"]);
const LANGS = new Set(["typescript", "tsx", "javascript", "python", "go", "ruby"]);

function isDef(v: unknown, imports: number): boolean {
  const isType = (t: unknown) => isTypeRef(t, imports);
  return (
    isObj(v) &&
    isStr(v.name) &&
    KINDS.has(v.kind as string) &&
    (v.owner === null || isStr(v.owner)) &&
    isInt(v.line) &&
    isInt(v.column) &&
    isInt(v.endLine) &&
    typeof v.exported === "boolean" &&
    typeof v.topLevel === "boolean" &&
    isList(v.bases, isType, 1024) &&
    isObj(v.fields) &&
    Object.keys(v.fields).length <= 4096 &&
    Object.values(v.fields).every(isType) &&
    (v.results === undefined || isList(v.results, (r) => r === null || isType(r), 64)) &&
    (v.alias === undefined || isType(v.alias)) &&
    optBool(v.static) &&
    (v.bodyHash === undefined || (typeof v.bodyHash === "string" && /^[0-9a-f]{16}$/.test(v.bodyHash)))
  );
}

export function isFileFacts(v: unknown): v is FileFacts {
  if (!isObj(v) || !LANGS.has(v.lang as string)) return false;
  const imports = Array.isArray(v.imports) ? v.imports.length : 0;
  if (!isList(v.defs, (d) => isDef(d, imports))) return false;
  const defs = (v.defs as unknown[]).length;
  const isCall = (c: unknown) =>
    isObj(c) &&
    isStr(c.name) &&
    isInt(c.line) &&
    isInt(c.column) &&
    isInt(c.caller) &&
    (c.caller as number) < defs &&
    isReceiver(c.recv, imports) &&
    optBool(c.implicit) &&
    optBool(c.shadowed) &&
    optBool(c.static) &&
    optBool(c.dynamic) &&
    (c.local === undefined || (isInt(c.local) && (c.local as number) >= 0 && (c.local as number) < defs)) &&
    optBound(c.bound, imports);
  const isImport = (i: unknown) =>
    isObj(i) &&
    isStr(i.spec) &&
    isInt(i.line) &&
    isInt(i.column) &&
    isList(i.names, (n) => isObj(n) && isStr(n.imported) && isStr(n.local), 4096) &&
    (i.namespace === null || isStr(i.namespace)) &&
    typeof i.star === "boolean" &&
    typeof i.reexport === "boolean" &&
    typeof i.typeOnly === "boolean" &&
    optBool(i.relative) &&
    optBool(i.alias) &&
    optBool(i.scoped);
  return (
    isList(v.calls, isCall) &&
    isList(v.imports, isImport, 20_000) &&
    isList(v.exportsLocal, (e) => isObj(e) && isStr(e.local) && isStr(e.exported) && (e.line === undefined || isInt(e.line)), 20_000) &&
    (v.defaultExport === null || isStr(v.defaultExport)) &&
    (v.goPackage === null || isStr(v.goPackage))
  );
}
