// What the repo's own files say about a file of the change: the project it
// belongs to (the nearest folder, up to the repo root, that holds a
// manifest) and that project's frameworks, read from its dependency lists;
// and, for a file whose name says nothing, what its first bytes say (a shell
// shebang, a Kubernetes object).
//
// Offline and bounded. Nothing in the repo is run, loaded or evaluated: a
// Gemfile or a pyproject.toml is read as text, never as Ruby or TOML code.
// Every read is a regular file inside the repo, never through a link (in the
// file's name or in any folder on the way, even one inside the repo), under
// a size cap, and past a count cap a file counts as unknown. Unknown never
// switches a check off; it only keeps a framework's own scanner (brakeman)
// and its rule switches from running.
//
// Linear time. These files come from the change, so a hostile one must not
// hang the review: every reader below walks a line once, with string
// methods or a single anchored character class, never a pattern whose
// repetitions overlap (two blank runs side by side, a lazy run before a
// blank run) and backtrack on a long line.

import fs from "node:fs";
import path from "node:path";
import { noLinkOnTheWay, readRepoPrefixSync } from "./adapters/read.js";

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
const isManifest = (name: string): boolean => MANIFESTS.has(name) || (name.startsWith("requirements") && name.endsWith(".txt"));

// Limits: folders looked at for a manifest, the size of a manifest read (a
// larger one is not read at all), files read for their first bytes, and
// how many bytes.
const MAX_FOLDERS = 20_000;
export const MAX_MANIFEST_BYTES = 1024 * 1024;
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
      // A folder that is a link, or is reached through one, is not looked in.
      const linked = folder !== "" && (!noLinkOnTheWay(repoDir, `${folder}/x`) || fs.lstatSync(abs).isSymbolicLink());
      const real = fs.realpathSync(abs);
      if (!linked && (real === realRepo || real.startsWith(realRepo + path.sep))) {
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
const SHELLS = new Set(["sh", "bash", "dash", "ksh"]);
const lastPart = (word: string): string => word.slice(word.lastIndexOf("/") + 1);

function isShellScript(text: string): boolean {
  if (!text.startsWith("#!")) return false;
  const end = text.indexOf("\n");
  const words = (end === -1 ? text.slice(2) : text.slice(2, end)).split(/[ \t]+/).filter((w) => w !== "");
  let i = 0;
  if (lastPart(words[0] ?? "") === "env") {
    i = 1;
    while ((words[i] ?? "").startsWith("-")) i += 1;
  }
  return SHELLS.has(lastPart(words[i] ?? ""));
}

// A document with `apiVersion:` and `kind:` at the top level, in any of the
// documents read. Nested keys (indented) and comments do not count.
function isKubernetes(text: string): boolean {
  let api = false;
  let kind = false;
  const hasValue = (line: string, key: string) => line.startsWith(key) && line.slice(key.length).trim() !== "";
  for (const line of text.split("\n")) {
    if (line.startsWith("---")) {
      api = false;
      kind = false;
      continue;
    }
    if (hasValue(line, "apiVersion:")) api = true;
    if (hasValue(line, "kind:")) kind = true;
    if (api && kind) return true;
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

const lines = (text: string): string[] => text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));

// A gem, Python or key name at the start of `text`: one anchored character
// class, so a match is linear in its length.
const NAME = /^[A-Za-z0-9_.-]+/;
const nameAt = (text: string): string | null => NAME.exec(text)?.[0] ?? null;

// `gem "rails", "~> 7.1"`, `gem("rails")`, and `gem(` with the name on a
// later line (blank and comment lines between allowed); the Gemfile is never
// evaluated. One pass: a `gem(` with nothing after it waits for the next line
// that holds code.
function gemfileGems(text: string | null): string[] {
  if (text === null) return [];
  const out: string[] = [];
  const quotedName = (rest: string) => {
    const quote = rest[0];
    if (quote !== '"' && quote !== "'") return;
    const name = nameAt(rest.slice(1));
    if (name !== null && rest[1 + name.length] === quote) out.push(name);
  };
  let waiting = false;
  for (const line of lines(text)) {
    const t = line.trimStart();
    if (waiting) {
      if (t === "" || t.startsWith("#")) continue;
      waiting = false;
      if (t[0] === '"' || t[0] === "'") {
        quotedName(t);
        continue;
      }
    }
    if (!t.startsWith("gem")) continue;
    let rest = t.slice(3);
    if (!(rest.startsWith(" ") || rest.startsWith("\t") || rest.startsWith("("))) continue;
    rest = rest.trimStart();
    const paren = rest.startsWith("(");
    if (paren) rest = rest.slice(1).trimStart();
    if (paren && (rest === "" || rest.startsWith("#"))) waiting = true;
    else quotedName(rest);
  }
  return out;
}

// The gem names of a Gemfile.lock: its specs (four spaces in) and its
// DEPENDENCIES (two spaces in).
function lockfileGems(text: string | null): string[] {
  if (text === null) return [];
  const out: string[] = [];
  for (const line of lines(text)) {
    const indent = line.startsWith("    ") ? 4 : line.startsWith("  ") ? 2 : 0;
    if (indent === 0 || line[indent] === " ") continue;
    const name = nameAt(line.slice(indent));
    if (name === null) continue;
    const next = line[indent + name.length];
    if (next === undefined || next === " " || next === "!" || next === "(") out.push(name);
  }
  return out;
}

// A PEP 508 requirement's name: `Django[argon2] ~= 5.0` is django.
function requirementName(spec: string): string | null {
  const t = spec.trimStart();
  const name = /^[A-Za-z0-9][A-Za-z0-9._-]*/.exec(t)?.[0];
  if (name === undefined) return null;
  let rest = t.slice(name.length).trimStart();
  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    if (close === -1) return null;
    rest = rest.slice(close + 1).trimStart();
  }
  return rest === "" || "<>=!~;@(".includes(rest[0]!) ? pyName(name) : null;
}

// The text of a line before a ` #` comment.
function beforeComment(line: string): string {
  for (let i = 1; i < line.length; i++) {
    if (line[i] === "#" && (line[i - 1] === " " || line[i - 1] === "\t")) return line.slice(0, i);
  }
  return line;
}

function requirementsDeps(text: string | null): string[] {
  if (text === null) return [];
  const out: string[] = [];
  for (const raw of lines(text)) {
    const line = beforeComment(raw).trim();
    if (line === "" || line.startsWith("#") || line.startsWith("-")) continue;
    const name = requirementName(line);
    if (name !== null) out.push(name);
  }
  return out;
}

const BARE_KEY = /[A-Za-z0-9_-]+/y;

// A TOML table header (`[tool.poetry.dependencies]`, `[[x]]`, a comment
// after it allowed): its name, part by part, or null. A quoted part is one
// part with its dots and blanks as they are: `["tool.poetry.dependencies"]`
// is one name, not Poetry's table; `[tool."poetry".dependencies]` is three.
// Blanks around the dots do not count. One pass along the line.
function tableHeader(line: string): string[] | null {
  if (!line.startsWith("[")) return null;
  const double = line.startsWith("[[");
  let i = double ? 2 : 1;
  const parts: string[] = [];
  const blanks = () => {
    while (line[i] === " " || line[i] === "\t") i += 1;
  };
  for (;;) {
    blanks();
    const c = line[i];
    if (c === '"') {
      let out = "";
      let j = i + 1;
      while (j < line.length && line[j] !== '"') {
        if (line[j] === "\\") {
          out += line[j + 1] ?? "";
          j += 2;
        } else {
          out += line[j];
          j += 1;
        }
      }
      if (j >= line.length) return null;
      parts.push(out);
      i = j + 1;
    } else if (c === "'") {
      const j = line.indexOf("'", i + 1);
      if (j === -1) return null;
      parts.push(line.slice(i + 1, j));
      i = j + 1;
    } else {
      BARE_KEY.lastIndex = i;
      const m = BARE_KEY.exec(line);
      if (!m) return null;
      parts.push(m[0]);
      i += m[0].length;
    }
    blanks();
    if (line[i] !== ".") break;
    i += 1;
  }
  const close = double ? "]]" : "]";
  if (!line.startsWith(close, i)) return null;
  const after = line.slice(i + close.length).trim();
  if (after !== "" && !after.startsWith("#")) return null;
  return parts;
}

// Whether a table name is exactly these parts.
const tableIs = (table: string[], ...parts: string[]): boolean => table.length === parts.length && parts.every((p, i) => table[i] === p);

// A `key = value` line: the key (quoted or not) and the value after the `=`.
function keyValue(line: string): { key: string; value: string } | null {
  const quote = line[0] === '"' || line[0] === "'" ? line[0] : "";
  const key = nameAt(line.slice(quote.length));
  if (key === null) return null;
  let rest = line.slice(quote.length + key.length);
  if (quote !== "") {
    if (!rest.startsWith(quote)) return null;
    rest = rest.slice(1);
  }
  rest = rest.trimStart();
  return rest.startsWith("=") ? { key, value: rest.slice(1).trimStart() } : null;
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
  let table: string[] = [];
  let inArray = false;
  let depth = { braces: 0 };
  for (const raw of lines(text)) {
    const line = raw.trimStart();
    if (inArray) {
      const part = arrayPart(line, depth);
      add(part.strings);
      inArray = !part.closed;
      continue;
    }
    const header = tableHeader(line);
    if (header !== null) {
      table = header;
      continue;
    }
    const kv = keyValue(line);
    if (kv === null) continue;
    const depsArray =
      (tableIs(table, "project") && kv.key === "dependencies") || tableIs(table, "project", "optional-dependencies") || tableIs(table, "dependency-groups");
    if (depsArray && kv.value.startsWith("[")) {
      depth = { braces: 0 };
      const part = arrayPart(kv.value.slice(1), depth);
      add(part.strings);
      inArray = !part.closed;
      continue;
    }
    // [tool.poetry.dependencies], [tool.poetry.dev-dependencies],
    // [tool.poetry.group.<name>.dependencies]
    if (isPoetryDeps(table) && kv.key !== "python") out.push(pyName(kv.key));
  }
  return out;
}

function isPoetryDeps(table: string[]): boolean {
  if (tableIs(table, "tool", "poetry", "dependencies") || tableIs(table, "tool", "poetry", "dev-dependencies")) return true;
  return table.length === 5 && table[0] === "tool" && table[1] === "poetry" && table[2] === "group" && table[4] === "dependencies";
}

// The quoted strings on one line of a TOML array, and whether the array
// closes on it. A bracket or a # inside a string is part of the string. A
// string inside an inline table, such as `{include-group = "django"}` in
// [dependency-groups], is a reference, not a requirement, and is left out;
// `depth` carries an inline table open across lines.
function arrayPart(line: string, depth = { braces: 0 }): { strings: string[]; closed: boolean } {
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
        if (depth.braces === 0) strings.push(current);
        quote = null;
        current = "";
      } else current += c;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "{") depth.braces += 1;
    else if (c === "}") depth.braces = Math.max(0, depth.braces - 1);
    else if (c === "]" && depth.braces === 0) return { strings, closed: true };
    else if (c === "#") break;
  }
  return { strings, closed: false };
}

// The keys of a Pipfile's [packages] and [dev-packages] tables.
function pipfileDeps(text: string | null): string[] {
  if (text === null) return [];
  const out: string[] = [];
  let table: string[] = [];
  for (const raw of lines(text)) {
    const line = raw.trim();
    const header = tableHeader(line);
    if (header !== null) {
      table = header;
      continue;
    }
    const kv = keyValue(line);
    if (kv && (tableIs(table, "packages") || tableIs(table, "dev-packages"))) out.push(pyName(kv.key));
  }
  return out;
}
