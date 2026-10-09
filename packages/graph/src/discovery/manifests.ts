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
// comments) by `}` or `]` is dropped, never inside a string. A text of
// only blanks and comments is an empty object, as TypeScript reads an
// empty tsconfig.json.
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
  const json = out.join("");
  return json.trim() === "" ? {} : JSON.parse(json);
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
  // The package names of the entry being read, each `name@range` of its
  // header cut to the name. One pass over the header, one string per name:
  // a header of two hundred thousand entries listed whole, then each cut in
  // two, cost eight times as much per byte at 1 MiB as at 256 KiB.
  let names: string[] = [];
  for (const line of lines(text)) {
    if (line === "" || line.startsWith("#")) continue;
    if (line[0] !== " " && line.endsWith(":")) {
      names = [];
      const header = line.slice(0, -1);
      for (let start = 0; start <= header.length; ) {
        let end = header.indexOf(",", start);
        if (end === -1) end = header.length;
        const entry = unquote(header.slice(start, end));
        const at = entry.lastIndexOf("@");
        if (at > 0) {
          const name = entry.slice(0, at);
          names.push(name);
          if (entry.startsWith("workspace:", at + 1)) workspace.add(name);
        }
        start = end + 1;
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
      for (const name of names) published.add(name);
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

// The files a requirements file includes, as pip reads them: `-r file`,
// `-c file`, `--requirement file` and `--constraint file`, with a space or
// `=` (long flags) or nothing (short flags) before the path. The path is as
// written; the caller resolves it against the including file's folder.
export function requirementsIncludes(text: string): string[] {
  const out: string[] = [];
  for (const raw of lines(text)) {
    const line = beforeComment(raw).trim();
    for (const flag of ["--requirement", "--constraint", "-r", "-c"]) {
      if (!line.startsWith(flag)) continue;
      let rest = line.slice(flag.length);
      if (flag.startsWith("--")) {
        if (rest.startsWith("=")) rest = rest.slice(1);
        else if (!rest.startsWith(" ") && !rest.startsWith("\t")) break;
      }
      const spec = rest.trim();
      if (spec !== "") out.push(spec);
      break;
    }
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
// The first `max` words of a line, split at spaces and tabs: one pass that
// cuts each word out by its ends and stops at the last one asked for. A word
// built a character at a time cost eight times as much per byte at 1 MiB as
// at 256 KiB, the garbage collector moving the growing string, and a line of
// half a million words was listed whole to read its first three.
function words(line: string, max: number): string[] {
  const out: string[] = [];
  let start = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 32 || c === 9) {
      if (start !== -1) {
        out.push(line.slice(start, i));
        if (out.length === max) return out;
      }
      start = -1;
    } else if (start === -1) start = i;
  }
  if (start !== -1) out.push(line.slice(start));
  return out;
}

// Each line of `text` without its line break (and a `\r` before it), in
// order, as `lines` gives them, in one pass that holds no array of lines;
// `each` returns false to stop.
function eachLine(text: string, each: (line: string) => boolean | void): void {
  for (let start = 0; start <= text.length; ) {
    let end = text.indexOf("\n", start);
    if (end === -1) end = text.length;
    const line = text.charCodeAt(end - 1) === 13 && end > start ? text.slice(start, end - 1) : text.slice(start, end);
    if (each(line) === false) return;
    start = end + 1;
  }
}

// go.mod's module path.
export function goModule(text: string): string | null {
  let found: string | null = null;
  eachLine(text, (raw) => {
    const w = words(beforeSlashes(raw), 2);
    if (w[0] !== "module" || w[1] === undefined) return true;
    found = unquote(w[1]);
    return false;
  });
  return found;
}

const beforeSlashes = (line: string): string => {
  const at = line.indexOf("//");
  return at === -1 ? line : line.slice(0, at);
};

// go.mod's required module paths, in a `require ( ... )` block or on one line.
export function goModRequires(text: string): string[] {
  const out: string[] = [];
  let block = false;
  eachLine(text, (raw) => {
    // Three words decide a line: `require path version` or `path version`.
    const w = words(beforeSlashes(raw), 3);
    if (block) {
      if (w[0] === ")") block = false;
      else if (w.length >= 2 && w[0] !== undefined) out.push(unquote(w[0]));
      return;
    }
    if (w[0] !== "require") return;
    if (w[1] === "(") block = true;
    else if (w[1] !== undefined && w[2] !== undefined) out.push(unquote(w[1]));
  });
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
