// Readers of the repository's own manifests, lockfiles and tsconfig files.
// They come from the change (a branch, a pull request), so a crafted file
// must not hang the graph: every reader walks the text once, line by line,
// with string methods or a single anchored character class, never a pattern
// whose repetitions overlap (two blank runs side by side, a lazy run before
// a blank run, a repeated group that can split one line two ways). Nothing
// is evaluated: a Gemfile or a pyproject.toml is read as text.
//
// The scanner package reads the same kind of files for its framework
// detection (packages/scanners/src/detect.ts on the audit-t2 branch) with
// the same approach; the Python and Ruby readers here follow it.

// The most bytes read of one manifest or tsconfig (package.json,
// tsconfig.json, jsconfig.json, pnpm-workspace.yaml, pyproject.toml,
// setup.cfg, requirements*.txt, go.mod, Gemfile). A larger file is not read.
export const MANIFEST_BYTES = 1024 * 1024;
// The most bytes read of one lockfile (pnpm-lock.yaml, package-lock.json,
// yarn.lock), which grow with the dependency tree. A larger one is not read.
export const LOCKFILE_BYTES = 16 * 1024 * 1024;

export type Linkage = "workspace" | "published" | "unknown";

const lines = (text: string): string[] => text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));

// A name at the start of `text`: one anchored character class, linear.
const NAME = /^[A-Za-z0-9_.@/-]+/;
const nameAt = (text: string): string | null => NAME.exec(text)?.[0] ?? null;

const unquote = (s: string): string => {
  const t = s.trim();
  return t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0] ? t.slice(1, -1) : t;
};

// The text of a line before a ` #` comment (YAML, TOML, requirements).
export function beforeComment(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "#" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) return line.slice(0, i);
  }
  return line;
}

// JSON with comments and trailing commas, as tsconfig.json is written. One
// pass: comments are skipped and a comma followed (past blanks and
// comments) by `}` or `]` is dropped, never inside a string.
export function parseJsonc(text: string): unknown {
  const out: string[] = [];
  let pendingComma = -1; // index in `out` of a comma whose fate is not known yet
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (c === '"') {
      pendingComma = -1;
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out.push(text.slice(i, j + 1));
      i = j;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end - 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      out.push(c);
      continue;
    }
    if ((c === "}" || c === "]") && pendingComma !== -1) out[pendingComma] = "";
    pendingComma = -1;
    if (c === ",") pendingComma = out.length;
    out.push(c);
  }
  return JSON.parse(out.join(""));
}

// The `packages:` list of pnpm-workspace.yaml: a block list or a flow list.
export function pnpmPackages(text: string): string[] {
  const all = lines(text);
  for (let i = 0; i < all.length; i++) {
    const line = all[i] as string;
    if (!line.startsWith("packages")) continue;
    const rest = line.slice("packages".length).trimStart();
    if (!rest.startsWith(":")) continue;
    const value = beforeComment(rest.slice(1)).trim();
    if (value.startsWith("[")) {
      const close = value.lastIndexOf("]");
      return value
        .slice(1, close === -1 ? value.length : close)
        .split(",")
        .map(unquote)
        .filter((p) => p !== "");
    }
    const out: string[] = [];
    for (let j = i + 1; j < all.length; j++) {
      const item = all[j] as string;
      const t = item.trim();
      if (t === "" || t.startsWith("#")) continue;
      if (!(item.startsWith(" ") || item.startsWith("\t")) || !t.startsWith("-")) break;
      const entry = unquote(beforeComment(t.slice(1)));
      if (entry !== "") out.push(entry);
    }
    return out;
  }
  return [];
}

const indentOf = (line: string): number => {
  let n = 0;
  while (n < line.length && line[n] === " ") n++;
  return n;
};

// `key:` or `key: value` of one YAML line after its indent; the key may be quoted.
function yamlKey(rest: string): { key: string; value: string } | null {
  let key: string;
  let after: string;
  if (rest[0] === '"' || rest[0] === "'") {
    const end = rest.indexOf(rest[0], 1);
    if (end === -1) return null;
    key = rest.slice(1, end);
    after = rest.slice(end + 1);
  } else {
    // A plain key ends at the first `: ` or a final `:`.
    let end = -1;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === ":" && (i === rest.length - 1 || rest[i + 1] === " ")) {
        end = i;
        break;
      }
    }
    if (end === -1) return null;
    key = rest.slice(0, end);
    after = rest.slice(end);
  }
  if (!after.startsWith(":")) return null;
  return { key, value: beforeComment(after.slice(1)).trim() };
}

const linkKind = (value: string): Linkage => {
  const v = unquote(value);
  return v.startsWith("link:") || v.startsWith("workspace:") || v.startsWith("file:") ? "workspace" : v[0] !== undefined && v[0] >= "0" && v[0] <= "9" ? "published" : "unknown";
};

// pnpm-lock.yaml importers: for each importer folder, each dependency and
// whether the lockfile resolved it to a workspace link or a published version.
export function pnpmLinks(text: string): Map<string, Map<string, Linkage>> {
  const out = new Map<string, Map<string, Linkage>>();
  let inImporters = false;
  let importer: Map<string, Linkage> | null = null;
  let dep: string | null = null;
  for (const line of lines(text)) {
    if (line.trim() === "") continue;
    const indent = indentOf(line);
    if (indent === 0) {
      inImporters = line.startsWith("importers:");
      importer = null;
      continue;
    }
    if (!inImporters) continue;
    const kv = yamlKey(line.slice(indent));
    if (kv === null) continue;
    if (indent === 2) {
      importer = new Map();
      out.set(kv.key === "." ? "" : kv.key, importer);
      dep = null;
    } else if (indent === 6 && importer) {
      if (kv.value === "") dep = kv.key; // v6 and later: the version follows
      else importer.set(kv.key, linkKind(kv.value)); // v5: name: version
    } else if (indent === 8 && importer && dep !== null && kv.key === "version") importer.set(dep, linkKind(kv.value));
  }
  return out;
}

// yarn.lock: names resolved to a workspace, and names resolved from a registry.
export function yarnLock(text: string): { workspace: Set<string>; published: Set<string> } {
  const workspace = new Set<string>();
  const published = new Set<string>();
  let names: string[] = [];
  const nameOf = (entry: string) => {
    const at = entry.lastIndexOf("@");
    return at > 0 ? { name: entry.slice(0, at), range: entry.slice(at + 1) } : null;
  };
  for (const line of lines(text)) {
    if (line === "" || line.startsWith("#")) continue;
    if (line[0] !== " " && line.endsWith(":")) {
      names = line
        .slice(0, -1)
        .split(",")
        .map((k) => unquote(k));
      for (const k of names) {
        const n = nameOf(k);
        if (n && n.range.startsWith("workspace:")) workspace.add(n.name);
      }
      continue;
    }
    const t = line.trim();
    const key = t.startsWith("resolved") ? "resolved" : t.startsWith("resolution") ? "resolution" : null;
    if (key === null) continue;
    let value = t.slice(key.length);
    if (value.startsWith(":")) value = value.slice(1);
    value = unquote(value.trim());
    if (value.startsWith("http:") || value.startsWith("https:") || value.includes("@npm:") || value.startsWith("npm:")) {
      for (const k of names) {
        const n = nameOf(k);
        if (n) published.add(n.name);
      }
    }
  }
  return { workspace, published };
}

// A distribution or import name as pip compares them.
export function normalisePy(name: string): string {
  let out = "";
  let run = false;
  for (const c of name.toLowerCase()) {
    const sep = c === "-" || c === "_" || c === ".";
    if (sep) {
      if (!run) out += "_";
      run = true;
    } else {
      out += c;
      run = false;
    }
  }
  return out;
}

// A PEP 508 requirement's name: `Django[argon2] ~= 5.0` is django.
export function requirementName(spec: string): string | null {
  const t = spec.trimStart();
  const name = /^[A-Za-z0-9][A-Za-z0-9._-]*/.exec(t)?.[0];
  if (name === undefined) return null;
  let rest = t.slice(name.length).trimStart();
  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    if (close === -1) return null;
    rest = rest.slice(close + 1).trimStart();
  }
  return rest === "" || "<>=!~;@(,".includes(rest[0] as string) ? normalisePy(name) : null;
}

export function requirementsDeps(text: string): string[] {
  const out: string[] = [];
  for (const raw of lines(text)) {
    const line = beforeComment(raw).trim();
    if (line === "" || line.startsWith("-")) continue;
    const name = requirementName(line);
    if (name !== null) out.push(name);
  }
  return out;
}

const BARE_KEY = /[A-Za-z0-9_-]+/y;

// A TOML table header, part by part, or null. One pass along the line.
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
    if (c === '"' || c === "'") {
      const j = line.indexOf(c, i + 1);
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
  return after === "" || after.startsWith("#") ? parts : null;
}

const tableIs = (table: string[], ...parts: string[]): boolean => table.length === parts.length && parts.every((p, i) => table[i] === p);

// A `key = value` line: the key (quoted or not) and the value after the `=`.
function keyValue(line: string): { key: string; value: string } | null {
  const quote = line[0] === '"' || line[0] === "'" ? line[0] : "";
  const key = /^[A-Za-z0-9_.-]+/.exec(line.slice(quote.length))?.[0];
  if (key === undefined) return null;
  let rest = line.slice(quote.length + key.length);
  if (quote !== "") {
    if (!rest.startsWith(quote)) return null;
    rest = rest.slice(1);
  }
  rest = rest.trimStart();
  return rest.startsWith("=") ? { key, value: rest.slice(1).trimStart() } : null;
}

// The quoted strings on one line of a TOML array, and whether it closes there.
function arrayPart(line: string, depth: { braces: number }): { strings: string[]; closed: boolean } {
  const strings: string[] = [];
  let quote: string | null = null;
  let current = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
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

// The dependency names of a pyproject.toml: PEP 621 `dependencies` and
// optional groups, PEP 735 groups, and Poetry's dependency tables.
export function pyprojectDeps(text: string): string[] {
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
    const depsArray = (tableIs(table, "project") && kv.key === "dependencies") || tableIs(table, "project", "optional-dependencies") || tableIs(table, "dependency-groups");
    if (depsArray && kv.value.startsWith("[")) {
      depth = { braces: 0 };
      const part = arrayPart(kv.value.slice(1), depth);
      add(part.strings);
      inArray = !part.closed;
      continue;
    }
    const poetry =
      tableIs(table, "tool", "poetry", "dependencies") ||
      tableIs(table, "tool", "poetry", "dev-dependencies") ||
      (table.length === 5 && table[0] === "tool" && table[1] === "poetry" && table[2] === "group" && table[4] === "dependencies");
    if (poetry && kv.key !== "python") out.push(normalisePy(kv.key));
  }
  return out;
}

// setup.cfg `[options] install_requires`: on the key's line or on the
// indented lines after it.
export function setupCfgRequires(text: string): string[] {
  const out: string[] = [];
  let section = "";
  let inList = false;
  const take = (value: string) => {
    for (const part of value.split(";")[0]?.split(",") ?? []) {
      const name = requirementName(part);
      if (name !== null) out.push(name);
    }
  };
  for (const raw of lines(text)) {
    const indented = raw.startsWith(" ") || raw.startsWith("\t");
    const line = beforeComment(raw).trim();
    if (inList) {
      if (indented && line !== "") {
        take(line);
        continue;
      }
      if (indented) continue;
      inList = false;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1).trim();
      continue;
    }
    if (section !== "options" || !line.startsWith("install_requires")) continue;
    const rest = line.slice("install_requires".length).trimStart();
    if (!rest.startsWith("=")) continue;
    const value = rest.slice(1).trim();
    if (value !== "") take(value);
    inList = true;
  }
  return out;
}

// The words of a line split on blanks, without a regular expression.
function words(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const c of line) {
    if (c === " " || c === "\t") {
      if (cur !== "") out.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur !== "") out.push(cur);
  return out;
}

// go.mod's module path.
export function goModule(text: string): string | null {
  for (const raw of lines(text)) {
    const w = words(beforeSlashes(raw));
    if (w[0] === "module" && w[1] !== undefined) return unquote(w[1]);
  }
  return null;
}

const beforeSlashes = (line: string): string => {
  const at = line.indexOf("//");
  return at === -1 ? line : line.slice(0, at);
};

// go.mod's required module paths, in a `require ( ... )` block or on one line.
export function goModRequires(text: string): string[] {
  const out: string[] = [];
  let block = false;
  for (const raw of lines(text)) {
    const w = words(beforeSlashes(raw));
    if (block) {
      if (w[0] === ")") block = false;
      else if (w.length >= 2 && w[0] !== undefined) out.push(unquote(w[0]));
      continue;
    }
    if (w[0] !== "require") continue;
    if (w[1] === "(") block = true;
    else if (w[1] !== undefined && w[2] !== undefined) out.push(unquote(w[1]));
  }
  return out;
}

// `gem "rails", "~> 7.1"` and `gem("rails")`; the Gemfile is never evaluated.
export function gemfileGems(text: string): string[] {
  const out: string[] = [];
  for (const raw of lines(text)) {
    const t = raw.trimStart();
    if (!t.startsWith("gem")) continue;
    let rest = t.slice(3);
    if (!(rest.startsWith(" ") || rest.startsWith("\t") || rest.startsWith("("))) continue;
    rest = rest.trimStart();
    if (rest.startsWith("(")) rest = rest.slice(1).trimStart();
    const quote = rest[0];
    if (quote !== '"' && quote !== "'") continue;
    const name = nameAt(rest.slice(1));
    if (name !== null && rest[1 + name.length] === quote) out.push(name);
  }
  return out;
}
