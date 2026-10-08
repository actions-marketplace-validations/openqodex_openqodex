// The FastAPI plugin's context-free facts of one Python file: the names
// bound to values (`app = FastAPI()`, `router = APIRouter(prefix="/v1")`,
// `client = TestClient(app)`, `LEGACY = "/legacy"`), the decorators that
// register the function below them (`@router.get("/{item_id}")`), the
// dependencies a decorated function declares in its parameters, and the
// calls watched on any value (`include_router`, `add_api_route`, and the
// requests a test client makes). Nothing here knows which name is FastAPI:
// that is decided in resolve, from the file's imports, so a fact never
// claims what only another file can prove.
import type { Node } from "web-tree-sitter";
import type { FrameworkFactBase } from "../plugin.js";
import type { Expr, Kw, Scope } from "./py.js";
import { isExpr, isKws, MAX_ARGS, namePath, pos, readExpr, walkScoped } from "./py.js";

// The most bytes of one file the plugin reads; a larger file gets one
// "too-large" fact and nothing else, and resolve says so with an unknown.
export const MAX_SOURCE_BYTES = 256 * 1024;
// Parameters of one decorated function read for dependencies.
export const MAX_PARAMS = 64;

// The decorators that register the function below them, on an application
// or a router.
export const ROUTE_METHODS = ["get", "post", "put", "patch", "delete", "options", "head", "trace"] as const;
const ROUTE_DECORATORS = new Set<string>([...ROUTE_METHODS, "api_route", "websocket"]);
// The calls watched on any value: route assembly, and a test client's requests.
const WATCHED = new Set<string>(["include_router", "add_api_route", "add_api_websocket_route", "get", "post", "put", "patch", "delete", "options", "head", "request"]);

// A dependency a parameter declares: the call in its default or in its
// `Annotated[...]` metadata, and the parameter's annotation (what a bare
// `Depends()` depends on).
export type ParamDep = { call: Expr; type: Expr | null };

export type FastApiFact =
  // A name bound to a value: `app = FastAPI()`, `with TestClient(app) as c:`.
  // `scope` is the line of the innermost function around it (0 at module level).
  | (FrameworkFactBase & { kind: "value"; name: string; value: Expr; scope: number })
  // A decorator `@recv.method(args)` on a function. `def` is the line the
  // decorated definition starts at (the function's symbol line), `params`
  // the dependencies its parameters declare, in order, and `omitted` the
  // parameters past MAX_PARAMS.
  | (FrameworkFactBase & { kind: "route"; recv: string[]; method: string; args: Expr[]; kw: Kw[]; fn: string; def: number; scope: number; params: ParamDep[]; omitted: number })
  // A watched call `recv.prop(args)` that is not a decorator.
  | (FrameworkFactBase & { kind: "call"; recv: Expr; prop: string; args: Expr[]; kw: Kw[]; scope: number })
  // The file is larger than MAX_SOURCE_BYTES and was not read.
  | (FrameworkFactBase & { kind: "too-large"; bytes: number })
  // The file has a syntax error (the first one is at the fact's position);
  // nothing inside a broken region was read.
  | (FrameworkFactBase & { kind: "syntax-error" });

// Every Python file is read. No text test is a superset of the facts: a
// module that imports its router from another file registers routes with
// no FastAPI name in its text (and Python allows `@ router . get (...)`),
// and a route path can be a constant of a file that names nothing at all.
export function wants(): boolean {
  return true;
}

// The dependencies a function's parameters declare, in order: each
// parameter's `Annotated[...]` metadata calls, then its default when that
// is a call.
function paramDeps(fn: Node): { params: ParamDep[]; omitted: number } {
  const params: ParamDep[] = [];
  const list = fn.childForFieldName("parameters")?.namedChildren ?? [];
  let read = 0;
  let omitted = 0;
  for (const p of list) {
    if (p.type !== "typed_parameter" && p.type !== "default_parameter" && p.type !== "typed_default_parameter") continue;
    if (read >= MAX_PARAMS) {
      omitted++;
      continue;
    }
    read++;
    const typeNode = p.childForFieldName("type");
    const inner = typeNode?.type === "type" ? typeNode.firstNamedChild : typeNode;
    let annotation: Expr | null = null;
    if (inner && (inner.type === "generic_type" || inner.type === "subscript")) {
      const head = inner.type === "subscript" ? inner.childForFieldName("value") : inner.firstNamedChild;
      const headPath = namePath(head);
      if (headPath && headPath[headPath.length - 1] === "Annotated") {
        const args = inner.type === "subscript" ? inner.childrenForFieldName("subscript") : (inner.namedChildren.find((c) => c.type === "type_parameter")?.namedChildren ?? []);
        const types = args.map((a) => (a.type === "type" ? a.firstNamedChild : a)).filter((a): a is Node => a !== null);
        annotation = types[0] ? readExpr(types[0]) : null;
        for (const meta of types.slice(1, MAX_ARGS)) if (meta.type === "call") params.push({ call: readExpr(meta), type: annotation });
      } else annotation = readExpr(inner);
    } else if (inner) annotation = readExpr(inner);
    const value = p.childForFieldName("value");
    if (value?.type === "call") params.push({ call: readExpr(value), type: annotation });
  }
  return { params, omitted };
}

export function readFacts(root: Node): FastApiFact[] {
  if (root.endIndex > MAX_SOURCE_BYTES) return [{ kind: "too-large", line: 1, column: 1, bytes: root.endIndex }];
  const out: FastApiFact[] = [];
  let broken: { line: number; column: number } | null = null;
  walkScoped(root, (node, scope: Scope) => {
    // A broken region is not read at all, and no fact comes from a node
    // whose subtree holds a syntax error.
    if (node.type === "ERROR" || node.isMissing) {
      broken ??= pos(node);
      return false;
    }
    if (node.hasError && (node.type === "decorated_definition" || node.type === "call" || node.type === "assignment" || node.type === "augmented_assignment" || node.type === "with_item")) {
      if (node.type === "decorated_definition") broken ??= pos(node);
      return;
    }
    switch (node.type) {
      case "decorated_definition": {
        const def = node.childForFieldName("definition");
        if (def?.type !== "function_definition") return;
        const name = def.childForFieldName("name")?.text;
        if (!name) return;
        let deps: { params: ParamDep[]; omitted: number } | null = null;
        for (const d of node.namedChildren) {
          if (d.type !== "decorator") continue;
          const call = d.firstNamedChild;
          if (call?.type !== "call") continue;
          const fn = call.childForFieldName("function");
          if (fn?.type !== "attribute") continue;
          const method = fn.childForFieldName("attribute")?.text ?? "";
          const recv = namePath(fn.childForFieldName("object"));
          if (!recv || !ROUTE_DECORATORS.has(method)) continue;
          const e = readExpr(call);
          if (e.t !== "call") continue;
          deps ??= paramDeps(def);
          out.push({ kind: "route", ...pos(d), recv, method, args: e.args, kw: e.kw, fn: name, def: node.startPosition.row + 1, scope: scope.line, params: deps.params, omitted: deps.omitted });
        }
        return;
      }
      case "call": {
        // A decorator's call is read with its decorated definition.
        if (node.parent?.type === "decorator") return;
        const fn = node.childForFieldName("function");
        if (fn?.type !== "attribute") return;
        const prop = fn.childForFieldName("attribute")?.text ?? "";
        if (!WATCHED.has(prop)) return;
        const e = readExpr(node);
        if (e.t !== "call" || e.fn.t !== "ref") {
          // `TestClient(app).get("/x")`: the receiver is a call.
          if (e.t !== "call") return;
          const recv = readExpr(fn.childForFieldName("object"));
          if (recv.t !== "call") return;
          out.push({ kind: "call", ...pos(node), recv, prop, args: e.args, kw: e.kw, scope: scope.line });
          return;
        }
        out.push({ kind: "call", ...pos(node), recv: { t: "ref", path: e.fn.path.slice(0, -1), line: e.fn.line, column: e.fn.column }, prop, args: e.args, kw: e.kw, scope: scope.line });
        return;
      }
      case "assignment":
      case "augmented_assignment": {
        if (scope.inClass) return;
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        if (left?.type !== "identifier" || !right) return;
        // At module level every assignment is kept (as "other" when the
        // plugin does not read its value), so a constant assigned twice is
        // seen as no constant.
        const value = node.type === "assignment" ? valueExpr(right) : null;
        if (value || scope.line === 0) out.push({ kind: "value", ...pos(node), name: left.text, value: value ?? { t: "other", ...pos(right) }, scope: scope.line });
        return;
      }
      case "with_item": {
        // `with TestClient(app) as client:` binds the client.
        const v = node.childForFieldName("value");
        if (v?.type !== "as_pattern") return;
        const target = v.childForFieldName("alias")?.firstNamedChild;
        const value = v.firstNamedChild;
        if (target?.type !== "identifier" || value?.type !== "call") return;
        out.push({ kind: "value", ...pos(node), name: target.text, value: readExpr(value), scope: scope.line });
        return;
      }
    }
  });
  if (root.hasError) {
    const at: { line: number; column: number } = broken ?? { line: 1, column: 1 };
    out.push({ kind: "syntax-error", line: at.line, column: at.column });
  }
  return out;
}

// The value of an assignment the plugin may need: a call (an application,
// a router, a test client), a name (an alias of one), or a string (a
// constant a route path is built from). Anything else is not read, so a
// module of plain data costs one small fact per module-level name.
function valueExpr(right: Node): Expr | null {
  if (right.type !== "call" && right.type !== "identifier" && right.type !== "attribute" && right.type !== "string" && right.type !== "concatenated_string") return null;
  const e = readExpr(right);
  return e.t === "other" ? null : e;
}

export function isFastApiFact(v: unknown): v is FastApiFact {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  if (!Number.isInteger(f.line) || !Number.isInteger(f.column)) return false;
  switch (f.kind) {
    case "value":
      return typeof f.name === "string" && isExpr(f.value) && Number.isInteger(f.scope);
    case "route":
      return (
        Array.isArray(f.recv) &&
        f.recv.length > 0 &&
        f.recv.every((s) => typeof s === "string") &&
        typeof f.method === "string" &&
        Array.isArray(f.args) &&
        f.args.every((a) => isExpr(a)) &&
        isKws(f.kw) &&
        typeof f.fn === "string" &&
        Number.isInteger(f.def) &&
        Number.isInteger(f.scope) &&
        Array.isArray(f.params) &&
        f.params.every((p) => typeof p === "object" && p !== null && isExpr((p as { call?: unknown }).call) && ((p as { type?: unknown }).type === null || isExpr((p as { type?: unknown }).type))) &&
        Number.isInteger(f.omitted)
      );
    case "call":
      return isExpr(f.recv) && typeof f.prop === "string" && Array.isArray(f.args) && f.args.every((a) => isExpr(a)) && isKws(f.kw) && Number.isInteger(f.scope);
    case "too-large":
      return Number.isInteger(f.bytes);
    case "syntax-error":
      return true;
    default:
      return false;
  }
}
