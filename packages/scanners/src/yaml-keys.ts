// The mapping keys of a YAML or JSON file, as units for the suppression
// table (suppression.ts, family "yaml-keys"). kube-linter and Checkov obey a
// suppression written as an annotation key (`ignore-check.kube-linter.io/
// <check>`, `checkov.io/skip1`), and they read it from YAML or JSON in any
// style: a block or flow mapping, a quoted key with escapes, an alias or a
// merge key. A reader narrower than theirs hides a suppression the change
// adds, so the file is read by a YAML parser (the `yaml` library: it builds
// a syntax tree and runs nothing), not by a line pattern. JSON is YAML.
//
// Each unit is one key: `start` is the offset of the key in the file and
// `text` is the key as the scanner decodes it. A key that reaches a mapping
// through an alias (`annotations: *common`, `<<: *common`) also counts at the
// alias, on the line the change may have added, with every key of the
// anchored node.
//
// Wider, never narrower: a file over MAX_KEY_BYTES, a file the parser cannot
// read, and a file whose aliases would take more than WORK_LIMIT steps to
// expand give their raw lines instead (`keys: false`), so the marker counts
// on any line that holds it, in a string or a comment too.

import { isAlias, isMap, isPair, isScalar, isSeq, parseAllDocuments } from "yaml";
import type { Comment } from "./comments.js";

// Kubernetes manifests are kilobytes; past this the raw lines are read.
export const MAX_KEY_BYTES = 4 * 1024 * 1024;
// The most nodes looked at, alias expansions included, before the raw lines
// are read instead.
const WORK_LIMIT = 2_000_000;

type Node = unknown;

class TooMuch extends Error {}

export function yamlKeys(text: string): { units: Comment[]; keys: boolean } {
  if (text.length > MAX_KEY_BYTES) return { units: rawLines(text), keys: false };
  try {
    const docs = parseAllDocuments(text, { prettyErrors: false, uniqueKeys: false, strict: false });
    if (!Array.isArray(docs)) return { units: [], keys: true };
    const units: Comment[] = [];
    let work = 0;
    const step = () => {
      work += 1;
      if (work > WORK_LIMIT) throw new TooMuch();
    };
    for (const doc of docs) {
      if (doc.errors.length > 0) return { units: rawLines(text), keys: false };
      // Anchors are per document; an alias names the last anchor of that name
      // before it.
      const anchors = new Map<string, Node>();
      const deep = new Map<Node, Set<string>>();
      const busy = new Set<Node>();
      const keyOf = (key: Node): string | null => (isScalar(key) ? String(key.value) : null);

      // Every key in the node, through nested aliases, memoized per node.
      const keysUnder = (root: Node): Set<string> => {
        const known = deep.get(root);
        if (known) return known;
        const out = new Set<string>();
        if (busy.has(root)) return out;
        busy.add(root);
        const stack: Node[] = [root];
        while (stack.length > 0) {
          const node = stack.pop();
          step();
          if (isAlias(node)) {
            const target = anchors.get(node.source);
            if (target !== undefined) for (const k of keysUnder(target)) out.add(k);
          } else if (isMap(node)) {
            for (const pair of node.items) {
              const k = keyOf(pair.key);
              if (k !== null) out.add(k);
              stack.push(pair.key, pair.value);
            }
          } else if (isSeq(node)) {
            for (const item of node.items) stack.push(item);
          } else if (isPair(node)) {
            stack.push(node.key, node.value);
          }
        }
        busy.delete(root);
        deep.set(root, out);
        return out;
      };

      // Pre-order, in document order, so each alias sees the anchors before it.
      const stack: Node[] = [doc.contents];
      while (stack.length > 0) {
        const node = stack.pop();
        if (node === null || node === undefined) continue;
        step();
        const anchor = (node as { anchor?: unknown }).anchor;
        if (typeof anchor === "string" && anchor !== "") anchors.set(anchor, node);
        if (isAlias(node)) {
          const target = anchors.get(node.source);
          const at = node.range?.[0];
          if (target !== undefined && at !== undefined) {
            if (isScalar(target)) units.push({ start: at, text: String(target.value) });
            for (const k of keysUnder(target)) {
              step();
              units.push({ start: at, text: k });
            }
          }
        } else if (isMap(node)) {
          for (let i = node.items.length - 1; i >= 0; i--) {
            const pair = node.items[i]!;
            stack.push(pair.value, pair.key);
          }
          for (const pair of node.items) {
            const k = keyOf(pair.key);
            const at = isScalar(pair.key) ? pair.key.range?.[0] : undefined;
            if (k !== null && at !== undefined) units.push({ start: at, text: k });
          }
        } else if (isSeq(node)) {
          for (let i = node.items.length - 1; i >= 0; i--) stack.push(node.items[i]);
        } else if (isPair(node)) {
          stack.push(node.value, node.key);
        }
      }
    }
    return { units: units.sort((a, b) => a.start - b.start), keys: true };
  } catch {
    // Nesting too deep for the parser, or aliases past the work limit.
    return { units: rawLines(text), keys: false };
  }
}

function rawLines(text: string): Comment[] {
  const out: Comment[] = [];
  let start = 0;
  for (;;) {
    const end = text.indexOf("\n", start);
    const line = text.slice(start, end < 0 ? text.length : end);
    out.push({ start, text: line.endsWith("\r") ? line.slice(0, -1) : line });
    if (end < 0) return out;
    start = end + 1;
  }
}
