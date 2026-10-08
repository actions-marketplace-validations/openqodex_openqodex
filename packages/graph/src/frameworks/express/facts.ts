// The Express plugin's context-free facts of one JavaScript or TypeScript
// file: the calls it watches (`x.get(...)`, `x.use(...)`, `x.route(...)`,
// `x.listen(...)`, `createServer(...)`), the values names are bound to, the
// module-level string constants, the CommonJS exports, the parameter types
// of functions, and the parameter counts of top-level functions. Nothing
// here knows which name is Express: that is decided in resolve, from the
// file's imports, so a fact never claims what only another file can prove.
import type { Node } from "web-tree-sitter";
import type { FrameworkFactBase } from "../plugin.js";
import type { Expr } from "./js.js";
import type { Up } from "./js.js";
import { exported, identifierName, isExpr, MAX_ITEMS, MAX_SOURCE_BYTES, namePath, paramCount, pos, readExpr, stringValue, walk } from "./js.js";

// The member calls watched: the routing methods of an application and a
// router, `use`, `route`, `listen`, and the requests of a test agent.
export const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "options", "head", "all"] as const;
const WATCHED = new Set<string>([...HTTP_METHODS, "del", "use", "route", "listen"]);

export type ExpressFact =
  // A watched member call: `recv.prop(args)`. `scope` is the line of the
  // innermost function around it (0 at module level).
  | (FrameworkFactBase & { kind: "call"; recv: Expr; prop: string; args: Expr[]; scope: number })
  // A call of a function named createServer: `http.createServer(app)`.
  | (FrameworkFactBase & { kind: "server"; fn: string[]; args: Expr[]; scope: number })
  // A name bound to a value: `const app = express()`, `app = express()`.
  // `top`: declared at module level; `exported`: under an export statement.
  | (FrameworkFactBase & { kind: "value"; name: string; value: Expr; scope: number; top: boolean; exported: boolean })
  // `module.exports = x` (name "default") or `module.exports.n = x`, `exports.n = x`.
  | (FrameworkFactBase & { kind: "cjs-export"; name: string; value: Expr })
  // A parameter of a function with a type written as a name: `(app: Express)`.
  | (FrameworkFactBase & { kind: "param"; name: string; type: string[]; scope: number })
  // A top-level function and how many parameters it takes.
  | (FrameworkFactBase & { kind: "function"; name: string; params: number })
  // A test block: `describe(...)`, `it(...)`, `test(...)` with a literal name.
  | (FrameworkFactBase & { kind: "test-block"; fn: string; name: string | null })
  // The file is larger than MAX_SOURCE_BYTES and was not read.
  | (FrameworkFactBase & { kind: "too-large"; bytes: number })
  // The file has regions the parser could not read (the first at `line`):
  // nothing in them is a fact.
  | (FrameworkFactBase & { kind: "syntax-error"; regions: number });

// Every file is read: a route can be registered on an imported application
// in a file that never names express, and a name can be spelled with an
// escape, so no test on the text can tell which files hold none. The facts
// come from the tree the core already parsed.
export function wants(): boolean {
  return true;
}

const TEST_FNS = new Set(["describe", "it", "test", "suite"]);

export function readFacts(root: Node): ExpressFact[] {
  if (root.endIndex > MAX_SOURCE_BYTES) return [{ kind: "too-large", line: 1, column: 1, bytes: root.endIndex }];
  const out: ExpressFact[] = [];
  let firstBroken = 0;
  let broken = 0;
  const visit = (node: Node, scope: number, up: Up): void => {
    switch (node.type) {
      case "call_expression": {
        // A call the parser had to repair (a missing parenthesis) is no fact.
        if (node.hasError) return;
        const fn = node.childForFieldName("function");
        const args = (node.childForFieldName("arguments")?.namedChildren ?? []).filter((c) => c.type !== "comment");
        if (fn?.type === "member_expression") {
          const prop = fn.childForFieldName("property");
          const name = prop?.type === "property_identifier" ? identifierName(prop.text) : null;
          if (name !== null && WATCHED.has(name)) {
            out.push({ kind: "call", ...pos(node), recv: readExpr(fn.childForFieldName("object")), prop: name, args: args.slice(0, MAX_ITEMS).map((a) => readExpr(a)), scope });
          }
        }
        const path = namePath(fn);
        if (path && path[path.length - 1] === "createServer") out.push({ kind: "server", ...pos(node), fn: path, args: args.slice(0, MAX_ITEMS).map((a) => readExpr(a)), scope });
        if (path && path.length === 1 && TEST_FNS.has(path[0] as string)) out.push({ kind: "test-block", ...pos(node), fn: path[0] as string, name: stringValue(args[0] ?? null) });
        return;
      }
      case "variable_declarator": {
        const name = node.childForFieldName("name");
        const value = node.childForFieldName("value");
        const id = name?.type === "identifier" ? identifierName(name.text) : null;
        if (id === null || !value || node.hasError) return;
        out.push({ kind: "value", ...pos(node), name: id, value: readExpr(value), scope, top: scope === 0 && up(2)?.type !== "for_statement", exported: exported(up) });
        return;
      }
      case "assignment_expression": {
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        if (!left || !right || node.hasError) return;
        const path = namePath(left);
        if (!path) return;
        if (path[0] === "module" && path[1] === "exports") {
          out.push({ kind: "cjs-export", ...pos(node), name: path.length === 2 ? "default" : (path[2] as string), value: readExpr(right) });
          return;
        }
        if (path[0] === "exports" && path.length === 2) {
          out.push({ kind: "cjs-export", ...pos(node), name: path[1] as string, value: readExpr(right) });
          return;
        }
        if (path.length === 1) {
          out.push({ kind: "value", ...pos(node), name: path[0] as string, value: readExpr(right), scope, top: scope === 0, exported: false });
        }
        return;
      }
      case "required_parameter":
      case "optional_parameter": {
        const pattern = node.childForFieldName("pattern");
        const ann = node.childForFieldName("type")?.firstNamedChild ?? null;
        const id = pattern?.type === "identifier" ? identifierName(pattern.text) : null;
        if (id === null || !ann) return;
        const type = typeName(ann);
        // The parameter list's owner, two steps up: the function the scope is named by.
        const owner = up(2);
        if (type) out.push({ kind: "param", ...pos(node), name: id, type, scope: owner ? owner.startPosition.row + 1 : 0 });
        return;
      }
      case "function_declaration": {
        const name = node.childForFieldName("name");
        const id = name ? identifierName(name.text) : null;
        if (id !== null && scope === 0) out.push({ kind: "function", ...pos(node), name: id, params: paramCount(node) });
        return;
      }
    }
  };
  walk(root, visit, (line) => {
    if (broken++ === 0) firstBroken = line;
  });
  if (broken > 0) out.push({ kind: "syntax-error", line: firstBroken, column: 1, regions: broken });
  return out;
}

// A type written as a name or a qualified name: `Express`, `express.Router`,
// read from the tree's own parts.
function typeName(node: Node): string[] | null {
  const parts: string[] = [];
  let n: Node | null = node;
  for (let steps = 0; n && steps < 8; steps++) {
    if (n.type === "generic_type") {
      n = n.firstNamedChild;
      continue;
    }
    if (n.type === "type_identifier" || n.type === "identifier") {
      const id = identifierName(n.text);
      if (id === null) return null;
      parts.unshift(id);
      return parts;
    }
    if (n.type !== "nested_type_identifier" && n.type !== "nested_identifier" && n.type !== "member_expression") return null;
    const last = n.lastNamedChild;
    const id = last && (last.type === "type_identifier" || last.type === "property_identifier" || last.type === "identifier") ? identifierName(last.text) : null;
    if (id === null) return null;
    parts.unshift(id);
    n = n.firstNamedChild;
  }
  return null;
}

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

export function isExpressFact(v: unknown): v is ExpressFact {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  if (!Number.isInteger(f.line) || !Number.isInteger(f.column)) return false;
  switch (f.kind) {
    case "call":
      return isExpr(f.recv) && typeof f.prop === "string" && Array.isArray(f.args) && f.args.every((a) => isExpr(a)) && Number.isInteger(f.scope);
    case "server":
      return strings(f.fn) && Array.isArray(f.args) && f.args.every((a) => isExpr(a)) && Number.isInteger(f.scope);
    case "value":
      return typeof f.name === "string" && isExpr(f.value) && Number.isInteger(f.scope) && typeof f.top === "boolean" && typeof f.exported === "boolean";
    case "cjs-export":
      return typeof f.name === "string" && isExpr(f.value);
    case "param":
      return typeof f.name === "string" && strings(f.type) && Number.isInteger(f.scope);
    case "function":
      return typeof f.name === "string" && Number.isInteger(f.params);
    case "test-block":
      return typeof f.fn === "string" && (f.name === null || typeof f.name === "string");
    case "too-large":
      return Number.isInteger(f.bytes);
    case "syntax-error":
      return Number.isInteger(f.regions);
    default:
      return false;
  }
}
