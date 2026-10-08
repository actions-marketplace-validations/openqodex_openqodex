// A small reader of JavaScript and TypeScript expressions, shared by the
// Express, React and Next.js plugins: it turns the parts of a parse tree a
// plugin watches into plain JSON (a string, a dotted name, a call, an inline
// function), so a fact can be cached and read back without the tree.
//
// The facts of all three plugins depend on this file: a change to what it
// returns bumps the version of each of them.
//
// The files read are the repository's, so a stranger controls them. Every
// read here is bounded: a file over MAX_SOURCE_BYTES is not read at all, an
// expression is read to at most MAX_DEPTH levels and MAX_NODES nodes, a name
// chain to MAX_NAME_PARTS parts, a string to MAX_STRING characters, and the
// walk over a tree is one pass with no step back up the parents.
import type { Node } from "web-tree-sitter";

// The largest file a JavaScript plugin reads, in bytes. A larger file gets
// one fact of kind "too-large" and nothing else; resolve turns it into an
// unknown. Route tables, components and tests are far smaller.
export const MAX_SOURCE_BYTES = 256 * 1024;

// Positions as the language facts give them: 1-based line and column.
export type Pos = { line: number; column: number };

export function pos(node: Node): Pos {
  return { line: node.startPosition.row + 1, column: node.startPosition.column + 1 };
}

// An expression as a plugin reads it. `str` is a string literal, or a
// template with no substitution. `dyn` is a string the code computes (a
// template with a substitution, a concatenation with a name in it); `parts`
// holds the literal pieces and the names when every piece is one of those,
// so a plugin can evaluate a concatenation of module-level constants.
// `ref` is a name or a chain of names (`a`, `a.b.c`); `call` a call; `member`
// a property of something that is not a name (`f().x`); `fn` an inline
// function with its parameter count; `array` an array literal; `object` an
// object literal with its literal-keyed properties; `other` anything else.
export type Expr =
  | ({ t: "str"; v: string } & Pos)
  | ({ t: "dyn"; parts: ({ s: string } | { ref: string[] })[] | null } & Pos)
  | ({ t: "ref"; path: string[] } & Pos)
  | ({ t: "call"; fn: Expr; args: Expr[] } & Pos)
  | ({ t: "member"; obj: Expr; prop: string } & Pos)
  | ({ t: "fn"; params: number } & Pos)
  | ({ t: "array"; items: Expr[] } & Pos)
  | ({ t: "object"; props: { key: string; value: Expr }[] } & Pos)
  | ({ t: "other" } & Pos);

// How much of one expression is read before the rest becomes `other`: a
// fact stays small whatever the source holds.
export const MAX_DEPTH = 6;
export const MAX_ITEMS = 24; // arguments, array items or object properties kept
export const MAX_NODES = 256; // nodes read for one expression
export const MAX_NAME_PARTS = 16; // parts of a name chain `a.b.c`
export const MAX_STRING = 2048; // characters of a string literal kept
const MAX_PARTS = 32; // pieces of a computed string

// A name chain `a.b.c`, or null when any part is not a plain name or the
// chain is longer than MAX_NAME_PARTS. Walks down the object side in a loop.
export function namePath(start: Node | null): string[] | null {
  const parts: string[] = [];
  let node = start;
  while (node) {
    if (parts.length >= MAX_NAME_PARTS) return null;
    if (node.type === "parenthesized_expression") {
      node = node.firstNamedChild;
      continue;
    }
    if (node.type === "identifier" || node.type === "property_identifier" || node.type === "this") {
      parts.push(node.text);
      return parts.reverse();
    }
    if (node.type !== "member_expression") return null;
    const prop = node.childForFieldName("property");
    if (!prop || prop.type !== "property_identifier") return null;
    parts.push(prop.text);
    node = node.childForFieldName("object");
  }
  return null;
}

// The content of a string literal, or null when the node is not one or is
// longer than MAX_STRING.
export function stringValue(node: Node | null): string | null {
  if (!node) return null;
  if (node.type !== "string" && node.type !== "template_string") return null;
  if (node.endIndex - node.startIndex > MAX_STRING + 2) return null;
  const parts = node.namedChildren;
  if (node.type === "template_string" && parts.some((c) => c.type === "template_substitution")) return null;
  return parts.map((c) => (c.type === "escape_sequence" ? unescape(c.text) : c.text)).join("");
}

function unescape(seq: string): string {
  const simple: Record<string, string> = { "\\n": "\n", "\\t": "\t", "\\r": "\r", "\\'": "'", '\\"': '"', "\\\\": "\\", "\\`": "`", "\\/": "/" };
  return simple[seq] ?? seq.slice(1);
}

type Part = { s: string } | { ref: string[] };

// The literal pieces and names a computed string is made of, when every
// piece is a literal or a name; else null. A concatenation is flattened
// with an explicit stack, never by recursion, and stops at MAX_PARTS.
function stringParts(start: Node): Part[] | null {
  const out: Part[] = [];
  const stack: Node[] = [start];
  while (stack.length > 0) {
    if (out.length > MAX_PARTS) return null;
    const node = stack.pop() as Node;
    const lit = stringValue(node);
    if (lit !== null) {
      out.push({ s: lit });
      continue;
    }
    const path = namePath(node);
    if (path) {
      out.push({ ref: path });
      continue;
    }
    if (node.type === "parenthesized_expression" && node.firstNamedChild) {
      stack.push(node.firstNamedChild);
      continue;
    }
    if (node.type === "binary_expression" && node.childForFieldName("operator")?.text === "+") {
      const left = node.childForFieldName("left");
      const right = node.childForFieldName("right");
      if (!left || !right) return null;
      stack.push(right, left);
      continue;
    }
    if (node.type === "template_string") {
      if (node.endIndex - node.startIndex > MAX_STRING) return null;
      for (const c of node.namedChildren) {
        if (c.type === "template_substitution") {
          const inner = c.firstNamedChild;
          const p = inner ? namePath(inner) : null;
          if (!p) return null;
          out.push({ ref: p });
        } else out.push({ s: c.type === "escape_sequence" ? unescape(c.text) : c.text });
      }
      continue;
    }
    return null;
  }
  return out;
}

// Whether a `+` expression builds a string: some leaf of it is a string or a
// template. Walks the leaves with a stack and a bound.
function isStringish(start: Node): boolean {
  const stack: Node[] = [start];
  for (let seen = 0; stack.length > 0 && seen < MAX_NODES; seen++) {
    const node = stack.pop() as Node;
    if (node.type === "template_string" || node.type === "string") return true;
    if (node.type === "parenthesized_expression" && node.firstNamedChild) stack.push(node.firstNamedChild);
    else if (node.type === "binary_expression" && node.childForFieldName("operator")?.text === "+") {
      const left = node.childForFieldName("left");
      const right = node.childForFieldName("right");
      if (left) stack.push(left);
      if (right) stack.push(right);
    }
  }
  return false;
}

export const FN_TYPES: ReadonlySet<string> = new Set(["arrow_function", "function_expression", "function", "generator_function"]);
const SCOPE_TYPES: ReadonlySet<string> = new Set([...FN_TYPES, "function_declaration", "generator_function_declaration", "method_definition"]);

export function paramCount(fn: Node): number {
  const params = fn.childForFieldName("parameters") ?? fn.childForFieldName("parameter");
  if (!params) return 0;
  if (params.type === "identifier") return 1;
  return params.namedChildren.filter((c) => c.type !== "comment").length;
}

// Reads one expression, within MAX_DEPTH levels and MAX_NODES nodes.
export function readExpr(node: Node | null): Expr {
  return read(node, 0, { left: MAX_NODES });
}

function read(node: Node | null, depth: number, budget: { left: number }): Expr {
  if (!node) return { t: "other", line: 0, column: 0 };
  const p = pos(node);
  budget.left--;
  if (depth > MAX_DEPTH || budget.left < 0) return { t: "other", ...p };
  switch (node.type) {
    case "parenthesized_expression":
    case "await_expression":
    case "as_expression":
    case "satisfies_expression":
    case "non_null_expression":
      return read(node.firstNamedChild, depth + 1, budget);
    case "string": {
      const v = stringValue(node);
      return v === null ? { t: "other", ...p } : { t: "str", v, ...p };
    }
    case "template_string": {
      const v = stringValue(node);
      return v !== null ? { t: "str", v, ...p } : { t: "dyn", parts: stringParts(node), ...p };
    }
    case "binary_expression":
      if (isStringish(node)) return { t: "dyn", parts: stringParts(node), ...p };
      return { t: "other", ...p };
    case "identifier":
    case "this":
      return { t: "ref", path: [node.text], ...p };
    case "member_expression": {
      const path = namePath(node);
      if (path) return { t: "ref", path, ...p };
      const prop = node.childForFieldName("property");
      return { t: "member", obj: read(node.childForFieldName("object"), depth + 1, budget), prop: prop?.text ?? "", ...p };
    }
    case "call_expression": {
      const fn = read(node.childForFieldName("function"), depth + 1, budget);
      const args: Expr[] = [];
      for (const a of node.childForFieldName("arguments")?.namedChildren ?? []) {
        if (args.length >= MAX_ITEMS) break;
        if (a.type !== "comment") args.push(read(a, depth + 1, budget));
      }
      return { t: "call", fn, args, ...p };
    }
    case "array": {
      const items: Expr[] = [];
      for (const c of node.namedChildren) {
        if (items.length >= MAX_ITEMS) break;
        if (c.type !== "comment") items.push(read(c, depth + 1, budget));
      }
      return { t: "array", items, ...p };
    }
    case "object": {
      const props: { key: string; value: Expr }[] = [];
      for (const c of node.namedChildren) {
        if (props.length >= MAX_ITEMS) break;
        if (c.type === "pair") {
          const key = c.childForFieldName("key");
          const k = key?.type === "property_identifier" ? key.text : stringValue(key);
          if (k !== null) props.push({ key: k, value: read(c.childForFieldName("value"), depth + 1, budget) });
        } else if (c.type === "shorthand_property_identifier") props.push({ key: c.text, value: { t: "ref", path: [c.text], ...pos(c) } });
      }
      return { t: "object", props, ...p };
    }
    default:
      if (FN_TYPES.has(node.type)) return { t: "fn", params: paramCount(node), ...p };
      return { t: "other", ...p };
  }
}

// One depth-first pass over the named nodes of a tree with a cursor, so a
// deep tree never overflows the stack. `visit` gets each node and the line
// of the innermost function around it (0 at module level), kept on a stack
// as the walk enters and leaves functions, never found by climbing the
// parents. It returns false to skip the children of a node.
export function walk(root: Node, visit: (node: Node, scope: number) => boolean | void): void {
  const cursor = root.walk();
  const scopes: { depth: number; line: number }[] = [];
  let depth = 0;
  for (;;) {
    let descend = true;
    if (cursor.nodeIsNamed) {
      const node = cursor.currentNode;
      descend = visit(node, scopes.length > 0 ? (scopes[scopes.length - 1] as { line: number }).line : 0) !== false;
      if (descend && SCOPE_TYPES.has(node.type)) scopes.push({ depth, line: node.startPosition.row + 1 });
    }
    if (descend && cursor.gotoFirstChild()) {
      depth++;
      continue;
    }
    for (;;) {
      // Leaving this node: a function it opened is closed.
      while (scopes.length > 0 && (scopes[scopes.length - 1] as { depth: number }).depth >= depth) scopes.pop();
      if (cursor.gotoNextSibling()) break;
      if (!cursor.gotoParent()) return;
      depth--;
    }
  }
}

// Whether a declaration sits under an `export` statement: its declaration
// statement's parent, two steps up at most.
export function exported(node: Node): boolean {
  let p = node.parent;
  for (let steps = 0; p && steps < 3; steps++, p = p.parent) {
    if (p.type === "export_statement") return true;
    if (p.type === "program" || p.type === "statement_block") return false;
  }
  return false;
}

// A literal string an expression stands for: a string, or a computed one
// whose names each resolve through `constant` to a literal. Null otherwise.
export function evaluate(e: Expr, constant: (path: string[]) => string | null): string | null {
  if (e.t === "str") return e.v;
  if (e.t === "ref") return constant(e.path);
  if (e.t === "dyn" && e.parts) {
    let out = "";
    for (const part of e.parts) {
      if ("s" in part) out += part.s;
      else {
        const v = constant(part.ref);
        if (v === null) return null;
        out += v;
      }
      if (out.length > MAX_STRING) return null;
    }
    return out;
  }
  return null;
}

// Whether a cached expression has the shape readExpr gives.
export function isExpr(v: unknown, depth = 0): v is Expr {
  if (depth > MAX_DEPTH + 2 || typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  if (!Number.isInteger(e.line) || !Number.isInteger(e.column)) return false;
  const strings = (x: unknown) => Array.isArray(x) && x.length <= MAX_NAME_PARTS && x.every((s) => typeof s === "string");
  const list = (x: unknown): x is unknown[] => Array.isArray(x) && x.length <= MAX_PARTS + 1;
  switch (e.t) {
    case "str":
      return typeof e.v === "string";
    case "dyn":
      return e.parts === null || (list(e.parts) && e.parts.every((p) => typeof p === "object" && p !== null && (typeof (p as { s?: unknown }).s === "string" || strings((p as { ref?: unknown }).ref))));
    case "ref":
      return strings(e.path);
    case "call":
      return isExpr(e.fn, depth + 1) && list(e.args) && e.args.every((a) => isExpr(a, depth + 1));
    case "member":
      return isExpr(e.obj, depth + 1) && typeof e.prop === "string";
    case "fn":
      return Number.isInteger(e.params);
    case "array":
      return list(e.items) && e.items.every((a) => isExpr(a, depth + 1));
    case "object":
      return list(e.props) && e.props.every((p) => typeof p === "object" && p !== null && typeof (p as { key?: unknown }).key === "string" && isExpr((p as { value?: unknown }).value, depth + 1));
    case "other":
      return true;
    default:
      return false;
  }
}

// The source text of an expression, short, for a note: `asyncHandler(getItem)`.
export function show(e: Expr): string {
  const text = render(e, 0);
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

function render(e: Expr, depth: number): string {
  if (depth > 4) return "...";
  switch (e.t) {
    case "str":
      return JSON.stringify(e.v.length > 120 ? `${e.v.slice(0, 117)}...` : e.v);
    case "dyn":
      return e.parts ? `\`${e.parts.map((p) => ("s" in p ? p.s : `\${${p.ref.join(".")}}`)).join("")}\`` : "a computed string";
    case "ref":
      return e.path.join(".");
    case "call":
      return `${render(e.fn, depth + 1)}(${e.args
        .slice(0, 4)
        .map((a) => render(a, depth + 1))
        .join(", ")}${e.args.length > 4 ? ", ..." : ""})`;
    case "member":
      return `${render(e.obj, depth + 1)}.${e.prop}`;
    case "fn":
      return "an inline function";
    case "array":
      return `[${e.items
        .slice(0, 4)
        .map((a) => render(a, depth + 1))
        .join(", ")}${e.items.length > 4 ? ", ..." : ""}]`;
    case "object":
      return "an object";
    case "other":
      return "an expression";
  }
}
