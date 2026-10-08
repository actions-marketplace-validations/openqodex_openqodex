// What the repo's own files say about a file of the change: the project it
// belongs to (the nearest folder, up to the repo root, that holds a
// manifest) and that project's frameworks, read from its dependency lists;
// and, for a file whose name says nothing, what its first bytes say (a shell
// shebang, a Kubernetes object).
//
// Offline and bounded. Nothing in the repo is run, loaded or evaluated: a
// Gemfile or a pyproject.toml is read as text, never as Ruby or TOML code.
// Every read is a regular file inside the repo, never through a link, under
// a size cap, and past a count cap a file counts as unknown. Unknown never
// switches a check off; it only keeps a framework's own scanner (brakeman)
// and its rule switches from running.

import fs from "node:fs";
import path from "node:path";
import { readRepoPrefixSync } from "./adapters/read.js";

export type Framework = "rails" | "react" | "react-native" | "nextjs" | "django" | "fastapi" | "airflow";

export type Project = {
  // The project's folder, repo-relative with forward slashes; "" is the repo root.
  root: string;
  // Sorted by name.
  frameworks: Framework[];
  // The file and the dependency or marker behind each framework.
  evidence: Partial<Record<Framework, string>>;
};

// A file whose name does not say what it is: an extensionless script with an
// sh, bash, dash or ksh shebang (the shells shellcheck reads), or YAML with a
// top-level apiVersion and kind (a Kubernetes object).
export type ContentKind = "shell" | "kubernetes";

export type RepoFacts = {
  // The nearest project holding this repo-relative path, or null.
  project(rel: string): Project | null;
  content(rel: string): ContentKind | null;
};

// The names that make a folder a project root.
const MANIFESTS = new Set([
  "package.json",
  "Gemfile",
  "Gemfile.lock",
  "pyproject.toml",
  "Pipfile",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
]);
const isManifest = (name: string): boolean => MANIFESTS.has(name) || /^requirements[^/]*\.txt$/.test(name);

// Limits: folders looked at for a manifest, the size of a manifest read,
// files read for their first bytes, and how many bytes.
const MAX_FOLDERS = 20_000;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_CONTENT_READS = 5_000;
const SHEBANG_BYTES = 256;
const YAML_BYTES = 64 * 1024;

// Python names compare in their normalized form (PEP 503).
const pyName = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, "-");

export function repoFacts(repoDir: string): RepoFacts {
  let realRepo: string;
  try {
    realRepo = fs.realpathSync(repoDir);
  } catch {
    realRepo = repoDir;
  }
  // folder -> the manifest names in it (null: none, or not looked at).
  const folders = new Map<string, string[] | null>();
  const projects = new Map<string, Project>();
  const contents = new Map<string, ContentKind | null>();
  let contentReads = 0;

  const read = (rel: string, max: number, whole: boolean): string | null =>
    readRepoPrefixSync(realRepo, repoDir, rel, max, whole)?.toString("utf8") ?? null;

  // The manifests in one folder: regular files only, so a link is never one.
  function manifestsIn(folder: string): string[] | null {
    if (folders.has(folder)) return folders.get(folder)!;
    if (folders.size >= MAX_FOLDERS) return null;
    let found: string[] | null = null;
    try {
      const abs = path.join(repoDir, folder);
      // A folder reached through a link out of the repo is not the repo's.
      const real = fs.realpathSync(abs);
      if (real === realRepo || real.startsWith(realRepo + path.sep)) {
        const names = fs
          .readdirSync(abs, { withFileTypes: true })
          .filter((e) => e.isFile() && isManifest(e.name))
          .map((e) => e.name)
          .sort();
        found = names.length > 0 ? names : null;
      }
    } catch {
      // gone or unreadable: no manifest here
    }
    folders.set(folder, found);
    return found;
  }

  function projectAt(root: string, names: string[]): Project {
    let project = projects.get(root);
    if (project) return project;
    const join = (name: string) => (root === "" ? name : `${root}/${name}`);
    const evidence: Partial<Record<Framework, string>> = {};

    const js = new Set<string>();
    if (names.includes("package.json")) {
      for (const dep of packageJsonDeps(read(join("package.json"), MAX_MANIFEST_BYTES, true))) js.add(dep);
    }
    if (js.has("react")) evidence.react = "react in package.json";
    if (js.has("react-native") || js.has("expo")) evidence["react-native"] = `${js.has("expo") ? "expo" : "react-native"} in package.json`;
    if (js.has("next")) evidence.nextjs = "next in package.json";

    const gems = new Map<string, string>();
    for (const file of ["Gemfile", "Gemfile.lock"]) {
      if (!names.includes(file)) continue;
      const text = read(join(file), MAX_MANIFEST_BYTES, true);
      for (const gem of file === "Gemfile" ? gemfileGems(text) : lockfileGems(text)) if (!gems.has(gem)) gems.set(gem, file);
    }
    const railsGem = gems.has("rails") ? "rails" : gems.has("railties") ? "railties" : null;
    if (railsGem !== null) {
      // A Rails dependency is not enough: the app itself must be here.
      const marker = ["config/application.rb", "bin/rails"].find((m) => read(join(m), 1, false) !== null);
      if (marker !== undefined) evidence.rails = `${railsGem} in ${gems.get(railsGem)}, ${marker}`;
    }

    const py = new Map<string, string>();
    for (const name of names) {
      let deps: string[] = [];
      if (name === "pyproject.toml") deps = pyprojectDeps(read(join(name), MAX_MANIFEST_BYTES, true));
      else if (name === "Pipfile") deps = pipfileDeps(read(join(name), MAX_MANIFEST_BYTES, true));
      else if (name.startsWith("requirements")) deps = requirementsDeps(read(join(name), MAX_MANIFEST_BYTES, true));
      for (const dep of deps) if (!py.has(dep)) py.set(dep, name);
    }
    for (const [framework, dep] of [["django", "django"], ["fastapi", "fastapi"], ["airflow", "apache-airflow"]] as const) {
      if (py.has(dep)) evidence[framework] = `${dep} in ${py.get(dep)}`;
    }

    project = { root, frameworks: (Object.keys(evidence) as Framework[]).sort(), evidence };
    projects.set(root, project);
    return project;
  }

  return {
    project(rel) {
      const parts = path.posix.normalize(rel.split(path.sep).join("/")).split("/");
      if (parts[0] === ".." || parts[0] === "") return null;
      for (let n = parts.length - 1; n >= 0; n--) {
        const folder = parts.slice(0, n).join("/");
        const names = manifestsIn(folder);
        if (names !== null) return projectAt(folder, names);
      }
      return null;
    },
    content(rel) {
      if (contents.has(rel)) return contents.get(rel)!;
      const base = path.posix.basename(rel);
      const ext = path.posix.extname(base).toLowerCase();
      let kind: ContentKind | null = null;
      const yaml = ext === ".yaml" || ext === ".yml";
      if ((ext === "" || yaml) && contentReads < MAX_CONTENT_READS) {
        contentReads += 1;
        const text = read(rel, yaml ? YAML_BYTES : SHEBANG_BYTES, false);
        if (text !== null) kind = yaml ? (isKubernetes(text) ? "kubernetes" : null) : isShellScript(text) ? "shell" : null;
      }
      contents.set(rel, kind);
      return kind;
    },
  };
}

// `#!/bin/sh`, `#!/usr/bin/env bash`, `#!/usr/bin/env -S bash -e`: the shells
// shellcheck checks. zsh and fish are not among them.
function isShellScript(text: string): boolean {
  return /^#!\s*(?:\S*\/env\s+(?:-S\s+)?)?(?:\S*\/)?(?:sh|bash|dash|ksh)(?:\s|$)/.test(text);
}

// A document with `apiVersion:` and `kind:` at the top level, in any of the
// documents read. Nested keys (indented) and comments do not count.
function isKubernetes(text: string): boolean {
  for (const doc of text.split(/^---.*$/m)) {
    if (/^apiVersion:\s*\S/m.test(doc) && /^kind:\s*\S/m.test(doc)) return true;
  }
  return false;
}

function packageJsonDeps(text: string | null): string[] {
  if (text === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const out: string[] = [];
  for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const deps = (parsed as Record<string, unknown>)[key];
    if (deps && typeof deps === "object" && !Array.isArray(deps)) out.push(...Object.keys(deps));
  }
  return out;
}

// `gem "rails", "~> 7.1"` lines; the Gemfile is never evaluated.
function gemfileGems(text: string | null): string[] {
  if (text === null) return [];
  return [...text.matchAll(/^\s*gem\s*\(?\s*["']([A-Za-z0-9_.-]+)["']/gm)].map((m) => m[1]!);
}

// The gem names of a Gemfile.lock: its specs and its DEPENDENCIES.
function lockfileGems(text: string | null): string[] {
  if (text === null) return [];
  return [...text.matchAll(/^ {2}(?: {2})?([A-Za-z0-9_.-]+)(?:[ !(]|$)/gm)].map((m) => m[1]!);
}

// A PEP 508 requirement's name: `Django[argon2] ~= 5.0` is django.
function requirementName(spec: string): string | null {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(?:[<>=!~;@(]|$)/.exec(spec);
  return m ? pyName(m[1]!) : null;
}

function requirementsDeps(text: string | null): string[] {
  if (text === null) return [];
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (line === "" || line.startsWith("#") || line.startsWith("-")) continue;
    const name = requirementName(line);
    if (name !== null) out.push(name);
  }
  return out;
}

// The quoted strings of a `dependencies = [...]` array (PEP 621, its
// optional groups, PEP 735 groups) and the keys of a poetry dependencies
// table. Any other table or key, a description or an isort list, is not a
// dependency. Read line by line; nothing is evaluated.
function pyprojectDeps(text: string | null): string[] {
  if (text === null) return [];
  const out: string[] = [];
  const add = (strings: string[]) => {
    for (const s of strings) {
      const name = requirementName(s);
      if (name !== null) out.push(name);
    }
  };
  let table = "";
  let inArray = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s+/, "");
    if (inArray) {
      const part = arrayPart(line);
      add(part.strings);
      inArray = !part.closed;
      continue;
    }
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
    if (header) {
      table = header[1]!.replace(/["'\s]/g, "");
      continue;
    }
    const key = /^["']?([A-Za-z0-9_.-]+)["']?\s*=\s*(.*)$/.exec(line);
    if (!key) continue;
    const name = key[1]!;
    const value = key[2]!;
    const depsArray =
      (table === "project" && name === "dependencies") || table === "project.optional-dependencies" || table === "dependency-groups";
    if (depsArray && value.startsWith("[")) {
      const part = arrayPart(value.slice(1));
      add(part.strings);
      inArray = !part.closed;
      continue;
    }
    // [tool.poetry.dependencies], [tool.poetry.dev-dependencies],
    // [tool.poetry.group.<name>.dependencies]
    if (/^tool\.poetry(?:\.group\.[^.]+)?\.(?:dev-)?dependencies$/.test(table) && name !== "python") out.push(pyName(name));
  }
  return out;
}

// The quoted strings on one line of a TOML array, and whether the array
// closes on it. A bracket or a # inside a string is part of the string.
function arrayPart(line: string): { strings: string[]; closed: boolean } {
  const strings: string[] = [];
  let quote: string | null = null;
  let current = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote !== null) {
      if (c === "\\" && quote === '"') {
        current += line[i + 1] ?? "";
        i += 1;
      } else if (c === quote) {
        strings.push(current);
        quote = null;
        current = "";
      } else current += c;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "]") return { strings, closed: true };
    else if (c === "#") break;
  }
  return { strings, closed: false };
}

// The keys of a Pipfile's [packages] and [dev-packages] tables.
function pipfileDeps(text: string | null): string[] {
  if (text === null) return [];
  const out: string[] = [];
  let table = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[([^\]]+)\]/.exec(line);
    if (header) {
      table = header[1]!.trim();
      continue;
    }
    const key = /^["']?([A-Za-z0-9_.-]+)["']?\s*=/.exec(line);
    if (key && (table === "packages" || table === "dev-packages")) out.push(pyName(key[1]!));
  }
  return out;
}
