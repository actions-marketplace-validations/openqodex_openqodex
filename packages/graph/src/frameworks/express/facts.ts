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
import { exported, isExpr, namePath, paramCount, pos, readExpr, scopeLine, stringValue, walk } from "./js.js";

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
  | (FrameworkFactBase & { kind: "test-block"; fn: string; name: string | null });

export function wants(source: string): boolean {
  return source.includes("express") || source.includes("supertest") || source.includes("createServer") || source.includes("module.exports");
}

const TEST_FNS = new Set(["describe", "it", "test", "suite"]);

export function readFacts(root: Node): ExpressFact[] {
  const out: ExpressFact[] = [];
  walk(root, (node) => {
    switch (node.type) {
      case "call_expression": {
        const fn = node.childForFieldName("function");
        const args = (node.childForFieldName("arguments")?.namedChildren ?? []).filter((c) => c.type !== "comment");
        if (fn?.type === "member_expression") {
          const prop = fn.childForFieldName("property");
          if (prop && WATCHED.has(prop.text)) {
            out.push({ kind: "call", ...pos(node), recv: readExpr(fn.childForFieldName("object")), prop: prop.text, args: args.map((a) => readExpr(a)), scope: scopeLine(node) });
          }
        }
        const path = namePath(fn);
        if (path && path[path.length - 1] === "createServer") out.push({ kind: "server", ...pos(node), fn: path, args: args.map((a) => readExpr(a)), scope: scopeLine(node) });
        if (path && path.length === 1 && TEST_FNS.has(path[0] as string)) out.push({ kind: "test-block", ...pos(node), fn: path[0] as string, name: stringValue(args[0] ?? null) });
        return;
      }
      case "variable_declarator": {
        const name = node.childForFieldName("name");
        const value = node.childForFieldName("value");
        if (name?.type !== "identifier" || !value) return;
        const scope = scopeLine(node);
        out.push({ kind: "value", ...pos(node), name: name.text, value: readExpr(value), scope, top: scope === 0 && node.parent?.parent?.type !== "for_statement", exported: exported(node) });
        return;
      }
      case "assignment_expression": {
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        if (!left || !right) return;
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
          const scope = scopeLine(node);
          out.push({ kind: "value", ...pos(node), name: path[0] as string, value: readExpr(right), scope, top: scope === 0, exported: false });
        }
        return;
      }
      case "required_parameter":
      case "optional_parameter": {
        const pattern = node.childForFieldName("pattern");
        const ann = node.childForFieldName("type")?.firstNamedChild ?? null;
        if (pattern?.type !== "identifier" || !ann) return;
        const type = typeName(ann);
        if (type) out.push({ kind: "param", ...pos(node), name: pattern.text, type, scope: node.parent?.parent ? node.parent.parent.startPosition.row + 1 : 0 });
        return;
      }
      case "function_declaration": {
        const name = node.childForFieldName("name");
        if (name && scopeLine(node) === 0) out.push({ kind: "function", ...pos(node), name: name.text, params: paramCount(node) });
        return;
      }
    }
  });
  return out;
}

// A type written as a name or a qualified name: `Express`, `express.Router`.
function typeName(node: Node): string[] | null {
  if (node.type === "type_identifier" || node.type === "identifier") return [node.text];
  if (node.type === "nested_type_identifier") {
    const parts = node.text.split(".").map((s) => s.trim());
    return parts.every((p) => /^[A-Za-z_$][\w$]*$/.test(p)) ? parts : null;
  }
  if (node.type === "generic_type") return typeName(node.firstNamedChild as Node);
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
    default:
      return false;
  }
}
