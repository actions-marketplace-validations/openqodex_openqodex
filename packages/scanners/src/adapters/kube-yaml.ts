// Where a field of a Kubernetes object sits in its manifest. kube-linter
// reports an object (kind, name, namespace) and kubeconform an object and a
// field path such as /spec/replicas; neither reports a line. A finding is
// kept only when its line is one the change touched, so each one is anchored
// to the line of the field it is about.
//
// The manifest is read by a YAML parser (the `yaml` library: it builds a
// syntax tree and runs nothing), the way both scanners decode it, so block
// and flow style, quoted keys with escapes, and JSON manifests all resolve.
// A comment or a block scalar body is never read as a key or a document
// separator. An alias is not followed: a path that reaches one ends on the
// alias's line, where the change may have added it. A path that names a
// field the object does not have ends at the deepest field found, and says
// so. A file nested past what the parser can hold keeps the part it read.
//
// A lookup walks only the keys along its path; the value search walks only
// the field it searches.

import { isMap, isScalar, isSeq, parseAllDocuments } from "yaml";

export type KubeDoc = {
  // First line of the object, 1-based.
  first: number;
  // The document's text in its file, `---` marker included: [from, to).
  from: number;
  to: number;
  kind: string | null;
  name: string | null;
  namespace: string | null;
  // The object's root node, and the line of an offset in its file.
  root: unknown;
  lineAt: (offset: number) => number;
};

// A place in a document: a field's value node, the line of the field (its
// key, or a sequence entry's start), and the key that owns it (an entry
// belongs to the key of its sequence).
type Place = { node: unknown; line: number; owner: string | null };

const OPTIONS = { prettyErrors: false, uniqueKeys: false, strict: false } as const;

// The text of a scalar as written, after quotes and escapes; null for
// anything else and for an empty value.
function text(node: unknown): string | null {
  if (!isScalar(node) || node.value === null) return null;
  return typeof node.source === "string" ? node.source : String(node.value);
}

function startOf(node: unknown): number | null {
  const range = (node as { range?: [number, number, number] } | null)?.range;
  return range ? range[0] : null;
}

export function kubeDocuments(source: string): KubeDoc[] {
  const starts = [0];
  for (let i = source.indexOf("\n"); i >= 0; i = source.indexOf("\n", i + 1)) starts.push(i + 1);
  const lineAt = (offset: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  let parsed: ReturnType<typeof parseAllDocuments>;
  try {
    parsed = parseAllDocuments(source, OPTIONS);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const docs: KubeDoc[] = [];
  for (const doc of parsed) {
    const root = doc.contents;
    const at = startOf(root);
    // An empty document (after a closing `---`) holds a null scalar.
    if (root === null || at === null || (isScalar(root) && root.value === null)) continue;
    const range = (doc as { range?: [number, number, number] }).range;
    const kube: KubeDoc = { first: lineAt(at), from: range ? range[0] : at, to: range ? range[2] : source.length, kind: null, name: null, namespace: null, root, lineAt };
    kube.kind = text(field(kube, rootPlace(kube), "kind")?.node);
    const metadata = field(kube, rootPlace(kube), "metadata");
    if (metadata) {
      kube.name = text(field(kube, metadata, "name")?.node);
      kube.namespace = text(field(kube, metadata, "namespace")?.node);
    }
    docs.push(kube);
  }
  return docs;
}

const rootPlace = (doc: KubeDoc): Place => ({ node: doc.root, line: doc.first, owner: null });

// The document a scanner's object names: same kind and name, and the same
// namespace when several match. Null when none does.
export function findDocument(docs: KubeDoc[], object: { kind: string; name: string; namespace: string }): KubeDoc | null {
  const same = docs.filter((d) => d.kind === object.kind && (d.name ?? "") === object.name);
  return same.find((d) => (d.namespace ?? "") === object.namespace) ?? same[0] ?? null;
}

// The key `name` of a mapping, on the line of its key.
function field(doc: KubeDoc, place: Place, name: string): Place | null {
  if (!isMap(place.node)) return null;
  for (const pair of place.node.items) {
    if (!isScalar(pair.key) || String(pair.key.value) !== name) continue;
    const at = startOf(pair.key);
    return { node: pair.value, line: at === null ? place.line : doc.lineAt(at), owner: name };
  }
  return null;
}

// Entry `index` of a sequence, on the line it starts.
function entry(doc: KubeDoc, place: Place, index: number): Place | null {
  if (!isSeq(place.node)) return null;
  const item = place.node.items[index];
  if (item === undefined) return null;
  const at = startOf(item);
  return { node: item, line: at === null ? place.line : doc.lineAt(at), owner: place.owner };
}

function entries(doc: KubeDoc, place: Place): Place[] {
  if (!isSeq(place.node)) return [];
  return place.node.items.map((_, i) => entry(doc, place, i)!);
}

function walk(doc: KubeDoc, from: Place, path: readonly string[]): { place: Place; found: boolean } {
  let place = from;
  for (const segment of path) {
    // An alias is neither a mapping nor a sequence, so a path ends on it.
    const next = (/^\d+$/.test(segment) ? entry(doc, place, Number(segment)) : null) ?? field(doc, place, segment);
    if (next === null) return { place, found: false };
    place = next;
  }
  return { place, found: true };
}

// The line of the field at `path` (keys and sequence indexes), or of its
// nearest ancestor the object has, with whether the field itself was found.
export function pathLine(doc: KubeDoc, path: readonly string[]): { line: number; found: boolean } {
  const { place, found } = walk(doc, rootPlace(doc), path);
  return { line: place.line, found };
}

// Where the pod spec of a workload is, by its kind: a Pod's own spec, a
// CronJob's job template, or the pod template every other workload has.
const POD_SPEC_PATHS: readonly (readonly string[])[] = [
  ["spec", "template", "spec"],
  ["spec", "jobTemplate", "spec", "template", "spec"],
];

function podSpec(doc: KubeDoc): Place | null {
  if (doc.kind === "Pod") {
    const spec = walk(doc, rootPlace(doc), ["spec"]);
    return spec.found ? spec.place : null;
  }
  for (const path of POD_SPEC_PATHS) {
    const spec = walk(doc, rootPlace(doc), path);
    if (spec.found) return spec.place;
  }
  return null;
}

export function podSpecLine(doc: KubeDoc): number | null {
  return podSpec(doc)?.line ?? null;
}

const CONTAINER_LISTS = ["containers", "initContainers", "ephemeralContainers"];

function container(doc: KubeDoc, name: string): Place | null {
  const spec = podSpec(doc);
  if (spec === null) return null;
  for (const list of CONTAINER_LISTS) {
    const key = field(doc, spec, list);
    if (key === null) continue;
    for (const item of entries(doc, key)) {
      if (text(field(doc, item, "name")?.node) === name) return item;
    }
  }
  return null;
}

// The line of the container named `name` (its sequence entry), or null.
export function containerLine(doc: KubeDoc, name: string): number | null {
  return container(doc, name)?.line ?? null;
}

// The scalars under `place`, in document order, each with the key that owns
// it: a mapping value's own key, or for a sequence entry the key of its
// sequence. Keys themselves are not values.
function* values(doc: KubeDoc, place: Place): Generator<{ text: string; line: number; owner: string | null }> {
  const stack: { node: unknown; owner: string | null }[] = [{ node: place.node, owner: place.owner }];
  while (stack.length > 0) {
    const { node, owner } = stack.pop()!;
    if (isMap(node)) {
      for (let i = node.items.length - 1; i >= 0; i--) {
        const pair = node.items[i]!;
        stack.push({ node: pair.value, owner: isScalar(pair.key) ? String(pair.key.value) : null });
      }
    } else if (isSeq(node)) {
      for (let i = node.items.length - 1; i >= 0; i--) stack.push({ node: node.items[i], owner });
    } else {
      const value = text(node);
      const at = startOf(node);
      if (value !== null && at !== null) yield { text: value, line: doc.lineAt(at), owner };
    }
  }
}

// How a finding is placed in its object: from a base (the object, its pod
// spec, or the container the finding names), the first of `paths` the
// object has; then, when `value` is given, the line in that field that
// holds the value the finding names (under `key` when given; the last such
// line with `last`).
export type Anchor = {
  base: "object" | "pod" | "container";
  paths: readonly (readonly string[])[];
  value?: { text: string; key?: string; last?: true };
};

// The line of an anchor in `doc`, and whether the field it names was found.
// A field the object lacks anchors on its nearest ancestor that it has; a
// base it lacks falls back to the one above (container, pod spec, object).
export function anchorLine(doc: KubeDoc, anchor: Anchor, containerName: string | null): { line: number; found: boolean } {
  let from: Place | null = null;
  if (anchor.base === "container" && containerName !== null) from = container(doc, containerName);
  if (from === null && anchor.base !== "object") from = podSpec(doc);
  const base = from ?? rootPlace(doc);
  let at: { place: Place; found: boolean } = { place: base, found: anchor.paths.length === 0 };
  for (const [n, path] of anchor.paths.entries()) {
    const tried = walk(doc, base, path);
    if (tried.found || n === 0) at = tried;
    if (tried.found) break;
  }
  if (anchor.value !== undefined && at.found) {
    let hit: number | null = null;
    for (const v of values(doc, at.place)) {
      if (anchor.value.key !== undefined && v.owner !== anchor.value.key) continue;
      if (v.text !== anchor.value.text) continue;
      hit = v.line;
      if (!anchor.value.last) break;
    }
    if (hit !== null) return { line: hit, found: true };
  }
  return { line: at.place.line, found: at.found };
}
