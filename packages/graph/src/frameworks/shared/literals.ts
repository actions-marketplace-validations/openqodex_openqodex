// The literal evaluator's Python part: what a string, a dotted name or a
// list of strings in the parse tree says, without running anything. A
// string with an interpolation, a format call or a concatenation of
// anything but literals is computed: `{ dynamic: true }`, never a guess.
import type { Node } from "web-tree-sitter";

export type Lit = string | { dynamic: true } | null;

export const DYNAMIC: { dynamic: true } = { dynamic: true };

export function isDynamic(v: Lit): v is { dynamic: true } {
  return typeof v === "object" && v !== null;
}

export function isLit(v: unknown): v is Lit {
  return v === null || typeof v === "string" || (typeof v === "object" && v !== null && (v as { dynamic?: unknown }).dynamic === true);
}

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', "0": "\0" };

// The value of a Python string node, or a concatenation of string nodes.
export function pyString(node: Node | null | undefined): Lit {
  if (!node) return null;
  if (node.type === "concatenated_string") {
    let out = "";
    for (const part of node.namedChildren) {
      const v = pyString(part);
      if (typeof v !== "string") return DYNAMIC;
      out += v;
    }
    return out;
  }
  if (node.type === "binary_operator") {
    // "a" + "b": both sides literal.
    const op = node.childForFieldName("operator")?.text;
    const left = pyString(node.childForFieldName("left"));
    const right = pyString(node.childForFieldName("right"));
    if (op === "+" && typeof left === "string" && typeof right === "string") return left + right;
    return DYNAMIC;
  }
  if (node.type !== "string") return DYNAMIC;
  if (node.namedChildren.some((c) => c.type === "interpolation")) return DYNAMIC;
  const start = node.namedChildren.find((c) => c.type === "string_start")?.text ?? '"';
  let cut = start.length;
  while (cut > 0 && (start[cut - 1] === '"' || start[cut - 1] === "'")) cut--;
  const prefix = start.slice(0, cut).toLowerCase();
  const raw = prefix.includes("r");
  let out = "";
  for (const c of node.namedChildren) {
    if (c.type === "string_content") out += raw ? c.text : c.text.replace(/\\(.)/g, (m, ch: string) => ESCAPES[ch] ?? m);
    else if (c.type === "escape_sequence") out += raw ? c.text : (ESCAPES[c.text.slice(1)] ?? c.text);
  }
  return out;
}

// A dotted name as written (`views.index`, `models.Model`), or null when the
// node is anything else.
export function dotted(node: Node | null | undefined): string[] | null {
  if (!node) return null;
  if (node.type === "identifier") return [node.text];
  if (node.type === "attribute") {
    const object = dotted(node.childForFieldName("object"));
    const attr = node.childForFieldName("attribute")?.text;
    return object && attr ? [...object, attr] : null;
  }
  return null;
}

// The arguments of a call: positional in order, and keyword by name.
export function pyArgs(call: Node): { positional: Node[]; keyword: Map<string, Node> } {
  const positional: Node[] = [];
  const keyword = new Map<string, Node>();
  const args = call.childForFieldName("arguments");
  for (const a of args?.namedChildren ?? []) {
    if (a.type === "keyword_argument") {
      const name = a.childForFieldName("name")?.text;
      const value = a.childForFieldName("value");
      if (name && value) keyword.set(name, value);
    } else if (a.type !== "comment") positional.push(a);
  }
  return { positional, keyword };
}

// A list or tuple of string literals; null when any item is not one.
export function pyStrings(node: Node | null | undefined): string[] | null {
  if (!node || (node.type !== "list" && node.type !== "tuple")) return null;
  const out: string[] = [];
  for (const c of node.namedChildren) {
    if (c.type === "comment") continue;
    const v = pyString(c);
    if (typeof v !== "string") return null;
    out.push(v);
  }
  return out;
}

export function lineOf(node: Node): { line: number; column: number } {
  return { line: node.startPosition.row + 1, column: node.startPosition.column };
}
