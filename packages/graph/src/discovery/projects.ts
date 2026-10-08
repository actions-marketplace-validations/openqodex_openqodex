// The project model: every manifest in the repository, read as text and
// never run. It answers, for one importing file, which workspace package a
// bare specifier names and whether the importer's package declares it,
// which tsconfig governs the file and whether its globs admit it, where the
// Python source roots are, and whether a module that is not in the
// repository is a declared dependency or part of a standard library.
//
// Every read is bounded (1 MB) and goes through the RepoReader, so no link
// below the repository root is followed. Nothing here fetches or executes.
import { posix } from "node:path";
import type { RepoReader } from "../safe-fs.js";
import { globMatch } from "./glob.js";
import { LOCKFILE_BYTES, MANIFEST_BYTES, gemfileGems, goModRequires, normalisePy, parseJsonc, pnpmLinks, pnpmPackages, pyprojectDeps, requirementsDeps, setupCfgRequires, yarnLock } from "./manifests.js";
import type { Linkage } from "./manifests.js";

export { LOCKFILE_BYTES, MANIFEST_BYTES, normalisePy, parseJsonc, pnpmLinks, pnpmPackages };
export type { Linkage };

// Folders whose manifests are never the repository's own projects.
const NOT_PROJECTS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", ".turbo", ".cache", "coverage", "__pycache__", ".venv", "venv", "vendor", ".openqodex"]);

export type PackageJson = {
  name: string | null;
  version: string | null;
  main: string | null;
  module: string | null;
  exports: unknown; // as written
  type: "module" | "commonjs";
  deps: Map<string, string>; // dependencies, devDependencies, peerDependencies, optionalDependencies: name to the spec as written
  workspaces: string[] | null;
};

export type NodeProject = { dir: string; file: string; pkg: PackageJson };

export type TsConfig = {
  file: string;
  dir: string;
  // Folder `paths` targets are relative to: baseUrl when set, else the
  // folder of the config that set `paths`.
  pathsBase: string;
  paths: [string, string[]][];
  baseUrl: string | null;
  files: string[] | null; // as resolved from the repo root
  include: string[] | null;
  exclude: string[] | null;
  references: string[]; // folders of referenced projects, from the repo root
  customConditions: string[];
  rootDir: string | null;
  outDir: string | null;
};

export type ProjectModel = {
  node: NodeProject[];
  // Workspace members by package name. A name two members share maps to both.
  members: Map<string, NodeProject[]>;
  workspaceFiles: string[]; // the manifests that declared the workspace
  tsconfigs: Map<string, TsConfig>; // by folder
  pyRoots: string[]; // extra Python source roots: `src` folders holding a package, pyproject and setup folders
  pyDeclared: Set<string>; // normalised distribution names declared by any Python manifest
  goRequires: string[]; // module paths go.mod files require
  gems: Set<string>;
  pnpmLinks: Map<string, Map<string, Linkage>>; // importer folder to dependency name to what the lockfile resolved
  npmLock: Map<string, Linkage>; // "<importer>/node_modules/<name>" or "node_modules/<name>" to linkage
  yarnWorkspace: Set<string>; // names yarn.lock resolves to a workspace
  yarnPublished: Set<string>; // names yarn.lock resolves from a registry
};

const dirOf = (path: string): string => {
  const d = posix.dirname(path);
  return d === "." ? "" : d;
};

const join = (...parts: string[]): string => {
  const j = posix.normalize(posix.join(...parts.filter((p) => p !== "")));
  return j === "." ? "" : j;
};

function skipped(path: string): boolean {
  return path.split("/").some((p) => NOT_PROJECTS.has(p));
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const strList = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null);

function readPackageJson(text: string): PackageJson | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(v)) return null;
  const deps = new Map<string, string>();
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const d = v[field];
    if (!isObj(d)) continue;
    for (const [k, spec] of Object.entries(d)) if (typeof spec === "string" && !deps.has(k)) deps.set(k, spec);
  }
  const ws = v.workspaces;
  const workspaces = strList(ws) ?? (isObj(ws) ? strList(ws.packages) : null);
  return {
    name: str(v.name),
    version: str(v.version),
    main: str(v.main),
    module: str(v.module),
    exports: v.exports ?? null,
    type: v.type === "module" ? "module" : "commonjs",
    deps,
    workspaces,
  };
}

// Member folders of a workspace: every package.json folder a positive glob
// admits and no negated glob excludes, globs relative to the declaring file.
function membersOf(globs: string[], declaredIn: string, projects: NodeProject[]): NodeProject[] {
  const base = dirOf(declaredIn);
  const pos = globs.filter((g) => !g.startsWith("!")).map((g) => join(base, g.replace(/\/$/, "")));
  const neg = globs.filter((g) => g.startsWith("!")).map((g) => join(base, g.slice(1).replace(/\/$/, "")));
  return projects.filter((p) => p.dir !== base && pos.some((g) => globMatch(p.dir, g)) && !neg.some((g) => globMatch(p.dir, g)));
}

// tsconfig.json, following relative `extends` (at most five hops). A config
// whose `extends` names a package is read for its own options only.
function readTsconfig(reader: RepoReader, file: string, known: ReadonlySet<string>): TsConfig | null {
  const dir = dirOf(file);
  const out: TsConfig = {
    file,
    dir,
    pathsBase: dir,
    paths: [],
    baseUrl: null,
    files: null,
    include: null,
    exclude: null,
    references: [],
    customConditions: [],
    rootDir: null,
    outDir: null,
  };
  let at = file;
  let pathsSet = false;
  let baseUrlSet = false;
  for (let hop = 0; hop < 5 && known.has(at); hop++) {
    let config: unknown;
    try {
      const text = reader.read(at, MANIFEST_BYTES);
      if (text === null) break;
      config = parseJsonc(text);
    } catch {
      break;
    }
    if (!isObj(config)) break;
    const here = dirOf(at);
    const opts = isObj(config.compilerOptions) ? config.compilerOptions : {};
    // The nearest config's own values win over what it extends.
    if (!baseUrlSet && typeof opts.baseUrl === "string") {
      out.baseUrl = join(here, opts.baseUrl);
      baseUrlSet = true;
    }
    if (!pathsSet && isObj(opts.paths)) {
      out.paths = Object.entries(opts.paths).filter((e): e is [string, string[]] => Array.isArray(e[1]) && e[1].every((t) => typeof t === "string"));
      out.pathsBase = typeof opts.baseUrl === "string" ? join(here, opts.baseUrl) : here;
      pathsSet = true;
    }
    if (out.customConditions.length === 0 && Array.isArray(opts.customConditions)) out.customConditions = strList(opts.customConditions) ?? [];
    if (out.rootDir === null && typeof opts.rootDir === "string") out.rootDir = join(here, opts.rootDir);
    if (out.outDir === null && typeof opts.outDir === "string") out.outDir = join(here, opts.outDir);
    // `files`, `include` and `exclude` are inherited whole, resolved from the config that wrote them.
    if (out.files === null && Array.isArray(config.files)) out.files = (strList(config.files) ?? []).map((f) => join(here, f));
    if (out.include === null && Array.isArray(config.include)) out.include = (strList(config.include) ?? []).map((g) => join(here, g));
    if (out.exclude === null && Array.isArray(config.exclude)) out.exclude = (strList(config.exclude) ?? []).map((g) => join(here, g));
    if (at === file && Array.isArray(config.references)) {
      for (const r of config.references) {
        if (!isObj(r) || typeof r.path !== "string") continue;
        // A reference names a folder or a tsconfig file in it.
        const ref = join(here, r.path);
        const last = posix.basename(ref);
        out.references.push(last.startsWith("tsconfig") && last.endsWith(".json") ? dirOf(ref) : ref);
      }
    }
    if (typeof config.extends !== "string" || !config.extends.startsWith(".")) break;
    const next = join(here, config.extends);
    at = next.endsWith(".json") ? next : `${next}.json`;
  }
  return out;
}

// Whether a tsconfig's `files`, `include` and `exclude` admit `path`, as
// TypeScript reads them: no `files` and no `include` means everything under
// the config's folder; a folder in `include` means everything under it.
export function tsAdmits(config: TsConfig, path: string): boolean {
  const under = (glob: string, p: string): boolean => {
    if (globMatch(p, glob)) return true;
    // A pattern with no wildcard in its last part names a folder (or a file).
    const last = glob.split("/").pop() ?? "";
    if (!/[*?]/.test(last)) return glob === "" || p.startsWith(`${glob}/`) || globMatch(p, `${glob}/**`);
    return false;
  };
  if (config.files?.includes(path)) return true;
  const include = config.include ?? (config.files === null ? [join(config.dir, "**/*")] : []);
  if (!include.some((g) => under(g, path))) return false;
  const exclude = config.exclude ?? [join(config.dir, "node_modules"), ...(config.outDir ? [config.outDir] : [])];
  return !exclude.some((g) => under(g, path));
}

function npmLock(text: string): Map<string, Linkage> {
  const out = new Map<string, Linkage>();
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return out;
  }
  if (!isObj(v) || !isObj(v.packages)) return out;
  for (const [key, entry] of Object.entries(v.packages)) {
    if (!key.includes("node_modules/") || !isObj(entry)) continue;
    const resolved = str(entry.resolved) ?? "";
    out.set(key, entry.link === true ? "workspace" : /^https?:/.test(resolved) || typeof entry.version === "string" ? "published" : "unknown");
  }
  return out;
}

// Builds the model from every path git lists (`all`) and the reader of
// the tree they are in.
export function discoverProjects(all: readonly string[], reader: RepoReader): ProjectModel {
  const known = new Set(all);
  // A manifest over its cap is not read at all.
  const read = (path: string, max = MANIFEST_BYTES): string | null => {
    try {
      return reader.read(path, max);
    } catch {
      return null;
    }
  };
  const model: ProjectModel = {
    node: [],
    members: new Map(),
    workspaceFiles: [],
    tsconfigs: new Map(),
    pyRoots: [],
    pyDeclared: new Set(),
    goRequires: [],
    gems: new Set(),
    pnpmLinks: new Map(),
    npmLock: new Map(),
    yarnWorkspace: new Set(),
    yarnPublished: new Set(),
  };
  const pyRoots = new Set<string>();
  const pyPackageDirs = new Set<string>(); // folders holding .py files
  for (const path of all) {
    if (skipped(path)) continue;
    const base = posix.basename(path);
    if (base === "package.json") {
      const text = read(path);
      const pkg = text === null ? null : readPackageJson(text);
      if (pkg) model.node.push({ dir: dirOf(path), file: path, pkg });
    } else if (base === "tsconfig.json" || base === "jsconfig.json") {
      const config = readTsconfig(reader, path, known);
      // tsconfig.json wins over jsconfig.json in one folder.
      if (config && (base === "tsconfig.json" || !model.tsconfigs.has(config.dir))) model.tsconfigs.set(config.dir, config);
    } else if (base === "pyproject.toml" || base === "setup.cfg" || base === "setup.py") {
      pyRoots.add(dirOf(path));
      const text = read(path) ?? "";
      if (base === "pyproject.toml") for (const n of pyprojectDeps(text)) model.pyDeclared.add(n);
      else if (base === "setup.cfg") for (const n of setupCfgRequires(text)) model.pyDeclared.add(n);
    } else if (base.startsWith("requirements") && base.endsWith(".txt")) {
      for (const n of requirementsDeps(read(path) ?? "")) model.pyDeclared.add(n);
    } else if (base === "go.mod") {
      model.goRequires.push(...goModRequires(read(path) ?? ""));
    } else if (base === "Gemfile") {
      for (const g of gemfileGems(read(path) ?? "")) model.gems.add(g);
    } else if (base === "pnpm-lock.yaml" && dirOf(path) === "") {
      model.pnpmLinks = pnpmLinks(read(path, LOCKFILE_BYTES) ?? "");
    } else if (base === "package-lock.json" && dirOf(path) === "") {
      model.npmLock = npmLock(read(path, LOCKFILE_BYTES) ?? "");
    } else if (base === "yarn.lock" && dirOf(path) === "") {
      const y = yarnLock(read(path, LOCKFILE_BYTES) ?? "");
      model.yarnWorkspace = y.workspace;
      model.yarnPublished = y.published;
    }
    if (path.endsWith(".py")) pyPackageDirs.add(dirOf(path));
  }
  // `src` folders that hold a Python package (a folder of .py files below them).
  for (const d of pyPackageDirs) {
    const parts = d.split("/");
    const i = parts.lastIndexOf("src");
    if (i !== -1 && i < parts.length - 1) pyRoots.add(parts.slice(0, i + 1).join("/"));
  }
  model.pyRoots = [...pyRoots].sort();

  // Workspaces: pnpm-workspace.yaml and package.json `workspaces`.
  const memberSet = new Set<NodeProject>();
  for (const path of all) {
    if (skipped(path)) continue;
    if (posix.basename(path) === "pnpm-workspace.yaml") {
      const globs = pnpmPackages(read(path) ?? "");
      if (globs.length > 0) {
        model.workspaceFiles.push(path);
        for (const m of membersOf(globs, path, model.node)) memberSet.add(m);
      }
    }
  }
  for (const p of model.node) {
    if (p.pkg.workspaces && p.pkg.workspaces.length > 0) {
      model.workspaceFiles.push(p.file);
      for (const m of membersOf(p.pkg.workspaces, p.file, model.node)) memberSet.add(m);
    }
  }
  for (const m of memberSet) {
    if (m.pkg.name === null) continue;
    const list = model.members.get(m.pkg.name);
    if (list) list.push(m);
    else model.members.set(m.pkg.name, [m]);
  }
  return model;
}

// The nearest package.json folder at or above `file`'s folder.
export function nodeProjectOf(model: ProjectModel, file: string): NodeProject | null {
  let best: NodeProject | null = null;
  for (const p of model.node) {
    if ((p.dir === "" || file.startsWith(`${p.dir}/`)) && (best === null || p.dir.length > best.dir.length)) best = p;
  }
  return best;
}

// The nearest tsconfig.json (or jsconfig.json) at or above the file, and
// whether its globs admit the file (proved membership).
export function governingTsconfig(model: ProjectModel, file: string): { config: TsConfig; admits: boolean } | null {
  let d = dirOf(file);
  for (;;) {
    const config = model.tsconfigs.get(d);
    if (config) return { config, admits: tsAdmits(config, file) };
    if (d === "") return null;
    d = dirOf(d);
  }
}

// Where a dependency declared by a path (`file:` or `link:`) leads, from
// the declaring package's folder and normalised the way npm and pnpm
// resolve it: a folder of the repository, outside the repository, or a
// path the graph cannot place in it (absolute, or from the home folder).
export type LinkPath = { folder: string } | "outside" | "unplaced";

export type Link = { linkage: Linkage; declaredIn: string; spec: string; path?: LinkPath };

function linkPath(dir: string, spec: string): LinkPath {
  const rest = spec.slice(spec.indexOf(":") + 1);
  if (rest.startsWith("/") || rest.startsWith("~") || /^[A-Za-z]:/.test(rest)) return "unplaced";
  const to = join(dir, rest).replace(/\/+$/, "");
  return to === ".." || to.startsWith("../") ? "outside" : { folder: to };
}

// How the importer's package is linked to the dependency `name`: declared
// with the workspace protocol (or a file or link path), resolved by a
// lockfile to a workspace link or to a published version, or declared with
// a plain range no lockfile settles. Null when the importer's package does
// not declare it.
export function linkageOf(model: ProjectModel, importer: string, name: string): Link | null {
  const project = nodeProjectOf(model, importer);
  const declaring = project?.pkg.deps.has(name) ? project : model.node.find((p) => p.dir === "" && p.pkg.deps.has(name)) ?? null;
  if (!declaring) return null;
  const spec = declaring.pkg.deps.get(name) as string;
  if (/^(link|file):/.test(spec)) return { linkage: "workspace", declaredIn: declaring.file, spec, path: linkPath(declaring.dir, spec) };
  if (spec.startsWith("workspace:")) return { linkage: "workspace", declaredIn: declaring.file, spec };
  const fromPnpm = model.pnpmLinks.get(declaring.dir)?.get(name);
  if (fromPnpm && fromPnpm !== "unknown") return { linkage: fromPnpm, declaredIn: declaring.file, spec };
  const fromNpm = model.npmLock.get(declaring.dir === "" ? `node_modules/${name}` : `${declaring.dir}/node_modules/${name}`) ?? model.npmLock.get(`node_modules/${name}`);
  if (fromNpm && fromNpm !== "unknown") return { linkage: fromNpm, declaredIn: declaring.file, spec };
  if (model.yarnWorkspace.has(name)) return { linkage: "workspace", declaredIn: declaring.file, spec };
  if (model.yarnPublished.has(name)) return { linkage: "published", declaredIn: declaring.file, spec };
  return { linkage: "unknown", declaredIn: declaring.file, spec };
}

// Whether a path dependency may bind to the workspace package of its name
// (`memberDir`, null when no workspace package has the name). It binds only
// when its path leads to that package's own folder, compared as folders of
// the repository: a name match alone never binds it. Null: no path
// dependency, or the member's folder. "outside": the path leaves the
// repository, so the code is not the repository's and the call is
// external. A note: why it does not bind.
export function pathLinkOff(link: Link, name: string, memberDir: string | null): "outside" | { note: string } | null {
  const path = link.path;
  if (path === undefined) return null;
  if (path === "outside") return "outside";
  const declared = `${link.declaredIn} declares ${name} as ${link.spec}`;
  if (path === "unplaced") return { note: `${declared}, a path the graph cannot place in this repository` };
  if (path.folder === memberDir) return null;
  const where = path.folder === "" ? "the repository root" : path.folder;
  return { note: memberDir === null ? `${declared}, which leads to ${where}, a folder of this repository that is no workspace package` : `${declared}, which leads to ${where}, not to the workspace package ${memberDir}` };
}

// The package name a bare specifier starts with: `@scope/name` or `name`.
export function packageName(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] as string);
}

const NODE_BUILTINS = new Set(
  "assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns domain events fs http http2 https inspector module net os path perf_hooks process punycode querystring readline repl stream string_decoder sys timers tls trace_events tty url util v8 vm wasi worker_threads zlib test sqlite".split(" "),
);

export function isNodeBuiltin(spec: string): boolean {
  if (spec.startsWith("node:")) return true;
  return NODE_BUILTINS.has(spec.split("/")[0] as string);
}

// The Python 3.11 standard library's top-level module names
// (sys.stdlib_module_names), the ones code imports.
const PY_STDLIB = new Set(
  "__future__ abc argparse array ast asyncio atexit base64 binascii bisect builtins bz2 calendar cgi cmath code codecs collections colorsys concurrent configparser contextlib contextvars copy copyreg cProfile csv ctypes curses dataclasses datetime dbm decimal difflib dis doctest email encodings enum errno faulthandler fcntl filecmp fileinput fnmatch fractions ftplib functools gc getopt getpass gettext glob graphlib grp gzip hashlib heapq hmac html http imaplib importlib inspect io ipaddress itertools json keyword linecache locale logging lzma mailbox marshal math mimetypes mmap multiprocessing netrc numbers operator optparse os pathlib pdb pickle pkgutil platform plistlib poplib posixpath pprint profile pstats pty pwd py_compile queue quopri random re readline reprlib resource rlcompleter runpy sched secrets select selectors shelve shlex shutil signal site smtplib socket socketserver sqlite3 ssl stat statistics string stringprep struct subprocess symtable sys sysconfig syslog tarfile tempfile termios textwrap threading time timeit tkinter token tokenize tomllib trace traceback tracemalloc tty turtle types typing unicodedata unittest urllib uuid venv warnings wave weakref webbrowser winreg wsgiref xml xmlrpc zipapp zipfile zipimport zlib zoneinfo _thread".split(
    " ",
  ),
);

export function isPyStdlib(module: string): boolean {
  return PY_STDLIB.has(module.split(".")[0] as string);
}

const RUBY_STDLIB = new Set("json set yaml psych fileutils pathname time date tempfile open3 securerandom digest base64 erb logger optparse ostruct forwardable singleton net/http uri openssl socket stringio benchmark pp English shellwords csv bigdecimal zlib timeout monitor".split(" "));

export function isRubyStdlib(spec: string): boolean {
  return RUBY_STDLIB.has(spec) || RUBY_STDLIB.has(spec.split("/")[0] as string);
}

// Go: a standard library path has no dot in its first element.
export function isGoStdlib(spec: string): boolean {
  return !(spec.split("/")[0] as string).includes(".");
}
