// Where a field of a Kubernetes object sits in its manifest, read as text.
// kube-linter reports an object (kind, name, namespace) and kubeconform an
// object and a field path such as /spec/replicas; neither reports a line. A
// finding is kept only when its line is one the change touched, so each one
// is anchored to the line of the field it is about.
//
// Block-style YAML only, the way manifests are written: each line's key, its
// indentation and its leading `- ` are read once, from the code-only lines of
// comments.ts (yamlCode), so a comment, a quoted value or a block scalar body
// is never read as a key or a document separator. Nothing is evaluated: no
// anchor, alias, tag or merge key is followed. A path that leaves block style
// (a flow mapping such as `{limits: {memory: 1Gi}}`) or names a field the
// object does not have ends at the deepest line found, and says so.
//
// Linear: one pass over the file, and a lookup walks only the lines of the
// node it descends into, stopping at the first line past that node.

import { yamlCode } from "../comments.js";

type Line = {
  // 1-based.
  no: number;
  // Column of the first character that is not a blank; -1 for a line with
  // no code.
  indent: number;
  // Column of the first leading `- ` (a sequence entry starts here), or -1.
  dash: number;
  // Column of the key after the indentation and any leading `- `, or -1.
  keyCol: number;
  key: string | null;
  // The scalar after `key:` on this line, or after the `- ` of an entry
  // with no key, quotes taken off; "" when none.
  value: string;
};

export type KubeDoc = {
  // First and last line of the object, 1-based.
  first: number;
  last: number;
  kind: string | null;
  name: string | null;
  namespace: string | null;
  lines: Line[];
};

// A place in a document: a key's line, a sequence entry's line, or the
// document itself (`at` -1).
type Node = { at: number; col: number; entry: boolean };

const ROOT: Node = { at: -1, col: -1, entry: false };

export function kubeDocuments(text: string): KubeDoc[] {
  const raw = text.split("\n");
  const docs: KubeDoc[] = [];
  let lines: Line[] = [];
  const close = () => {
    const code = lines.filter((l) => l.indent >= 0);
    if (code.length > 0) docs.push(describe(lines, code[0]!.no, code[code.length - 1]!.no));
    lines = [];
  };
  // yamlCode returns one unit per line, in order.
  yamlCode(text).forEach((unit, i) => {
    const code = unit.text;
    if ((code.startsWith("---") || code.startsWith("...")) && (code.length === 3 || code[3] === " " || code[3] === "\t")) {
      close();
      return;
    }
    lines.push(readLine(i + 1, code, (raw[i] ?? "").replace(/\r$/, "")));
  });
  close();
  return docs;
}

function readLine(no: number, code: string, raw: string): Line {
  let j = 0;
  while (code[j] === " " || code[j] === "\t") j++;
  if (j >= code.length || code.slice(j).trim() === "") return { no, indent: -1, dash: -1, keyCol: -1, key: null, value: "" };
  const indent = j;
  let dash = -1;
  while (code[j] === "-" && (j + 1 === code.length || code[j + 1] === " " || code[j + 1] === "\t")) {
    if (dash < 0) dash = j;
    j++;
    while (code[j] === " " || code[j] === "\t") j++;
  }
  const keyCol = j;
  let key: string | null = null;
  let after = -1;
  const q = code[j];
  if (q === '"' || q === "'") {
    const end = code.indexOf(q, j + 1);
    if (end > j) {
      let k = end + 1;
      while (code[k] === " " || code[k] === "\t") k++;
      if (code[k] === ":" && (k + 1 >= code.length || code[k + 1] === " " || code[k + 1] === "\t")) {
        key = code.slice(j + 1, end);
        after = k + 1;
      }
    }
  } else if (q !== undefined && q !== "{" && q !== "[" && q !== "#" && q !== "?") {
    for (let k = j; k < code.length; k++) {
      if (code[k] === ":" && (k + 1 >= code.length || code[k + 1] === " " || code[k + 1] === "\t")) {
        key = code.slice(j, k).trimEnd();
        after = k + 1;
        break;
      }
    }
  }
  // A sequence entry with no key holds a scalar from its `- ` on.
  if (after < 0 && dash >= 0) after = keyCol;
  let value = "";
  if (after >= 0) {
    // The code line has comments and the inside of quoted values blanked,
    // at the same offsets: the value runs to its last character of code.
    let end = code.length;
    while (end > after && (code[end - 1] === " " || code[end - 1] === "\t")) end--;
    value = unquote(raw.slice(after, end).trim());
  }
  return { no, indent, dash, keyCol: key === null ? -1 : keyCol, key, value };
}

function unquote(v: string): string {
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) return v.slice(1, -1);
  return v;
}

function describe(lines: Line[], first: number, last: number): KubeDoc {
  const doc: KubeDoc = { first, last, kind: null, name: null, namespace: null, lines };
  const top = (key: string) => lines.findIndex((l) => l.indent === 0 && l.dash < 0 && l.key === key);
  const kind = top("kind");
  if (kind >= 0) doc.kind = lines[kind]!.value || null;
  const metadata = top("metadata");
  if (metadata >= 0) {
    const node: Node = { at: metadata, col: 0, entry: false };
    const name = childKey(doc, node, "name");
    const namespace = childKey(doc, node, "namespace");
    if (name) doc.name = lines[name.at]!.value || null;
    if (namespace) doc.namespace = lines[namespace.at]!.value || null;
  }
  return doc;
}

// The document a scanner's object names: same kind and name, and the same
// namespace when several match. Null when none does.
export function findDocument(docs: KubeDoc[], object: { kind: string; name: string; namespace: string }): KubeDoc | null {
  const same = docs.filter((d) => d.kind === object.kind && (d.name ?? "") === object.name);
  return same.find((d) => (d.namespace ?? "") === object.namespace) ?? same[0] ?? null;
}

// The next line after `at` that holds code.
function nextCode(doc: KubeDoc, at: number): number {
  for (let i = at + 1; i < doc.lines.length; i++) if (doc.lines[i]!.indent >= 0) return i;
  return -1;
}

// True while line `i` is still inside `node`'s block. A key's block holds
// the lines indented deeper than its key, and an indentless sequence
// (`- ` at the key's own column); an entry's block holds the lines indented
// deeper than its `-`.
function inside(doc: KubeDoc, node: Node, i: number, indentless: boolean): boolean {
  if (node.at < 0) return true;
  const l = doc.lines[i]!;
  if (l.indent < 0) return true;
  if (node.entry) return l.indent > node.col;
  return l.indent > node.col || (indentless && l.indent === node.col && l.dash === node.col);
}

function childKey(doc: KubeDoc, node: Node, name: string): Node | null {
  const lines = doc.lines;
  // An entry's first key sits on the entry's own line.
  if (node.entry) {
    const own = lines[node.at]!;
    if (own.key === name) return { at: node.at, col: own.keyCol, entry: false };
  }
  const level = node.at < 0 ? 0 : node.entry ? lines[node.at]!.keyCol : -1;
  const start = node.at < 0 ? -1 : node.at;
  const first = nextCode(doc, start);
  if (first < 0) return null;
  const want = level >= 0 ? level : lines[first]!.indent;
  // A key whose value is a sequence has no keys of its own.
  if (!node.entry && node.at >= 0 && lines[first]!.dash === lines[first]!.indent) return null;
  for (let i = first; i < lines.length && inside(doc, node, i, false); i++) {
    const l = lines[i]!;
    if (l.indent === want && l.dash < 0 && l.key === name) return { at: i, col: l.keyCol, entry: false };
  }
  return null;
}

// The entries of a key whose value is a block sequence, in order.
function entries(doc: KubeDoc, node: Node): Node[] {
  if (node.at < 0 || node.entry) return [];
  const first = nextCode(doc, node.at);
  if (first < 0) return [];
  const head = doc.lines[first]!;
  if (head.dash < 0 || head.dash !== head.indent || !inside(doc, node, first, true)) return [];
  const out: Node[] = [];
  for (let i = first; i < doc.lines.length && inside(doc, node, i, true); i++) {
    const l = doc.lines[i]!;
    if (l.indent === head.dash && l.dash === head.dash) out.push({ at: i, col: l.dash, entry: true });
  }
  return out;
}

function childEntry(doc: KubeDoc, node: Node, index: number): Node | null {
  return entries(doc, node)[index] ?? null;
}

function walk(doc: KubeDoc, from: Node, path: readonly string[]): { node: Node; found: boolean } {
  let node = from;
  for (const segment of path) {
    const next = /^\d+$/.test(segment) ? (childEntry(doc, node, Number(segment)) ?? childKey(doc, node, segment)) : childKey(doc, node, segment);
    if (next === null) return { node, found: false };
    node = next;
  }
  return { node, found: true };
}

const lineOf = (doc: KubeDoc, node: Node): number => (node.at < 0 ? doc.first : doc.lines[node.at]!.no);

// The line of the field at `path` (keys and sequence indexes), or of its
// nearest ancestor the object has, with whether the field itself was found.
export function pathLine(doc: KubeDoc, path: readonly string[], from: Node = ROOT): { line: number; found: boolean } {
  const { node, found } = walk(doc, from, path);
  return { line: lineOf(doc, node), found };
}

// Where the pod spec of a workload is, by its kind: a Pod's own spec, a
// CronJob's job template, or the pod template every other workload has.
const POD_SPEC_PATHS: readonly (readonly string[])[] = [
  ["spec", "template", "spec"],
  ["spec", "jobTemplate", "spec", "template", "spec"],
];

function podSpec(doc: KubeDoc): Node | null {
  if (doc.kind === "Pod") {
    const spec = walk(doc, ROOT, ["spec"]);
    return spec.found ? spec.node : null;
  }
  for (const path of POD_SPEC_PATHS) {
    const spec = walk(doc, ROOT, path);
    if (spec.found) return spec.node;
  }
  return null;
}

export function podSpecLine(doc: KubeDoc): number | null {
  const node = podSpec(doc);
  return node === null ? null : lineOf(doc, node);
}

const CONTAINER_LISTS = ["containers", "initContainers", "ephemeralContainers"];

function container(doc: KubeDoc, name: string): Node | null {
  const spec = podSpec(doc);
  if (spec === null) return null;
  for (const list of CONTAINER_LISTS) {
    const key = childKey(doc, spec, list);
    if (key === null) continue;
    for (const entry of entries(doc, key)) {
      const named = childKey(doc, entry, "name");
      if (named !== null && doc.lines[named.at]!.value === name) return entry;
    }
  }
  return null;
}

// The line of the container named `name` (its `- ` entry), or null.
export function containerLine(doc: KubeDoc, name: string): number | null {
  const node = container(doc, name);
  return node === null ? null : lineOf(doc, node);
}

// The lines of `node`'s block, its own line first.
function* blockLines(doc: KubeDoc, node: Node): Generator<Line> {
  if (node.at >= 0) yield doc.lines[node.at]!;
  for (let i = node.at + 1; i < doc.lines.length && inside(doc, node, i, true); i++) yield doc.lines[i]!;
}

// A scalar equal to `text`, or a flow sequence (`["*"]`) holding it.
function holds(value: string, text: string): boolean {
  if (value === text) return true;
  if (!value.startsWith("[") || !value.endsWith("]")) return false;
  return value
    .slice(1, -1)
    .split(",")
    .some((item) => unquote(item.trim()) === text);
}

// How a finding is placed in its object: from a base (the object, its pod
// spec, or the container the finding names), the first of `paths` the
// object has; then, when `value` is given, the line in that field's block
// that holds the value the finding names (under `key` when given; the last
// such line with `last`).
export type Anchor = {
  base: "object" | "pod" | "container";
  paths: readonly (readonly string[])[];
  value?: { text: string; key?: string; last?: true };
};

// The line of an anchor in `doc`, and whether the field it names was found.
// A field the object lacks anchors on its nearest ancestor that it has; a
// base it lacks falls back to the one above (container, pod spec, object).
export function anchorLine(doc: KubeDoc, anchor: Anchor, containerName: string | null): { line: number; found: boolean } {
  let from: Node | null = null;
  if (anchor.base === "container" && containerName !== null) from = container(doc, containerName);
  if (from === null && anchor.base !== "object") from = podSpec(doc);
  const base = from ?? ROOT;
  let at: { node: Node; found: boolean } = { node: base, found: anchor.paths.length === 0 };
  for (const [n, path] of anchor.paths.entries()) {
    const tried = walk(doc, base, path);
    if (tried.found || n === 0) at = tried;
    if (tried.found) break;
  }
  if (anchor.value !== undefined && at.found) {
    let hit: Line | null = null;
    // The keys above the current line: an entry with no key of its own
    // (`- "*"` under `verbs:`) belongs to the nearest one at or left of
    // its `-`.
    const keys: Line[] = [];
    for (const l of blockLines(doc, at.node)) {
      if (l.indent < 0) continue;
      const col = l.key !== null ? l.keyCol : l.dash;
      while (keys.length > 0 && (keys[keys.length - 1]!.keyCol > col || (l.key !== null && keys[keys.length - 1]!.keyCol === col))) keys.pop();
      const owner = l.key ?? (l.dash >= 0 ? (keys[keys.length - 1]?.key ?? null) : null);
      if (l.key !== null) keys.push(l);
      if (anchor.value.key !== undefined && owner !== anchor.value.key) continue;
      if (!holds(l.value, anchor.value.text)) continue;
      hit = l;
      if (!anchor.value.last) break;
    }
    if (hit !== null) return { line: hit.no, found: true };
  }
  return { line: lineOf(doc, at.node), found: at.found };
}
