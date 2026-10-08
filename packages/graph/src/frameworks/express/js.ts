// A small reader of JavaScript and TypeScript expressions, shared by the
// Express, React and Next.js plugins: it turns the parts of a parse tree a
// plugin watches into plain JSON (a string, a dotted name, a call, an inline
// function), so a fact can be cached and read back without the tree.
//
// The facts of all three plugins depend on this file: a change to what it
// returns bumps the version of each of them.
import type { Node } from "web-tree-sitter";

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

// How deep a nested expression is read before it becomes `other`: a fact
// stays small whatever the source holds.
const MAX_DEPTH = 6;
const MAX_ITEMS = 24;

// A name chain `a.b.c`, or null when any part is not a plain name.
export function namePath(node: Node | null): string[] | null {
  if (!node) return null;
  if (node.type === "identifier" || node.type === "property_identifier" || node.type === "this") return [node.text];
  if (node.type === "member_expression") {
    const obj = namePath(node.childForFieldName("object"));
    const prop = node.childForFieldName("property");
    if (!obj || !prop || prop.type !== "property_identifier") return null;
    return [...obj, prop.text];
  }
  if (node.type === "parenthesized_expression") return namePath(node.firstNamedChild);
  return null;
}

// The content of a string literal, or null when the node is not one.
export function stringValue(node: Node | null): string | null {
  if (!node) return null;
  if (node.type === "string") return node.namedChildren.map((c) => (c.type === "escape_sequence" ? unescape(c.text) : c.text)).join("");
  if (node.type === "template_string") {
    if (node.namedChildren.some((c) => c.type === "template_substitution")) return null;
    return node.namedChildren.map((c) => (c.type === "escape_sequence" ? unescape(c.text) : c.text)).join("");
  }
  return null;
}

function unescape(seq: string): string {
  const simple: Record<string, string> = { "\\n": "\n", "\\t": "\t", "\\r": "\r", "\\'": "'", '\\"': '"', "\\\\": "\\", "\\`": "`", "\\/": "/" };
  return simple[seq] ?? seq.slice(1);
}

// The literal pieces and names a computed string is made of, when every
// piece is a literal or a name; else null.
function stringParts(node: Node, depth: number): ({ s: string } | { ref: string[] })[] | null {
  if (depth > MAX_DEPTH) return null;
  const lit = stringValue(node);
  if (lit !== null) return [{ s: lit }];
  const path = namePath(node);
  if (path) return [{ ref: path }];
  if (node.type === "parenthesized_expression" && node.firstNamedChild) return stringParts(node.firstNamedChild, depth + 1);
  if (node.type === "binary_expression" && node.childForFieldName("operator")?.text === "+") {
    const left = node.childForFieldName("left");
    const right = node.childForFieldName("right");
    if (!left || !right) return null;
    const l = stringParts(left, depth + 1);
    const r = stringParts(right, depth + 1);
    return l && r ? [...l, ...r] : null;
  }
  if (node.type === "template_string") {
    const out: ({ s: string } | { ref: string[] })[] = [];
    for (const c of node.namedChildren) {
      if (c.type === "template_substitution") {
        const inner = c.firstNamedChild;
        const p = inner ? namePath(inner) : null;
        if (!p) return null;
        out.push({ ref: p });
      } else out.push({ s: c.type === "escape_sequence" ? unescape(c.text) : c.text });
    }
    return out;
  }
  return null;
}

function isStringish(node: Node): boolean {
  if (node.type === "template_string") return true;
  if (node.type === "binary_expression" && node.childForFieldName("operator")?.text === "+") {
    const left = node.childForFieldName("left");
    const right = node.childForFieldName("right");
    return (left !== null && (stringValue(left) !== null || isStringish(left))) || (right !== null && (stringValue(right) !== null || isStringish(right)));
  }
  return false;
}

const FN_TYPES = new Set(["arrow_function", "function_expression", "function", "generator_function"]);

export function paramCount(fn: Node): number {
  const params = fn.childForFieldName("parameters") ?? fn.childForFieldName("parameter");
  if (!params) return 0;
  if (params.type === "identifier") return 1;
  return params.namedChildren.filter((c) => c.type !== "comment").length;
}

export function readExpr(node: Node | null, depth = 0): Expr {
  if (!node) return { t: "other", line: 0, column: 0 };
  const p = pos(node);
  if (depth > MAX_DEPTH) return { t: "other", ...p };
  switch (node.type) {
    case "parenthesized_expression":
      return readExpr(node.firstNamedChild, depth + 1);
    case "await_expression":
    case "as_expression":
    case "satisfies_expression":
    case "non_null_expression":
      return readExpr(node.firstNamedChild, depth + 1);
    case "string": {
      const v = stringValue(node);
      return v === null ? { t: "other", ...p } : { t: "str", v, ...p };
    }
    case "template_string": {
      const v = stringValue(node);
      return v !== null ? { t: "str", v, ...p } : { t: "dyn", parts: stringParts(node, depth), ...p };
    }
    case "binary_expression":
      if (isStringish(node) || stringValue(node.childForFieldName("left")) !== null) return { t: "dyn", parts: stringParts(node, depth), ...p };
      return { t: "other", ...p };
    case "identifier":
    case "this":
      return { t: "ref", path: [node.text], ...p };
    case "member_expression": {
      const path = namePath(node);
      if (path) return { t: "ref", path, ...p };
      const prop = node.childForFieldName("property");
      return { t: "member", obj: readExpr(node.childForFieldName("object"), depth + 1), prop: prop?.text ?? "", ...p };
    }
    case "call_expression": {
      const args = node.childForFieldName("arguments");
      const list = (args?.namedChildren ?? []).filter((c) => c.type !== "comment").slice(0, MAX_ITEMS);
      return { t: "call", fn: readExpr(node.childForFieldName("function"), depth + 1), args: list.map((a) => readExpr(a, depth + 1)), ...p };
    }
    case "array": {
      const items = node.namedChildren.filter((c) => c.type !== "comment").slice(0, MAX_ITEMS);
      return { t: "array", items: items.map((c) => readExpr(c, depth + 1)), ...p };
    }
    case "object": {
      const props: { key: string; value: Expr }[] = [];
      for (const c of node.namedChildren) {
        if (props.length >= MAX_ITEMS) break;
        if (c.type === "pair") {
          const key = c.childForFieldName("key");
          const k = key?.type === "property_identifier" ? key.text : stringValue(key);
          if (k !== null) props.push({ key: k, value: readExpr(c.childForFieldName("value"), depth + 1) });
        } else if (c.type === "shorthand_property_identifier") props.push({ key: c.text, value: { t: "ref", path: [c.text], ...pos(c) } });
      }
      return { t: "object", props, ...p };
    }
    default:
      if (FN_TYPES.has(node.type)) return { t: "fn", params: paramCount(node), ...p };
      return { t: "other", ...p };
  }
}

// Depth-first walk over the named nodes of a tree with a cursor, so a deep
// tree never overflows the stack. `visit` returns false to skip the
// children of a node.
export function walk(root: Node, visit: (node: Node) => boolean | void): void {
  const cursor = root.walk();
  for (;;) {
    let descend = true;
    if (cursor.nodeIsNamed) descend = visit(cursor.currentNode) !== false;
    if (descend && cursor.gotoFirstChild()) continue;
    for (;;) {
      if (cursor.gotoNextSibling()) break;
      if (!cursor.gotoParent()) return;
    }
  }
}

// The line of the innermost function around a node, 0 at module level: the
// scope a plugin matches names in.
export function scopeLine(node: Node): number {
  for (let p = node.parent; p; p = p.parent) {
    if (FN_TYPES.has(p.type) || p.type === "function_declaration" || p.type === "generator_function_declaration" || p.type === "method_definition") return p.startPosition.row + 1;
  }
  return 0;
}

// Whether a declaration sits under an `export` statement.
export function exported(node: Node): boolean {
  for (let p = node.parent; p; p = p.parent) {
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
  const strings = (x: unknown) => Array.isArray(x) && x.every((s) => typeof s === "string");
  switch (e.t) {
    case "str":
      return typeof e.v === "string";
    case "dyn":
      return e.parts === null || (Array.isArray(e.parts) && e.parts.every((p) => typeof p === "object" && p !== null && (typeof (p as { s?: unknown }).s === "string" || strings((p as { ref?: unknown }).ref))));
    case "ref":
      return strings(e.path);
    case "call":
      return isExpr(e.fn, depth + 1) && Array.isArray(e.args) && e.args.every((a) => isExpr(a, depth + 1));
    case "member":
      return isExpr(e.obj, depth + 1) && typeof e.prop === "string";
    case "fn":
      return Number.isInteger(e.params);
    case "array":
      return Array.isArray(e.items) && e.items.every((a) => isExpr(a, depth + 1));
    case "object":
      return Array.isArray(e.props) && e.props.every((p) => typeof p === "object" && p !== null && typeof (p as { key?: unknown }).key === "string" && isExpr((p as { value?: unknown }).value, depth + 1));
    case "other":
      return true;
    default:
      return false;
  }
}

// The source text of an expression, short, for a note: `asyncHandler(getItem)`.
export function show(e: Expr): string {
  switch (e.t) {
    case "str":
      return JSON.stringify(e.v);
    case "dyn":
      return e.parts ? `\`${e.parts.map((p) => ("s" in p ? p.s : `\${${p.ref.join(".")}}`)).join("")}\`` : "a computed string";
    case "ref":
      return e.path.join(".");
    case "call":
      return `${show(e.fn)}(${e.args.map(show).join(", ")})`;
    case "member":
      return `${show(e.obj)}.${e.prop}`;
    case "fn":
      return "an inline function";
    case "array":
      return `[${e.items.map(show).join(", ")}]`;
    case "object":
      return "an object";
    case "other":
      return "an expression";
  }
}
