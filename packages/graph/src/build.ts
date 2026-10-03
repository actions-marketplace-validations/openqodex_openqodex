// Builds the graph of a repo: list the files git knows, read each file's
// facts from the cache or a parse, then resolve. Parsing stops at the time
// budget (checked between files) or the file cap; the graph is then
// "partial" and says what it left out. No timer is set, so nothing keeps the
// process alive after the build.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, rmSync } from "node:fs";
import { extname, join, posix } from "node:path";
import { promisify } from "node:util";
import type { Parser } from "web-tree-sitter";
import { EXTRACTOR_VERSION, extract } from "./extract.js";
import { grammarVersion, parserFor } from "./parser.js";
import type { FileInput, TsPaths } from "./resolve.js";
import { resolveGraph, symbolId } from "./resolve.js";
import { RepoReader, isFileFacts, readNoFollow, safeCacheDir, writeExclusive } from "./safe-fs.js";
import type { FileFacts, Graph, GraphEdge, GraphNode, Lang } from "./types.js";

const run = promisify(execFile);

export const DEFAULT_BUDGET_MS = 10_000;
export const DEFAULT_MAX_FILES = 4000;
export const DEFAULT_MAX_FILE_BYTES = 512 * 1024;

const EXT_LANG: Record<string, Lang> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".go": "go",
  ".rb": "ruby",
  ".rake": "ruby",
};

// Folders that hold generated, vendored or installed code, never the repo's own.
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  "vendor",
  ".openqodex",
]);

export function langOf(path: string): Lang | null {
  if (path.endsWith(".d.ts") || path.endsWith(".d.mts") || path.endsWith(".d.cts") || /\.min\.[cm]?js$/.test(path)) return null;
  if (path.split("/").some((part) => SKIP_DIRS.has(part))) return null;
  return EXT_LANG[extname(path).toLowerCase()] ?? null;
}

export type BuildArgs = {
  repoRoot: string;
  // Paths to parse first (the change), so a budget cut never loses them.
  files?: string[];
  // When set, the only paths the graph may read: anything else is left out
  // as if it were not in the repo (a whole-repo review passes its inventory,
  // so an excluded file never reaches the brief).
  only?: string[];
  budgetMs?: number;
  maxFiles?: number;
  maxFileBytes?: number;
  cacheDir: string;
  onProgress?: (line: string) => void;
  // The change's base: each changed file's base version is parsed too, so a
  // symbol the change removed is known with its surviving callers.
  base?: { sha: string; files: { path: string; oldPath: string | null; status: "added" | "modified" | "deleted" | "renamed" }[] };
};

async function gitFiles(repoRoot: string): Promise<string[]> {
  const { stdout } = await run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: repoRoot,
    maxBuffer: 256 * 1024 * 1024,
  });
  return [...new Set(stdout.split("\0").filter(Boolean))];
}

function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

// `paths` and `baseUrl` from the root tsconfig.json, following relative
// `extends`. Package-level tsconfig files are not read.
const META_BYTES = 1024 * 1024;
const CACHE_ENTRY_BYTES = 32 * 1024 * 1024;

function readTsPaths(reader: RepoReader, known: ReadonlySet<string>): TsPaths {
  let file = "tsconfig.json";
  let paths: [string, string[]][] | null = null;
  let baseUrl: string | null = null;
  let baseDir = "";
  for (let hop = 0; hop < 5 && known.has(file); hop++) {
    let config: { extends?: unknown; compilerOptions?: { paths?: Record<string, string[]>; baseUrl?: string } };
    try {
      const text = reader.read(file, META_BYTES);
      if (text === null) break;
      config = JSON.parse(stripJsonComments(text)) as typeof config;
    } catch {
      break;
    }
    const dir = posix.dirname(file) === "." ? "" : posix.dirname(file);
    const opts = config.compilerOptions ?? {};
    if (baseUrl === null && typeof opts.baseUrl === "string") baseUrl = posix.normalize(posix.join(dir, opts.baseUrl)).replace(/^\.$/, "");
    if (paths === null && opts.paths && typeof opts.paths === "object") {
      paths = Object.entries(opts.paths).filter((e): e is [string, string[]] => Array.isArray(e[1]));
      baseDir = typeof opts.baseUrl === "string" ? posix.normalize(posix.join(dir, opts.baseUrl)).replace(/^\.$/, "") : dir;
    }
    if (typeof config.extends !== "string" || !config.extends.startsWith(".")) break;
    const next = posix.normalize(posix.join(dir, config.extends));
    file = next.endsWith(".json") ? next : `${next}.json`;
  }
  if (paths === null && baseUrl === null) return null;
  return { baseDir, paths: paths ?? [], baseUrl };
}

function readGoModules(reader: RepoReader, all: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (const f of all) {
    if (f !== "go.mod" && !f.endsWith("/go.mod")) continue;
    if (f.split("/").some((part) => SKIP_DIRS.has(part))) continue;
    try {
      const m = /^module\s+(\S+)/m.exec(reader.read(f, META_BYTES) ?? "");
      if (m?.[1]) out.push([m[1].replace(/^"|"$/g, ""), posix.dirname(f) === "." ? "" : posix.dirname(f)]);
    } catch {
      // unreadable go.mod: its imports stay outside the repo
    }
  }
  return out;
}

type CacheEntry = { key: string; facts: FileFacts };

class FactCache {
  used = new Set<string>();
  hits = 0;
  parses = 0;
  private parsers = new Map<Lang, Parser>();

  // `dir` null: no cache this build (a link in its path, or files of the
  // repo's own in it); everything is parsed and nothing is written.
  constructor(readonly dir: string | null) {}

  key(lang: Lang, content: Buffer | string): string {
    return createHash("sha1").update(`${EXTRACTOR_VERSION}\0${lang}\0${grammarVersion(lang)}\0`).update(content).digest("hex");
  }

  read(key: string): FileFacts | null {
    if (!this.dir) return null;
    const text = readNoFollow(join(this.dir, `${key}.json`), CACHE_ENTRY_BYTES);
    if (text === null) return null;
    try {
      const entry = JSON.parse(text) as CacheEntry;
      if (entry.key === key && isFileFacts(entry.facts)) return entry.facts;
    } catch {
      // corrupt: parse again and rewrite
    }
    return null;
  }

  write(key: string, facts: FileFacts): void {
    if (this.dir) writeExclusive(join(this.dir, `${key}.json`), JSON.stringify({ key, facts } satisfies CacheEntry));
  }

  async facts(lang: Lang, content: string, canParse: boolean): Promise<FileFacts | null> {
    const key = this.key(lang, content);
    this.used.add(key);
    const cached = this.read(key);
    if (cached) {
      this.hits++;
      return cached;
    }
    if (!canParse) return null;
    let parser = this.parsers.get(lang);
    if (!parser) {
      parser = await parserFor(lang);
      this.parsers.set(lang, parser);
    }
    const tree = parser.parse(content);
    if (!tree) return null;
    this.parses++;
    try {
      const facts = extract(tree, lang);
      this.write(key, facts);
      return facts;
    } finally {
      tree.delete();
    }
  }

  // Entries this build did not use belong to files that changed or are gone.
  // Only regular files named the way this cache names them are removed.
  prune(): void {
    if (!this.dir) return;
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!/^[0-9a-f]{40}\.json$/.test(name) || this.used.has(name.slice(0, -5))) continue;
      const path = join(this.dir, name);
      try {
        if (lstatSync(path).isFile()) rmSync(path);
      } catch {
        // gone already
      }
    }
  }

  close(): void {
    for (const p of this.parsers.values()) p.delete();
  }
}

// The cache folder when it is safe to use: no link in its path and no file
// in it that git tracks (a repo could ship forged entries).
async function usableCacheDir(repoRoot: string, dir: string): Promise<string | null> {
  const safe = safeCacheDir(repoRoot, dir);
  if (safe === null) return null;
  try {
    const { stdout } = await run("git", ["ls-files", "-z", "--", safe], { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 });
    return stdout.length > 0 ? null : safe;
  } catch {
    return safe; // outside the repo: nothing there is tracked
  }
}

async function gitShow(repoRoot: string, sha: string, path: string): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["show", `${sha}:${path}`], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch {
    return null;
  }
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

export async function buildGraph(args: BuildArgs): Promise<Graph> {
  const started = performance.now();
  const budgetMs = args.budgetMs ?? DEFAULT_BUDGET_MS;
  const maxFiles = args.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = args.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const allowed = args.only === undefined ? null : new Set(args.only);
  const all = (await gitFiles(args.repoRoot)).filter((f) => allowed === null || allowed.has(f));
  const eligible = all.filter((f) => langOf(f) !== null);
  const known = new Set(eligible);
  for (const f of all) if (f.endsWith("__init__.py")) known.add(f);

  // The change first, then everything else in git's order.
  const first = (args.files ?? []).filter((f) => known.has(f));
  const firstSet = new Set(first);
  const order = [...first, ...eligible.filter((f) => !firstSet.has(f))];

  const reader = new RepoReader(args.repoRoot);
  const cacheDir = await usableCacheDir(args.repoRoot, args.cacheDir);
  if (cacheDir === null) args.onProgress?.("openqodex: the code graph cache is not used: its folder is a link, holds tracked files or cannot be made");
  const cache = new FactCache(cacheDir);
  const inputs: FileInput[] = [];
  let tooBig = 0;
  let overBudget = 0;
  let overCap = 0;
  try {
    for (const path of order) {
      if (inputs.length >= maxFiles) {
        overCap++;
        continue;
      }
      const lang = langOf(path) as Lang;
      let size: number;
      try {
        const st = lstatSync(join(args.repoRoot, path));
        if (!st.isFile()) continue; // a symbolic link or a folder
        size = st.size;
      } catch {
        continue; // gone since git listed it
      }
      if (size > maxFileBytes) {
        tooBig++;
        continue;
      }
      const content = reader.read(path, maxFileBytes);
      if (content === null) continue; // a link in its path, or changed under us
      // Past the budget only cached facts are used; nothing more is parsed.
      const canParse = performance.now() - started < budgetMs;
      const facts = await cache.facts(lang, content, canParse);
      if (!facts) {
        overBudget++;
        continue;
      }
      inputs.push({ path, facts });
    }

    // The base side of each changed file, for removed symbols. Only a file
    // whose current side was read, or that is deleted, is compared: a file
    // left out by a cap would otherwise look emptied. Base parses count
    // against the same budget and file cap.
    const baseDefs = new Map<string, { file: string; facts: FileFacts }>();
    const current = new Set(inputs.map((i) => i.path));
    let baseParsed = 0;
    let removalUnchecked = 0;
    for (const f of args.base?.files ?? []) {
      if (f.status === "added" || !args.base) continue;
      const basePath = f.oldPath ?? f.path;
      const lang = langOf(basePath);
      if (!lang) continue;
      known.add(basePath);
      if (f.status !== "deleted" && !current.has(f.path)) continue;
      const canParse = performance.now() - started < budgetMs && inputs.length + baseParsed < maxFiles;
      const content = await gitShow(args.repoRoot, args.base.sha, basePath);
      const facts = content === null || Buffer.byteLength(content) > maxFileBytes ? null : await cache.facts(lang, content, canParse);
      if (!facts) {
        removalUnchecked++;
        continue;
      }
      baseParsed++;
      baseDefs.set(f.path, { file: basePath, facts });
    }
    cache.prune();

    const goModules = readGoModules(reader, all);
    const resolved = resolveGraph({ files: inputs, known, tsPaths: readTsPaths(reader, new Set(all)), goModules });

    // Symbols in the base version of a changed file and gone now.
    const removed = new Map<string, GraphNode[]>();
    for (const [path, base] of baseDefs) {
      const now = new Set((resolved.defsByFile.get(path) ?? []).map((n) => `${n.kind}\0${ownerOf(n.id)}\0${n.name}`));
      const gone: GraphNode[] = [];
      for (const d of base.facts.defs) {
        if (now.has(`${d.kind}\0${d.owner ?? ""}\0${d.name}`)) continue;
        gone.push({
          id: `base:${symbolId(base.file, d)}`,
          file: base.file,
          name: d.name,
          kind: d.kind,
          startLine: d.line,
          endLine: d.endLine,
          snapshot: "base",
          exported: d.exported,
          lang: base.facts.lang,
        });
      }
      if (gone.length > 0) removed.set(path, gone);
    }

    const graphIn = new Map<string, GraphEdge[]>();
    const graphOut = new Map<string, GraphEdge[]>();
    for (const e of resolved.edges) {
      (graphIn.get(e.to) ?? graphIn.set(e.to, []).get(e.to))?.push(e);
      (graphOut.get(e.from) ?? graphOut.set(e.from, []).get(e.from))?.push(e);
    }

    const skipped = tooBig + overBudget + overCap;
    const reasons: string[] = [];
    if (removalUnchecked > 0) reasons.push(`removed symbols were not checked in ${plural(removalUnchecked, "changed file")}`);
    if (overBudget > 0) reasons.push(`the ${(budgetMs / 1000).toFixed(budgetMs < 1000 ? 3 : 0)} s budget ran out with ${plural(overBudget, "file")} not parsed`);
    if (overCap > 0) reasons.push(`the ${plural(maxFiles, "file")} cap left out ${plural(overCap, "file")}`);
    if (tooBig > 0) reasons.push(`${plural(tooBig, "file")} over ${Math.round(maxFileBytes / 1024)} KB not parsed`);
    const durationMs = Math.round(performance.now() - started);
    args.onProgress?.(
      `openqodex: code graph of ${plural(inputs.length, "file")} in ${(durationMs / 1000).toFixed(1)} s (${cache.parses} parsed, ${cache.hits} from cache)`,
    );
    return {
      repoRoot: args.repoRoot,
      nodes: resolved.nodes,
      edges: resolved.edges,
      in: graphIn,
      out: graphOut,
      importers: resolved.importers,
      defsByFile: resolved.defsByFile,
      removed,
      misses: resolved.misses,
      status: {
        status: skipped > 0 || removalUnchecked > 0 ? "partial" : "ok",
        reason: reasons[0] ?? null,
        reasons,
        filesParsed: inputs.length,
        filesSkipped: skipped,
        durationMs,
        eligibleFiles: eligible.length,
        cacheHits: cache.hits,
        parses: cache.parses,
        unresolvedSites: resolved.unresolvedSites,
      },
    };
  } finally {
    cache.close();
  }
}

// "a.ts#Cls.m@3:5" to "Cls"; "" for a symbol with no owner.
function ownerOf(id: string): string {
  const name = id.slice(id.indexOf("#") + 1, id.lastIndexOf("@"));
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(0, dot);
}
