// One parse of one file yields its local facts: definitions with their spans,
// call sites with what stands before the dot, and imports as written. Nothing
// here looks at another file, so the facts are cached by the file's content
// and every cross-file question is answered later, in resolve.ts.
//
// The node types and fields below are the tree-sitter grammars' own; the
// patterns were written here against the pinned grammar files.
import { createHash } from "node:crypto";
import type { Node, Tree } from "web-tree-sitter";
import type { BoundImport, CallFact, DefFact, FileFacts, ImportFact, Lang, Receiver, TypeRef } from "./types.js";

// Bump when the facts change shape or meaning: every cached file is re-parsed.
// 9: body hashes on definitions, computed-member calls as dynamic call
// sites, and the line of each local export.
export const EXTRACTOR_VERSION = 9;

type Frame = {
  def: number; // the definition this frame belongs to, -1 for none
  cls: string | null; // set on a class or module frame: its qualified name
  locals: Map<string, TypeRef | null> | null; // null: no scope of its own
  fns?: Map<string, number>; // definitions declared in this scope, by name
  imports?: Map<string, BoundImport>; // names an import made in this scope binds
  // A JavaScript block (`{ }`, a loop, a catch clause): `let`, `const` and
  // a nested function land here; `var` and parameters skip it.
  block?: boolean;
};

// A frame once pushed: linked to the one around it, with what every lookup
// from inside it needs worked out once, so nothing copies or scans the chain.
type Scope = Frame & {
  parent: Scope | null;
  depth: number; // 0 for the module
  caller: number; // the nearest enclosing definition, -1 for the top level
  clsScope: Scope | null; // the nearest class or module frame
  inFunction: boolean; // a function frame stands between here and the module
  decl: Scope; // where a `let`, a `const` or a nested function lands: the nearest scope
  fnDecl: Scope; // where a `var`, a parameter or a Python name lands: the nearest that is not a block
};

// Scopes deeper than this are not read: a call there is left unresolved, and
// no lookup walks further out, so deeply nested input stays linear.
const MAX_SCOPE_DEPTH = 256;

// The scope a type name was read in, kept on its TypeRef under a symbol:
// copies made with `{ ...t }` keep it and JSON leaves it out. Ctx.facts()
// turns it into `bound` once every scope has been read. The reading scope is
// the extraction's own state; extraction is synchronous, one file at a time.
// The binding the head name had when the type was read is kept too: an
// object built from an imported class stays that class's object after the
// code assigns the name something else.
const READ_IN = Symbol("readIn");
const READ_AS = Symbol("readAs");
type Stamped = TypeRef & { [READ_IN]?: Scope; [READ_AS]?: { at: Scope; bound: BoundImport } };
let readingScope: Scope | null = null;

function typeRef(t: TypeRef): TypeRef {
  if (!readingScope) return t;
  const s = t as Stamped;
  s[READ_IN] = readingScope;
  const head = t.qualifier ? (t.qualifier.split(".")[0] as string) : t.name;
  const at = lookupIn(readingScope, head);
  const bound = at && !at.fns?.has(head) ? at.imports?.get(head) : undefined;
  if (at && bound) s[READ_AS] = { at, bound };
  return t;
}

// The first scope from `from` outwards that knows `name` as a nested
// definition, a scoped import or a local; null when none does, or when the
// answer lies more than MAX_SCOPE_DEPTH scopes out.
function lookupIn(from: Scope, name: string): Scope | null {
  let s: Scope | null = from;
  for (let steps = 0; s && steps <= MAX_SCOPE_DEPTH; s = s.parent, steps++) {
    if (s.fns?.has(name) || s.imports?.has(name) || s.locals?.has(name)) return s;
  }
  return null;
}

// An identifier before a dot, as the scope `at` (the nearest that knows the
// name) holds it: a local's type, a scoped import, or a name the resolver
// looks up in the file. `topNames` set: the walk is over, and a module-level
// variable hides only names it is not also defined as.
function receiverIn(at: Scope | null, name: string, path: string[], topNames: ReadonlySet<string> | null): Receiver {
  const named: Receiver = { kind: "name", name, path, nesting: null };
  if (!at || at.fns?.has(name)) return named;
  const bound = at.imports?.get(name);
  if (bound) return topNames ? { kind: "name", name, path, nesting: null, bound } : named;
  if (topNames && at.depth === 0 && topNames.has(name)) return named;
  const t = at.locals?.get(name) ?? null;
  return t && !t.elem ? { kind: "type", type: t, path } : { kind: "other" };
}

// An identifier receiver is tagged with what was read where, until Ctx.addCall takes it.
const IDENT = Symbol("ident");
type Ident = { name: string; at: Scope | null; path: string[] };
type Tagged = Receiver & { [IDENT]?: Ident };

type Leave = () => void;

// Depth-first walk with a cursor; only node types in `interesting` become
// Node objects, which keeps a large file cheap. `visit` returns false to skip
// the children or a function to run when the node is left.
function walk(tree: Tree, interesting: ReadonlySet<string>, visit: (node: Node) => Leave | false | void): void {
  const cursor = tree.walk();
  const leaves: { depth: number; fn: Leave }[] = [];
  let depth = 0;
  for (;;) {
    let descend = true;
    if (interesting.has(cursor.nodeType)) {
      const result = visit(cursor.currentNode);
      if (result === false) descend = false;
      else if (typeof result === "function") leaves.push({ depth, fn: result });
    }
    if (descend && cursor.gotoFirstChild()) {
      depth++;
      continue;
    }
    for (;;) {
      while (leaves.length > 0 && (leaves[leaves.length - 1] as { depth: number }).depth === depth) {
        (leaves.pop() as { fn: Leave }).fn();
      }
      if (cursor.gotoNextSibling()) break;
      if (!cursor.gotoParent()) {
        cursor.delete();
        return;
      }
      depth--;
    }
  }
}

function pos(node: Node): { line: number; column: number } {
  return { line: node.startPosition.row + 1, column: node.startPosition.column + 1 };
}

function stringContent(node: Node): string {
  return node.text.replace(/^['"`]|['"`]$/g, "");
}

// A short hash of a definition's text without its own name, its comments
// and its whitespace: the same body under another name or in another file
// hashes the same, so a removal and an addition can be paired as a move.
function bodyHash(lang: Lang, node: Node, nameNode: Node): string {
  const start = node.startIndex;
  const text = node.text;
  const inside = nameNode.startIndex >= start && nameNode.endIndex <= node.endIndex;
  const cut = inside ? text.slice(0, nameNode.startIndex - start) + text.slice(nameNode.endIndex - start) : text;
  const bare = (lang === "python" || lang === "ruby" ? cut.replace(/#[^\n]*/g, "") : cut.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")).replace(/\s+/g, "");
  return createHash("sha1").update(bare).digest("hex").slice(0, 16);
}

class Ctx {
  defs: DefFact[] = [];
  calls: CallFact[] = [];
  imports: ImportFact[] = [];
  exportsLocal: { local: string; exported: string; line?: number }[] = [];
  defaultExport: string | null = null;
  goPackage: string | null = null;
  top: Scope;
  // Calls whose names are bound when the walk ends, each with a reference to
  // its scope: a scope's names are known only once all of it has been read
  // (hoisting in JavaScript, any assignment makes a Python name local).
  private pending: { call: CallFact; scope: Scope; ident: Ident | undefined }[] = [];

  constructor(readonly lang: Lang) {
    const root = { def: -1, cls: null, locals: new Map(), parent: null, depth: 0, caller: -1, clsScope: null, inFunction: false } as unknown as Scope;
    root.decl = root;
    root.fnDecl = root;
    this.top = root;
    readingScope = root;
  }

  push(frame: Frame): Leave {
    const parent = this.top;
    const s = frame as Scope;
    s.parent = parent;
    s.depth = parent.depth + 1;
    s.caller = frame.def >= 0 ? frame.def : parent.caller;
    s.clsScope = frame.cls !== null ? s : parent.clsScope;
    s.inFunction = parent.inFunction || !(frame.block === true || (frame.cls !== null && frame.locals === null));
    s.decl = frame.locals ? s : parent.decl;
    s.fnDecl = frame.locals && !frame.block ? s : parent.fnDecl;
    this.top = s;
    readingScope = s;
    return () => {
      this.top = parent;
      readingScope = parent;
    };
  }

  caller(): number {
    return this.top.caller;
  }

  // The innermost class or module frame, with its definition.
  cls(): Scope | null {
    return this.top.clsScope;
  }

  // True when no function frame stands between here and the module. A block
  // at the top of the module (an `if`, a `try`) keeps its definitions top level.
  atModuleLevel(): boolean {
    return !this.top.inFunction;
  }

  lookup(from: Scope, name: string): Scope | null {
    return lookupIn(from, name);
  }

  // The type of a local, null for a local of unknown type, undefined when
  // the nearest scope that knows the name does not hold it as a local.
  local(name: string): TypeRef | null | undefined {
    const at = this.lookup(this.top, name);
    if (!at || at.fns?.has(name) || at.imports?.has(name)) return undefined;
    return at.locals?.get(name) ?? null;
  }

  // An identifier before a dot, read at this point of the walk: a local's
  // type here keeps the flow of assignments so far. Ctx.facts() reads the
  // name again once every scope is complete: a nearer scope that declares
  // it later wins, and an import is decided only then.
  identReceiver(name: string, path: string[]): Receiver {
    const at = this.lookup(this.top, name);
    const recv = receiverIn(at, name, path, null) as Tagged;
    recv[IDENT] = { name, at, path };
    return recv;
  }

  // A declaration: the name is new in its scope (`block`: a `let` or
  // `const`, else the function's scope), and no longer an import there.
  setLocal(name: string, type: TypeRef | null, block = false): void {
    const at = block ? this.top.decl : this.top.fnDecl;
    at.imports?.delete(name);
    at.locals?.set(name, type);
  }

  // An import. At the top of the module its names are the file's; made
  // inside a function or a block, they belong to that scope only, so a call
  // elsewhere in the file never resolves through them.
  addImport(fact: ImportFact, block = false): void {
    const at = block ? this.top.decl : this.top.fnDecl;
    const index = this.imports.length;
    this.imports.push(fact);
    if (at.depth === 0) return;
    fact.scoped = true;
    at.imports ??= new Map();
    for (const n of fact.names) at.imports.set(n.local, { import: index, imported: n.imported });
    if (fact.namespace) at.imports.set(fact.namespace, { import: index, imported: "*" });
  }

  // An assignment to a name that may exist already. A declared type stands;
  // otherwise the receiver evidence survives only when the new value has the
  // same type, since either value may reach a later call. A name an import
  // bound and the code then assigns is a local of unknown value: the import
  // is no longer evidence for any call to it.
  // `innermost`: Python, where assigning in a function makes a new local.
  assign(name: string, type: TypeRef | null, innermost = false): void {
    let s: Scope | null = this.top;
    for (let steps = 0; s && steps <= MAX_SCOPE_DEPTH; s = s.parent, steps++) {
      if (innermost && !s.locals) continue;
      if (s.imports?.has(name)) {
        s.imports.delete(name);
        s.locals?.set(name, null);
        return;
      }
      if (innermost && !s.locals?.has(name)) break;
      const locals = s.locals;
      if (locals?.has(name)) {
        const old = locals.get(name) ?? null;
        if (old?.declared) return;
        const same = old !== null && type !== null && old.name === type.name && old.qualifier === type.qualifier && !old.elem === !type.elem && old.result === type.result;
        locals.set(name, same ? old : null);
        return;
      }
    }
    this.setLocal(name, type);
  }

  // A nested definition is visible by name in the scope that declares it:
  // its block for a function declaration or a `let` or `const`, the whole
  // function for a `var` (`block` false).
  declareFn(name: string, def: number, block = true): void {
    const at = block ? this.top.decl : this.top.fnDecl;
    if (at.depth === 0) return;
    at.fns ??= new Map();
    at.fns.set(name, def);
  }

  // The enclosing definition, as an owner for a nested one.
  ownerName(): string | null {
    const def = this.caller();
    if (def < 0) return null;
    const d = this.defs[def] as DefFact;
    return d.owner ? `${d.owner}.${d.name}` : d.name;
  }

  addDef(node: Node, nameNode: Node, kind: DefFact["kind"], fields: Partial<DefFact> = {}, spanNode: Node = node): number {
    const { column } = pos(nameNode);
    // Only definitions at the top of the file or directly in a top-level
    // class get a body hash: hashing every nested one would read deep code
    // once per level.
    const hash = this.top.depth <= 2 ? bodyHash(this.lang, spanNode, nameNode) : undefined;
    this.defs.push({
      name: nameNode.text,
      kind,
      owner: null,
      line: spanNode.startPosition.row + 1,
      column,
      endLine: spanNode.endPosition.row + 1,
      exported: false,
      topLevel: false,
      bases: [],
      fields: {},
      ...fields,
      ...(hash ? { bodyHash: hash } : {}),
    });
    return this.defs.length - 1;
  }

  // A call whose callee is computed (`table[key]()`): no name to bind, so
  // the resolver records it as a dynamic call site the graph cannot follow.
  addDynamicCall(node: Node): void {
    const { line, column } = pos(node);
    this.calls.push({ name: "", line, column, caller: this.caller(), recv: { kind: "other" }, dynamic: true });
  }

  addCall(nameNode: Node, recv: Receiver, implicit = false): void {
    const { line, column } = pos(nameNode);
    const call: CallFact = { name: nameNode.text, line, column, caller: this.caller(), recv };
    if (implicit) call.implicit = true;
    const callerDef = call.caller >= 0 ? this.defs[call.caller] : undefined;
    if (callerDef?.static || callerDef?.kind === "class" || callerDef?.kind === "module") call.static = true;
    this.calls.push(call);
    const ident = (recv as Tagged)[IDENT];
    if (ident) delete (recv as Tagged)[IDENT];
    if (this.lang === "ruby") return;
    // Past the depth bound the scopes around a call are not read: the safe
    // reading is a call nothing binds, never one bound past a scope that hides it.
    if (this.top.depth > MAX_SCOPE_DEPTH) {
      call.recv = { kind: "other" };
      if (recv.kind === "none") call.shadowed = true;
      return;
    }
    // A Go receiver name is decided where it is read (identReceiver is not
    // used for Go): no Go name is hoisted.
    if (recv.kind === "none" || ident) this.pending.push({ call, scope: this.top, ident });
  }

  facts(): FileFacts {
    readingScope = null;
    const topNames = new Set(this.defs.filter((d) => d.topLevel).map((d) => d.name));
    for (const { call, scope, ident } of this.pending) {
      if (ident) {
        // The name read again with every scope complete. The same scope
        // answering keeps the type the walk had at the call; a nearer scope
        // that declared the name later decides instead.
        const at = this.lookup(scope, ident.name);
        if (at !== ident.at || call.recv.kind === "name") call.recv = receiverIn(at, ident.name, ident.path, topNames);
        continue;
      }
      const at = this.lookup(scope, call.name);
      if (!at) continue;
      const fn = at.fns?.get(call.name);
      const bound = at.imports?.get(call.name);
      if (fn !== undefined) call.local = fn;
      else if (bound) call.bound = bound;
      // A module-level variable hides only names it is not also defined as.
      else if (at.depth > 0 || !topNames.has(call.name)) call.shadowed = true;
    }
    this.pending = [];
    // Each type name binds through the scope it was read in: what that scope
    // holds now, or the import it held when the type was read if the code
    // assigned the name something else after.
    const bindType = (t: TypeRef | null | undefined) => {
      const s = t as Stamped | null | undefined;
      const at = s?.[READ_IN];
      if (!s || !at) return;
      const readAs = s[READ_AS];
      delete s[READ_IN];
      delete s[READ_AS];
      const head = s.qualifier ? (s.qualifier.split(".")[0] as string) : s.name;
      const found = this.lookup(at, head);
      let bound = found && !found.fns?.has(head) ? found.imports?.get(head) : undefined;
      if (!bound && readAs && found === readAs.at) bound = readAs.bound;
      if (bound) s.bound = bound;
    };
    for (const d of this.defs) {
      d.bases.forEach(bindType);
      Object.values(d.fields).forEach(bindType);
      d.results?.forEach(bindType);
    }
    for (const c of this.calls) if (c.recv.kind === "type") bindType(c.recv.type);
    return {
      lang: this.lang,
      defs: this.defs,
      calls: this.calls,
      imports: this.imports,
      exportsLocal: this.exportsLocal,
      defaultExport: this.defaultExport,
      goPackage: this.goPackage,
    };
  }
}

// ---------- TypeScript, TSX, JavaScript ----------

const JS_TYPES = new Set([
  "import_statement",
  "export_statement",
  "function_declaration",
  "generator_function_declaration",
  "class_declaration",
  "abstract_class_declaration",
  "method_definition",
  "public_field_definition",
  "field_definition",
  "variable_declarator",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
  "arrow_function",
  "function_expression",
  "function",
  "generator_function",
  "call_expression",
  "new_expression",
  "assignment_expression",
  "jsx_opening_element",
  "jsx_self_closing_element",
  "for_in_statement",
  "for_statement",
  "statement_block",
  "switch_body",
  "catch_clause",
]);

function jsTypeRef(annotation: Node | null): TypeRef | null {
  if (!annotation) return null;
  let t: Node | null = annotation.type === "type_annotation" ? annotation.firstNamedChild : annotation;
  if (t?.type === "union_type") {
    // `Repo | undefined` is a Repo wherever a method is called on it.
    const named = t.namedChildren.filter((m) => !/^(undefined|null)$/.test(m.text));
    return named.length === 1 ? jsTypeRef(named[0] as Node) : null;
  }
  if (t?.type === "array_type") {
    const inner = jsTypeRef(t.firstNamedChild);
    return inner ? { ...inner, elem: true } : null;
  }
  if (t?.type === "generic_type") {
    const head = t.childForFieldName("name")?.text;
    const arg = t.childForFieldName("type_arguments")?.firstNamedChild ?? null;
    // Promise<T> is a T once awaited; Array<T> and its kin hold T.
    if (head === "Promise") return jsTypeRef(arg);
    if (head === "Array" || head === "ReadonlyArray" || head === "Set" || head === "ReadonlySet") {
      const inner = jsTypeRef(arg);
      return inner ? { ...inner, elem: true } : null;
    }
    t = t.childForFieldName("name");
  }
  if (!t) return null;
  const { line, column } = pos(t);
  if (t.type === "type_identifier" || t.type === "identifier") return typeRef({ name: t.text, qualifier: null, line, column });
  if (t.type === "nested_type_identifier" || t.type === "member_expression") {
    const name = t.childForFieldName("name") ?? t.childForFieldName("property");
    const module = t.childForFieldName("module") ?? t.childForFieldName("object");
    if (name && module) return typeRef({ name: name.text, qualifier: module.text, line, column });
  }
  return null;
}

// The receiver of `a.b.c()`: the object `a.b` flattened to a base and a path.
function jsReceiver(ctx: Ctx, object: Node): Receiver {
  const path: string[] = [];
  let base: Node | null = object;
  while (base && base.type === "member_expression") {
    const prop = base.childForFieldName("property");
    if (!prop) return { kind: "other" };
    path.unshift(prop.text);
    base = base.childForFieldName("object");
  }
  if (!base) return { kind: "other" };
  if (base.type === "this") return { kind: "self", path };
  if (base.type === "super") return path.length === 0 ? { kind: "super" } : { kind: "other" };
  if (base.type === "parenthesized_expression" && base.firstNamedChild?.type === "new_expression") base = base.firstNamedChild;
  if (base.type === "new_expression") {
    const type = newType(base);
    return type ? { kind: "type", type, path } : { kind: "other" };
  }
  if (base.type === "call_expression" || base.type === "await_expression") {
    const type = callType(base);
    return type ? { kind: "type", type, path } : { kind: "other" };
  }
  if (base.type === "identifier") {
    return ctx.identReceiver(base.text, path);
  }
  return { kind: "other" };
}

function jsCallee(ctx: Ctx, fn: Node | null): void {
  if (!fn) return;
  if (fn.type === "instantiation_expression") return jsCallee(ctx, fn.childForFieldName("function"));
  if (fn.type === "await_expression") return jsCallee(ctx, fn.firstNamedChild);
  if (fn.type === "parenthesized_expression") return;
  if (fn.type === "subscript_expression") {
    ctx.addDynamicCall(fn);
    return;
  }
  if (fn.type === "identifier") {
    if (fn.text !== "require") ctx.addCall(fn, { kind: "none" });
    return;
  }
  if (fn.type === "member_expression") {
    const prop = fn.childForFieldName("property");
    const object = fn.childForFieldName("object");
    if (prop && object) ctx.addCall(prop, jsReceiver(ctx, object));
  }
}

// A type from an annotation: a reassignment cannot change it.
function declared(t: TypeRef | null): TypeRef | null {
  return t ? { ...t, declared: true } : null;
}

function isStatic(node: Node): boolean {
  return node.children.some((c) => c.type === "static");
}

function jsParams(ctx: Ctx, fn: Node, locals: Map<string, TypeRef | null>): void {
  const params = fn.childForFieldName("parameters");
  if (!params) {
    const single = fn.childForFieldName("parameter"); // x => ...
    if (single?.type === "identifier") locals.set(single.text, null);
    return;
  }
  for (const p of params.namedChildren) {
    if (p.type === "identifier") {
      locals.set(p.text, null);
      continue;
    }
    // TypeScript wraps each parameter and names its pattern; JavaScript does not.
    const pattern = p.childForFieldName("pattern");
    if (pattern?.type === "identifier") locals.set(pattern.text, declared(jsTypeRef(p.childForFieldName("type"))));
    else for (const name of patternNames(pattern ?? p)) locals.set(name, null);
  }
}

// The names a destructuring pattern binds: `{ a, b: c, d = 1, ...e }`,
// `[f, [g] = h]`, Python `a, (b, *c)`. A target that is not a name (`x.y`,
// `x[0]`) binds nothing.
function patternNames(node: Node | null, out: string[] = []): string[] {
  if (!node) return out;
  switch (node.type) {
    case "identifier":
    case "shorthand_property_identifier_pattern":
      out.push(node.text);
      break;
    case "pair_pattern":
      patternNames(node.childForFieldName("value"), out);
      break;
    case "assignment_pattern":
    case "object_assignment_pattern":
      patternNames(node.childForFieldName("left"), out);
      break;
    case "object_pattern":
    case "array_pattern":
    case "rest_pattern":
    case "pattern_list":
    case "tuple_pattern":
    case "list_pattern":
    case "list_splat_pattern":
      for (const c of node.namedChildren) patternNames(c, out);
      break;
  }
  return out;
}

function isExportedDecl(node: Node): boolean {
  let p = node.parent;
  if (node.type === "variable_declarator") p = p?.parent ?? null;
  return p?.type === "export_statement";
}

function jsImport(ctx: Ctx, node: Node): void {
  const source = node.childForFieldName("source");
  if (!source) return;
  const fact: ImportFact = {
    spec: stringContent(source),
    ...pos(node),
    names: [],
    namespace: null,
    star: false,
    reexport: false,
    typeOnly: node.children.some((c) => c.type === "type"),
  };
  const clause = node.namedChildren.find((c) => c.type === "import_clause");
  for (const part of clause?.namedChildren ?? []) {
    if (part.type === "identifier") fact.names.push({ imported: "default", local: part.text });
    else if (part.type === "namespace_import") fact.namespace = part.firstNamedChild?.text ?? null;
    else if (part.type === "named_imports") {
      for (const s of part.namedChildren) {
        if (s.type !== "import_specifier") continue;
        const name = s.childForFieldName("name");
        const alias = s.childForFieldName("alias");
        if (name) fact.names.push({ imported: name.text, local: (alias ?? name).text });
      }
    }
  }
  ctx.imports.push(fact);
}

function jsExport(ctx: Ctx, node: Node): void {
  const source = node.childForFieldName("source");
  const clause = node.namedChildren.find((c) => c.type === "export_clause");
  const specs = (clause?.namedChildren ?? []).filter((s) => s.type === "export_specifier");
  if (source) {
    const fact: ImportFact = {
      spec: stringContent(source),
      ...pos(node),
      names: [],
      namespace: null,
      star: false,
      reexport: true,
      typeOnly: node.children.some((c) => c.type === "type"),
    };
    const ns = node.namedChildren.find((c) => c.type === "namespace_export");
    if (ns) fact.names.push({ imported: "*", local: ns.firstNamedChild?.text ?? "" });
    else if (!clause) fact.star = true;
    for (const s of specs) {
      const name = s.childForFieldName("name");
      const alias = s.childForFieldName("alias");
      if (name) fact.names.push({ imported: name.text, local: (alias ?? name).text });
    }
    ctx.imports.push(fact);
    return;
  }
  for (const s of specs) {
    const name = s.childForFieldName("name");
    const alias = s.childForFieldName("alias");
    if (name) ctx.exportsLocal.push({ local: name.text, exported: (alias ?? name).text, line: s.startPosition.row + 1 });
  }
  if (node.children.some((c) => c.type === "default")) {
    const decl = node.childForFieldName("declaration");
    const named = decl?.childForFieldName("name");
    const value = node.childForFieldName("value");
    if (named) ctx.defaultExport = named.text;
    else if (value?.type === "identifier") ctx.defaultExport = value.text;
  }
}

function isDefaultExport(node: Node): boolean {
  return node.parent?.type === "export_statement" && node.parent.children.some((c) => c.type === "default");
}

// CommonJS exports: `module.exports = { a, b: c }`, `module.exports = a`,
// `module.exports.x = a`, `exports.x = a`, `exports.x = function () {}`.
function jsCommonExport(ctx: Ctx, node: Node, left: Node, right: Node | null): Leave | boolean {
  if (!right || !ctx.atModuleLevel() || ctx.caller() >= 0) return false;
  const target = left.text.replace(/\s+/g, "");
  if (target === "module.exports") {
    if (right.type === "identifier") ctx.defaultExport = right.text;
    for (const p of right.type === "object" ? right.namedChildren : []) {
      if (p.type === "shorthand_property_identifier") ctx.exportsLocal.push({ local: p.text, exported: p.text, line: p.startPosition.row + 1 });
      else if (p.type === "pair") {
        const key = p.childForFieldName("key");
        const value = p.childForFieldName("value");
        if (key && value?.type === "identifier") ctx.exportsLocal.push({ local: value.text, exported: key.text, line: p.startPosition.row + 1 });
      }
    }
    return true;
  }
  const m = /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/.exec(target);
  if (!m) return false;
  const name = m[1] as string;
  if (right.type === "identifier") {
    ctx.exportsLocal.push({ local: right.text, exported: name, line: node.startPosition.row + 1 });
    return true;
  }
  if (["arrow_function", "function_expression", "function"].includes(right.type)) {
    const prop = left.childForFieldName("property") as Node;
    const def = ctx.addDef(node, prop, "function", { topLevel: true, exported: true, results: jsResults(right) });
    return ctx.push({ def, cls: null, locals: null });
  }
  return false;
}

// `const x = require("./m")` and `const { a, b: c } = require("./m")`, and the
// same with `await import("./m")`. Inside a function or a block the names
// belong to that scope (`block`: a `let` or `const`). Without `await` the
// value is a promise, not the module, so it is not an import.
function jsRequire(ctx: Ctx, node: Node, nameNode: Node, value: Node, block: boolean): boolean {
  const awaited = value.type === "await_expression";
  const call = awaited ? value.firstNamedChild : value;
  if (call?.type !== "call_expression") return false;
  const fn = call.childForFieldName("function");
  if (awaited ? fn?.type !== "import" : fn?.text !== "require") return false;
  const arg = call.childForFieldName("arguments")?.firstNamedChild;
  if (arg?.type !== "string") return false;
  const fact: ImportFact = { spec: stringContent(arg), ...pos(node), names: [], namespace: null, star: false, reexport: false, typeOnly: false };
  if (nameNode.type === "identifier") fact.namespace = nameNode.text;
  else if (nameNode.type === "object_pattern") {
    for (const p of nameNode.namedChildren) {
      const key = p.type === "pair_pattern" ? p.childForFieldName("key") : null;
      const val = p.type === "pair_pattern" ? p.childForFieldName("value") : null;
      if (p.type === "shorthand_property_identifier_pattern") fact.names.push({ imported: p.text, local: p.text });
      else if (key && val?.type === "identifier") fact.names.push({ imported: key.text, local: val.text });
      // A default value or a nested pattern: a local whose value is not known.
      else for (const name of patternNames(p)) ctx.setLocal(name, null, block);
    }
  }
  ctx.addImport(fact, block);
  return true;
}

function newType(value: Node | null): TypeRef | null {
  if (value?.type !== "new_expression") return null;
  const ctor = value.childForFieldName("constructor");
  return ctor ? jsTypeRef(ctor) : null;
}

// `make()`, `await make()`, `ns.make()`: typed by make's declared return type,
// looked up when the graph is resolved.
function callType(value: Node | null): TypeRef | null {
  let v = value;
  if (v?.type === "await_expression") v = v.firstNamedChild;
  if (v?.type !== "call_expression") return null;
  const fn = v.childForFieldName("function");
  if (fn?.type === "identifier") return typeRef({ name: fn.text, qualifier: null, ...pos(fn), result: 0 });
  if (fn?.type === "member_expression" && fn.childForFieldName("object")?.type === "identifier") {
    const prop = fn.childForFieldName("property");
    const object = fn.childForFieldName("object") as Node;
    if (prop) return typeRef({ name: prop.text, qualifier: object.text, ...pos(fn), result: 0 });
  }
  return null;
}

function jsResults(fn: Node): TypeRef[] | undefined {
  const r = jsTypeRef(fn.childForFieldName("return_type"));
  return r ? [r] : undefined;
}

function extractJs(tree: Tree, lang: Lang): FileFacts {
  const ctx = new Ctx(lang);
  const fnFrame = (node: Node, def: number): Leave => {
    const locals = new Map<string, TypeRef | null>();
    jsParams(ctx, node, locals);
    return ctx.push({ def, cls: null, locals });
  };
  walk(tree, JS_TYPES, (node) => {
    switch (node.type) {
      case "import_statement":
        jsImport(ctx, node);
        return false;
      case "export_statement":
        jsExport(ctx, node);
        return;
      case "function_declaration":
      case "generator_function_declaration": {
        const name = node.childForFieldName("name");
        if (!name) return fnFrame(node, -1);
        const top = ctx.atModuleLevel();
        const owner = top ? null : ctx.ownerName();
        const def = ctx.addDef(node, name, "function", { owner, topLevel: top, exported: isExportedDecl(node) && !isDefaultExport(node), results: jsResults(node) });
        if (!top) ctx.declareFn(name.text, def);
        return fnFrame(node, def);
      }
      case "class_declaration":
      case "abstract_class_declaration": {
        const name = node.childForFieldName("name");
        if (!name) return;
        const bases: TypeRef[] = [];
        const heritage = node.namedChildren.find((c) => c.type === "class_heritage");
        for (const h of heritage?.namedChildren ?? []) {
          // TypeScript wraps the base in extends_clause; JavaScript does not.
          const value = h.type === "extends_clause" ? h.childForFieldName("value") : h.type === "implements_clause" ? null : h;
          const ref = value ? jsTypeRef(value) : null;
          if (ref) bases.push(ref);
        }
        const def = ctx.addDef(node, name, "class", { topLevel: ctx.atModuleLevel(), exported: isExportedDecl(node) && !isDefaultExport(node), bases });
        return ctx.push({ def, cls: name.text, locals: null });
      }
      case "method_definition": {
        const name = node.childForFieldName("name");
        const cls = ctx.cls();
        if (!name || name.type === "computed_property_name" || node.parent?.type !== "class_body" || !cls) {
          return fnFrame(node, -1);
        }
        const def = ctx.addDef(node, name, "method", { owner: cls.cls, exported: true, results: jsResults(node), static: isStatic(node) });
        if (name.text === "constructor") {
          // Parameter properties: constructor(private repo: Repo) declares a field.
          const fields = (ctx.defs[cls.def] as DefFact).fields;
          for (const p of node.childForFieldName("parameters")?.namedChildren ?? []) {
            const isProperty = p.namedChildren.some((c) => c.type === "accessibility_modifier") || p.children.some((c) => c.type === "readonly");
            const pattern = p.childForFieldName("pattern");
            const type = jsTypeRef(p.childForFieldName("type"));
            if (isProperty && pattern?.type === "identifier" && type) fields[pattern.text] = type;
          }
        }
        return fnFrame(node, def);
      }
      case "public_field_definition":
      case "field_definition": {
        const name = node.childForFieldName("name") ?? node.childForFieldName("property");
        const cls = ctx.cls();
        if (!name || !cls) return;
        const value = node.childForFieldName("value");
        const type = jsTypeRef(node.childForFieldName("type")) ?? newType(value);
        if (type) (ctx.defs[cls.def] as DefFact).fields[name.text] = type;
        if (value && (value.type === "arrow_function" || value.type === "function_expression")) {
          const def = ctx.addDef(node, name, "method", { owner: cls.cls, exported: true, static: isStatic(node) });
          return ctx.push({ def, cls: null, locals: null });
        }
        return;
      }
      case "variable_declarator": {
        const name = node.childForFieldName("name");
        const value = node.childForFieldName("value");
        if (!name) return;
        // `let` and `const` belong to their block, `var` to its function.
        const block = node.parent?.type !== "variable_declaration";
        // The walk goes on into the declarator either way: a default value
        // such as `{ a = fallback() }` holds calls of its own.
        if (value && jsRequire(ctx, node, name, value, block)) return;
        if (name.type !== "identifier") {
          // `const { a } = x`, `const [b] = y`: each name is a local of its
          // scope and hides a definition of the same name outside it.
          for (const n of patternNames(name)) ctx.setLocal(n, null, block);
          return;
        }
        const isFn = value && ["arrow_function", "function_expression", "function", "generator_function"].includes(value.type);
        const parent = node.parent;
        const moduleLevel = (parent?.parent?.type === "program" || parent?.parent?.type === "export_statement") && ctx.atModuleLevel();
        if (isFn && moduleLevel) {
          const def = ctx.addDef(node, name, "function", { topLevel: true, exported: isExportedDecl(node), results: jsResults(value as Node) });
          return ctx.push({ def, cls: null, locals: null });
        }
        if (isFn && ctx.caller() >= 0) {
          // const inner = () => ... inside a function: a definition of that scope.
          const def = ctx.addDef(node, name, "function", { owner: ctx.ownerName(), results: jsResults(value as Node) });
          ctx.declareFn(name.text, def, block);
          return ctx.push({ def, cls: null, locals: null });
        }
        ctx.setLocal(name.text, declared(jsTypeRef(node.childForFieldName("type"))) ?? newType(value) ?? callType(value), block);
        return;
      }
      case "statement_block":
      case "switch_body":
      case "for_statement":
        return ctx.push({ def: -1, cls: null, locals: new Map(), block: true });
      case "catch_clause": {
        const leave = ctx.push({ def: -1, cls: null, locals: new Map(), block: true });
        for (const n of patternNames(node.childForFieldName("parameter"))) ctx.setLocal(n, null, true);
        return leave;
      }
      case "interface_declaration":
      case "type_alias_declaration":
      case "enum_declaration": {
        const name = node.childForFieldName("name");
        if (name) ctx.addDef(node, name, "type", { topLevel: ctx.atModuleLevel(), exported: isExportedDecl(node) });
        return false;
      }
      case "arrow_function":
      case "function_expression":
      case "function":
      case "generator_function":
        return fnFrame(node, -1);
      case "call_expression": {
        const fn = node.childForFieldName("function");
        if (fn?.type === "import") return;
        jsCallee(ctx, fn);
        return;
      }
      case "new_expression":
        jsCallee(ctx, node.childForFieldName("constructor"));
        return;
      case "assignment_expression": {
        // this.repo = new Repo() in a method declares the field's type.
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        const type = newType(right);
        if (left?.type === "identifier") {
          ctx.assign(left.text, type ?? callType(right));
          return;
        }
        // `({ f } = deps)`, `[a, b] = list`: each name gets a value whose type is not known.
        if (left?.type === "object_pattern" || left?.type === "array_pattern") {
          for (const n of patternNames(left)) ctx.assign(n, null);
          return;
        }
        if (left?.type === "member_expression") {
          const exported = jsCommonExport(ctx, node, left, right);
          if (exported) return typeof exported === "function" ? exported : undefined;
        }
        const cls = ctx.cls();
        if (type && cls && left?.type === "member_expression" && left.childForFieldName("object")?.type === "this") {
          const prop = left.childForFieldName("property");
          if (prop) (ctx.defs[cls.def] as DefFact).fields[prop.text] = type;
        }
        return;
      }
      case "for_in_statement": {
        // for (const op of ops): op is an element of ops. A `let` or
        // `const` loop variable belongs to the loop, a `var` to its function;
        // with neither, the loop assigns a name declared elsewhere.
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        const t = right?.type === "identifier" && node.children.some((c) => c.type === "of") ? ctx.local(right.text) : null;
        const type = left?.type === "identifier" && t?.elem ? { ...t, elem: false } : null;
        const kind = node.children.find((c) => c.type === "var" || c.type === "let" || c.type === "const")?.type;
        const leave = ctx.push({ def: -1, cls: null, locals: new Map(), block: true });
        for (const n of patternNames(left)) {
          if (kind === undefined) ctx.assign(n, type);
          else ctx.setLocal(n, type, kind !== "var");
        }
        return leave;
      }
      case "jsx_opening_element":
      case "jsx_self_closing_element": {
        const name = node.childForFieldName("name");
        if (name?.type === "identifier" && /^[A-Z]/.test(name.text)) ctx.addCall(name, { kind: "none" });
        else if (name?.type === "member_expression") jsCallee(ctx, name);
        return;
      }
    }
  });
  // A definition is exported under its own name only through `export` on it
  // or `export { x }`; `export default` and `export { x as y }` export it
  // under another name, which the resolver reads from the export table.
  const exported = new Set(ctx.exportsLocal.filter((e) => e.local === e.exported).map((e) => e.local));
  for (const d of ctx.defs) if (d.topLevel && exported.has(d.name)) d.exported = true;
  return ctx.facts();
}

// ---------- Python ----------

const PY_TYPES = new Set([
  "for_statement",
  "import_statement",
  "import_from_statement",
  "class_definition",
  "function_definition",
  "lambda",
  "assignment",
  "call",
]);

function pyTypeRef(node: Node | null): TypeRef | null {
  let t = node;
  if (t?.type === "type") t = t.firstNamedChild;
  if (!t) return null;
  // `Repo | None` and `Optional[Repo]` are a Repo wherever a method is called on it.
  if (t.type === "binary_operator" && t.childForFieldName("operator")?.text === "|") {
    const sides = [t.childForFieldName("left"), t.childForFieldName("right")].filter((x): x is Node => x !== null && x.type !== "none");
    return sides.length === 1 ? pyTypeRef(sides[0] as Node) : null;
  }
  if (t.type === "generic_type" || t.type === "subscript") {
    const head = t.type === "subscript" ? t.childForFieldName("value") : t.firstNamedChild;
    const args = t.type === "subscript" ? t.childrenForFieldName("subscript") : (t.namedChildren[1]?.namedChildren ?? []);
    if (head?.text === "Optional" && args.length === 1) return pyTypeRef(args[0] as Node);
    if (args.length === 1 && /^(list|List|set|Set|Sequence|Iterable|Iterator|frozenset|FrozenSet)$/.test(head?.text ?? "")) {
      const inner = pyTypeRef(args[0] as Node);
      return inner ? { ...inner, elem: true } : null;
    }
    return null;
  }
  const { line, column } = pos(t);
  if (t.type === "identifier") return typeRef({ name: t.text, qualifier: null, line, column });
  if (t.type === "attribute") {
    const attr = t.childForFieldName("attribute");
    const object = t.childForFieldName("object");
    if (attr && object) return typeRef({ name: attr.text, qualifier: object.text, line, column });
  }
  if (t.type === "string") {
    const text = stringContent(t);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) return typeRef({ name: text, qualifier: null, line, column });
  }
  return null;
}

function pyReceiver(ctx: Ctx, object: Node): Receiver {
  const path: string[] = [];
  let base: Node | null = object;
  while (base && base.type === "attribute") {
    const attr = base.childForFieldName("attribute");
    if (!attr) return { kind: "other" };
    path.unshift(attr.text);
    base = base.childForFieldName("object");
  }
  if (!base) return { kind: "other" };
  if (base.type === "call" && base.childForFieldName("function")?.text === "super") {
    return path.length === 0 ? { kind: "super" } : { kind: "other" };
  }
  if (base.type === "call") {
    // Repo().find(): the receiver is what the call constructs, when it names a class.
    const type = pyCallType(base);
    return type ? { kind: "type", type, path } : { kind: "other" };
  }
  if (base.type !== "identifier") return { kind: "other" };
  if ((base.text === "self" || base.text === "cls") && ctx.cls()) return { kind: "self", path };
  return ctx.identReceiver(base.text, path);
}

function pyCallType(value: Node | null): TypeRef | null {
  if (value?.type !== "call") return null;
  return pyTypeRef(value.childForFieldName("function"));
}

function extractPython(tree: Tree): FileFacts {
  const ctx = new Ctx("python");
  walk(tree, PY_TYPES, (node) => {
    switch (node.type) {
      case "import_statement": {
        for (const n of node.namedChildren) {
          const fact: ImportFact = { spec: "", ...pos(node), names: [], namespace: null, star: false, reexport: false, typeOnly: false };
          if (n.type === "dotted_name") {
            // `import a.b` binds `a`; the rest is reached as attributes.
            fact.spec = n.text;
            fact.namespace = n.text.split(".")[0] ?? null;
          } else if (n.type === "aliased_import") {
            fact.spec = n.childForFieldName("name")?.text ?? "";
            fact.namespace = n.childForFieldName("alias")?.text ?? null;
            fact.alias = true;
          } else continue;
          ctx.addImport(fact);
        }
        return false;
      }
      case "import_from_statement": {
        const module = node.childForFieldName("module_name");
        if (!module) return false;
        const fact: ImportFact = { spec: module.text, ...pos(node), names: [], namespace: null, star: false, reexport: false, typeOnly: false };
        for (const n of node.childrenForFieldName("name")) {
          if (n.type === "dotted_name") fact.names.push({ imported: n.text, local: n.text });
          else if (n.type === "aliased_import") {
            const name = n.childForFieldName("name");
            const alias = n.childForFieldName("alias");
            if (name && alias) fact.names.push({ imported: name.text, local: alias.text });
          }
        }
        if (node.namedChildren.some((c) => c.type === "wildcard_import")) fact.star = true;
        ctx.addImport(fact);
        return false;
      }
      case "class_definition": {
        const name = node.childForFieldName("name");
        if (!name) return;
        const bases: TypeRef[] = [];
        for (const b of node.childForFieldName("superclasses")?.namedChildren ?? []) {
          const ref = pyTypeRef(b);
          if (ref) bases.push(ref);
        }
        const span = node.parent?.type === "decorated_definition" ? node.parent : node;
        const top = ctx.atModuleLevel();
        const cls = ctx.cls();
        const def = ctx.addDef(node, name, "class", { topLevel: top, exported: !name.text.startsWith("_"), bases, owner: cls?.cls ?? null }, span);
        return ctx.push({ def, cls: name.text, locals: null });
      }
      case "function_definition": {
        const name = node.childForFieldName("name");
        const span = node.parent?.type === "decorated_definition" ? node.parent : node;
        const inner = ctx.top;
        const isMethod = inner.cls !== null && inner.locals === null;
        const locals = new Map<string, TypeRef | null>();
        for (const p of node.childForFieldName("parameters")?.namedChildren ?? []) {
          if (p.type === "identifier") locals.set(p.text, null);
          else if (p.type === "typed_parameter") {
            const id = p.namedChildren.find((c) => c.type === "identifier");
            if (id) locals.set(id.text, declared(pyTypeRef(p.childForFieldName("type"))));
          } else {
            const id = p.childForFieldName("name");
            if (id) locals.set(id.text, declared(pyTypeRef(p.childForFieldName("type"))));
          }
        }
        if (!name) return ctx.push({ def: -1, cls: null, locals });
        const top = ctx.atModuleLevel() && !isMethod;
        const nested = !top && !isMethod;
        const def = ctx.addDef(
          node,
          name,
          isMethod ? "method" : "function",
          {
            owner: isMethod ? inner.cls : nested ? ctx.ownerName() : null,
            topLevel: top,
            exported: !name.text.startsWith("_") || /^__\w+__$/.test(name.text),
            results: (() => {
              const r = pyTypeRef(node.childForFieldName("return_type"));
              return r ? [r] : undefined;
            })(),
          },
          span,
        );
        if (nested) ctx.declareFn(name.text, def);
        return ctx.push({ def, cls: null, locals });
      }
      case "lambda":
        return ctx.push({ def: -1, cls: null, locals: new Map() });
      case "for_statement": {
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        if (left?.type !== "identifier") {
          // `for a, b in pairs`: each name is a local whose type is not known.
          for (const n of patternNames(left)) ctx.setLocal(n, null);
          return;
        }
        const t = right?.type === "identifier" ? ctx.local(right.text) : null;
        ctx.setLocal(left.text, t?.elem ? { ...t, elem: false } : null);
        return;
      }
      case "assignment": {
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        const annotation = declared(pyTypeRef(node.childForFieldName("type")));
        const type = annotation ?? pyCallType(right);
        const inner = ctx.top;
        if (left?.type === "identifier") {
          if (inner.cls !== null && inner.locals === null) {
            if (type) (ctx.defs[inner.def] as DefFact).fields[left.text] = type;
          } else if (annotation) ctx.setLocal(left.text, annotation);
          else ctx.assign(left.text, type, true);
        } else if (left?.type === "pattern_list" || left?.type === "tuple_pattern" || left?.type === "list_pattern") {
          // `a, b = pair`: each name is assigned a value whose type is not known.
          if (!(inner.cls !== null && inner.locals === null)) for (const n of patternNames(left)) ctx.assign(n, null, true);
        } else if (left?.type === "attribute" && left.childForFieldName("object")?.text === "self") {
          const attr = left.childForFieldName("attribute");
          const cls = ctx.cls();
          if (attr && cls && type) (ctx.defs[cls.def] as DefFact).fields[attr.text] = type;
        }
        return;
      }
      case "call": {
        const fn = node.childForFieldName("function");
        if (fn?.type === "identifier") ctx.addCall(fn, { kind: "none" });
        else if (fn?.type === "subscript") ctx.addDynamicCall(fn);
        else if (fn?.type === "attribute") {
          const attr = fn.childForFieldName("attribute");
          const object = fn.childForFieldName("object");
          if (attr && object) ctx.addCall(attr, pyReceiver(ctx, object));
        }
        return;
      }
    }
  });
  return ctx.facts();
}

// ---------- Go ----------

const GO_TYPES = new Set([
  "package_clause",
  "import_spec",
  "function_declaration",
  "method_declaration",
  "type_spec",
  "func_literal",
  "short_var_declaration",
  "var_spec",
  "range_clause",
  "call_expression",
]);

function goTypeRef(node: Node | null): TypeRef | null {
  if (!node) return null;
  const { line, column } = pos(node);
  switch (node.type) {
    case "type_identifier":
      return { name: node.text, qualifier: null, line, column };
    case "pointer_type":
      return goTypeRef(node.firstNamedChild);
    case "generic_type":
      return goTypeRef(node.childForFieldName("type"));
    case "slice_type":
    case "array_type":
    case "map_type": {
      const inner = goTypeRef(node.childForFieldName(node.type === "map_type" ? "value" : "element"));
      return inner ? { ...inner, elem: true } : null;
    }
    case "qualified_type": {
      const pkg = node.childForFieldName("package");
      const name = node.childForFieldName("name");
      return pkg && name ? { name: name.text, qualifier: pkg.text, line, column } : null;
    }
    default:
      return null;
  }
}

function goParams(list: Node | null, locals: Map<string, TypeRef | null>): void {
  for (const p of list?.namedChildren ?? []) {
    if (p.type !== "parameter_declaration" && p.type !== "variadic_parameter_declaration") continue;
    const type = p.type === "parameter_declaration" ? goTypeRef(p.childForFieldName("type")) : null;
    for (const n of p.childrenForFieldName("name")) locals.set(n.text, type);
  }
}

// The declared result types, one per result (a named group repeats its type).
function goResults(node: Node): (TypeRef | null)[] | undefined {
  const r = node.childForFieldName("result");
  if (!r) return undefined;
  if (r.type !== "parameter_list") return [goTypeRef(r)];
  const out: (TypeRef | null)[] = [];
  for (const p of r.namedChildren) {
    if (p.type !== "parameter_declaration") continue;
    const type = goTypeRef(p.childForFieldName("type"));
    const names = p.childrenForFieldName("name");
    for (let i = 0; i < Math.max(1, names.length); i++) out.push(type);
  }
  return out;
}

// `F()` or `pkg.F()`: typed by F's declared result at `index`, looked up when
// the graph is resolved. A method call's result is not followed.
function goCallType(ctx: Ctx, call: Node, index: number): TypeRef | null {
  const fn = call.childForFieldName("function");
  if (fn?.type === "identifier") return { name: fn.text, qualifier: null, ...pos(fn), result: index };
  if (fn?.type === "selector_expression") {
    const operand = fn.childForFieldName("operand");
    const field = fn.childForFieldName("field");
    if (operand?.type === "identifier" && field && ctx.local(operand.text) === undefined) {
      return { name: field.text, qualifier: operand.text, ...pos(fn), result: index };
    }
  }
  return null;
}

function goValueType(ctx: Ctx, value: Node | undefined, index = 0): TypeRef | null {
  let v = value;
  if (v?.type === "unary_expression") v = v.childForFieldName("operand") ?? undefined;
  if (v?.type === "composite_literal") return goTypeRef(v.childForFieldName("type"));
  if (v?.type === "call_expression") return goCallType(ctx, v, index);
  return null;
}

function goReceiver(ctx: Ctx, operand: Node): Receiver {
  const path: string[] = [];
  let base: Node | null = operand;
  while (base && base.type === "selector_expression") {
    const field = base.childForFieldName("field");
    if (!field) return { kind: "other" };
    path.unshift(field.text);
    base = base.childForFieldName("operand");
  }
  if (base?.type === "index_expression") {
    // clients[0].Get(): an element of a typed slice or map.
    const operand = base.childForFieldName("operand");
    const t = operand?.type === "identifier" ? ctx.local(operand.text) : null;
    return t?.elem ? { kind: "type", type: { ...t, elem: false }, path } : { kind: "other" };
  }
  if (base?.type === "call_expression") {
    const type = goCallType(ctx, base, 0);
    return type ? { kind: "type", type, path } : { kind: "other" };
  }
  if (base?.type !== "identifier") return { kind: "other" };
  const type = ctx.local(base.text);
  if (type?.elem) return { kind: "other" };
  if (type) return { kind: "type", type, path };
  if (type === null) return { kind: "other" };
  return { kind: "name", name: base.text, path, nesting: null };
}

function extractGo(tree: Tree): FileFacts {
  const ctx = new Ctx("go");
  const exported = (name: string) => /^[A-Z]/.test(name);
  walk(tree, GO_TYPES, (node) => {
    switch (node.type) {
      case "package_clause":
        ctx.goPackage = node.firstNamedChild?.text ?? null;
        return false;
      case "import_spec": {
        const path = node.childForFieldName("path");
        if (!path) return false;
        const alias = node.childForFieldName("name");
        if (alias?.type === "blank_identifier") return false;
        ctx.imports.push({
          spec: stringContent(path),
          ...pos(node),
          names: [],
          namespace: alias?.type === "package_identifier" ? alias.text : null,
          star: alias?.type === "dot",
          reexport: false,
          typeOnly: false,
        });
        return false;
      }
      case "function_declaration": {
        const name = node.childForFieldName("name");
        const locals = new Map<string, TypeRef | null>();
        goParams(node.childForFieldName("parameters"), locals);
        goParams(node.childForFieldName("result"), locals);
        if (!name) return ctx.push({ def: -1, cls: null, locals });
        const def = ctx.addDef(node, name, "function", { topLevel: true, exported: exported(name.text), results: goResults(node) });
        return ctx.push({ def, cls: null, locals });
      }
      case "method_declaration": {
        const name = node.childForFieldName("name");
        const locals = new Map<string, TypeRef | null>();
        const receiver = node.childForFieldName("receiver");
        goParams(receiver, locals);
        goParams(node.childForFieldName("parameters"), locals);
        goParams(node.childForFieldName("result"), locals);
        const recvType = goTypeRef(receiver?.namedChildren[0]?.childForFieldName("type") ?? null);
        if (!name || !recvType) return ctx.push({ def: -1, cls: null, locals });
        const def = ctx.addDef(node, name, "method", { owner: recvType.name, exported: exported(name.text), results: goResults(node) });
        return ctx.push({ def, cls: null, locals });
      }
      case "type_spec": {
        const name = node.childForFieldName("name");
        if (!name) return false;
        const body = node.childForFieldName("type");
        const fields: Record<string, TypeRef> = {};
        const bases: TypeRef[] = [];
        if (body?.type === "struct_type") {
          const list = body.namedChildren.find((c) => c.type === "field_declaration_list");
          for (const f of list?.namedChildren ?? []) {
            if (f.type !== "field_declaration") continue;
            const type = goTypeRef(f.childForFieldName("type"));
            const names = f.childrenForFieldName("name");
            if (!type) continue;
            if (names.length === 0) bases.push(type);
            for (const n of names) fields[n.text] = type;
          }
        }
        const top = node.parent?.parent?.type === "source_file";
        const span = node.parent?.type === "type_declaration" && node.parent.namedChildren.length === 1 ? node.parent : node;
        ctx.addDef(node, name, "type", { topLevel: top, exported: exported(name.text), fields, bases }, span);
        return false;
      }
      case "func_literal": {
        const locals = new Map<string, TypeRef | null>();
        goParams(node.childForFieldName("parameters"), locals);
        return ctx.push({ def: -1, cls: null, locals });
      }
      case "short_var_declaration": {
        const left = node.childForFieldName("left")?.namedChildren ?? [];
        const right = node.childForFieldName("right")?.namedChildren ?? [];
        left.forEach((l, i) => {
          if (l.type !== "identifier" || l.text === "_") return;
          // a, err := F() takes F's results in order; a, b := x, y pairs up.
          const type = right.length === 1 && left.length > 1 ? goValueType(ctx, right[0], i) : left.length === right.length ? goValueType(ctx, right[i]) : null;
          ctx.setLocal(l.text, type);
        });
        return;
      }
      case "var_spec": {
        const type = goTypeRef(node.childForFieldName("type"));
        const values = node.childForFieldName("value")?.namedChildren ?? [];
        node.childrenForFieldName("name").forEach((n, i) => ctx.setLocal(n.text, type ?? goValueType(ctx, values[i])));
        return;
      }
      case "range_clause": {
        // for _, op := range ops: op is an element of ops.
        const left = node.childForFieldName("left")?.namedChildren ?? [];
        const right = node.childForFieldName("right");
        const t = right?.type === "identifier" ? ctx.local(right.text) : null;
        left.forEach((l, i) => {
          if (l.type === "identifier" && l.text !== "_") ctx.setLocal(l.text, i === 1 && t?.elem ? { ...t, elem: false } : null);
        });
        return;
      }
      case "call_expression": {
        const fn = node.childForFieldName("function");
        if (fn?.type === "identifier") ctx.addCall(fn, { kind: "none" });
        else if (fn?.type === "selector_expression") {
          const field = fn.childForFieldName("field");
          const operand = fn.childForFieldName("operand");
          if (field && operand) ctx.addCall(field, goReceiver(ctx, operand));
        }
        return;
      }
    }
  });
  return ctx.facts();
}

// ---------- Ruby ----------

const RB_TYPES = new Set(["class", "module", "method", "singleton_method", "call", "assignment", "identifier", "block", "do_block", "lambda"]);

// Where a bare identifier can only be a value: a local or a method call.
const RB_VALUE_PARENTS = new Set([
  "body_statement",
  "then",
  "else",
  "argument_list",
  "binary",
  "parenthesized_statements",
  "return",
  "array",
  "interpolation",
  "conditional",
  "if",
  "unless",
  "while",
  "until",
  "if_modifier",
  "unless_modifier",
]);

function rbQualify(nesting: string | null, name: string): string {
  const n = name.replace(/^::/, "");
  return nesting && !name.startsWith("::") ? `${nesting}::${n}` : n;
}

function extractRuby(tree: Tree): FileFacts {
  const ctx = new Ctx("ruby");
  const nesting = () => ctx.cls()?.cls ?? null;
  const methodLocals = (node: Node): Map<string, TypeRef | null> => {
    const locals = new Map<string, TypeRef | null>();
    for (const p of node.childForFieldName("parameters")?.namedChildren ?? []) {
      const id = p.type === "identifier" ? p : p.childForFieldName("name");
      if (id) locals.set(id.text, null);
    }
    return locals;
  };
  const classLike = (node: Node, kind: "class" | "module"): Leave | false => {
    const name = node.childForFieldName("name");
    if (!name) return false;
    const outer = nesting();
    const full = rbQualify(outer, name.text);
    const cut = full.lastIndexOf("::");
    const owner = cut === -1 ? null : full.slice(0, cut);
    const nameNode = name.type === "scope_resolution" ? (name.childForFieldName("name") ?? name) : name;
    const bases: TypeRef[] = [];
    const sup = node.childForFieldName("superclass")?.firstNamedChild;
    if (sup && (sup.type === "constant" || sup.type === "scope_resolution")) bases.push({ name: sup.text, qualifier: outer, ...pos(sup) });
    const def = ctx.addDef(node, nameNode, kind, { owner, topLevel: true, exported: true, bases });
    return ctx.push({ def, cls: full, locals: null });
  };
  walk(tree, RB_TYPES, (node) => {
    switch (node.type) {
      case "class":
        return classLike(node, "class");
      case "module":
        return classLike(node, "module");
      case "method":
      case "singleton_method": {
        const name = node.childForFieldName("name");
        const locals = methodLocals(node);
        if (!name) return ctx.push({ def: -1, cls: null, locals });
        const owner = nesting();
        const def = ctx.addDef(node, name, owner ? "method" : "function", { owner, topLevel: owner === null, exported: true, static: node.type === "singleton_method" });
        return ctx.push({ def, cls: null, locals });
      }
      case "block":
      case "do_block":
      case "lambda": {
        const locals = new Map<string, TypeRef | null>();
        const params = node.childForFieldName("parameters") ?? node.namedChildren.find((c) => c.type === "block_parameters");
        for (const p of params?.namedChildren ?? []) {
          const id = p.type === "identifier" ? p : p.childForFieldName("name");
          if (id) locals.set(id.text, null);
        }
        return ctx.push({ def: -1, cls: null, locals });
      }
      case "assignment": {
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        let type: TypeRef | null = null;
        if (right?.type === "call" && right.childForFieldName("method")?.text === "new") {
          const recv = right.childForFieldName("receiver");
          if (recv && (recv.type === "constant" || recv.type === "scope_resolution")) type = { name: recv.text, qualifier: nesting(), ...pos(recv) };
        }
        if (left?.type === "identifier") ctx.assign(left.text, type);
        else if (left?.type === "instance_variable" && type) {
          const cls = ctx.cls();
          if (cls && cls.def >= 0) (ctx.defs[cls.def] as DefFact).fields[left.text] = type;
        }
        return;
      }
      case "call": {
        const method = node.childForFieldName("method");
        if (!method) return;
        const recv = node.childForFieldName("receiver");
        if (!recv) {
          const args = node.childForFieldName("arguments")?.namedChildren ?? [];
          if ((method.text === "require" || method.text === "require_relative") && args[0]?.type === "string") {
            const content = args[0].namedChildren.find((c) => c.type === "string_content");
            if (content) {
              ctx.imports.push({ spec: content.text, ...pos(node), names: [], namespace: null, star: false, reexport: false, typeOnly: false, relative: method.text === "require_relative" });
            }
            return false;
          }
          if (method.text === "include" || method.text === "extend" || method.text === "prepend") {
            const cls = ctx.cls();
            if (cls && cls.def >= 0) {
              for (const a of args) {
                if (a.type === "constant" || a.type === "scope_resolution") (ctx.defs[cls.def] as DefFact).bases.push({ name: a.text, qualifier: cls.cls, ...pos(a) });
              }
            }
            return;
          }
          ctx.addCall(method, ctx.cls() ? { kind: "self", path: [] } : { kind: "none" });
          return;
        }
        let r: Receiver = { kind: "other" };
        if (recv.type === "self") r = { kind: "self", path: [] };
        else if (recv.type === "constant" || recv.type === "scope_resolution") r = { kind: "name", name: recv.text, path: [], nesting: nesting() };
        else if (recv.type === "instance_variable") r = { kind: "self", path: [recv.text] };
        else if (recv.type === "call" && recv.childForFieldName("method")?.text === "new") {
          const cls = recv.childForFieldName("receiver");
          if (cls && (cls.type === "constant" || cls.type === "scope_resolution")) r = { kind: "type", type: { name: cls.text, qualifier: nesting(), ...pos(cls) }, path: [] };
        }
        else if (recv.type === "identifier") {
          const type = ctx.local(recv.text);
          if (type) r = { kind: "type", type, path: [] };
        }
        ctx.addCall(method, r);
        // The receiver identifier is a value, never a call of its own.
        return;
      }
      case "identifier": {
        const parent = node.parent;
        if (!parent || !RB_VALUE_PARENTS.has(parent.type)) return false;
        if (ctx.local(node.text) !== undefined || !ctx.cls()) return false;
        ctx.addCall(node, { kind: "self", path: [] }, true);
        return false;
      }
    }
  });
  return ctx.facts();
}

export function extract(tree: Tree, lang: Lang): FileFacts {
  if (lang === "python") return extractPython(tree);
  if (lang === "go") return extractGo(tree);
  if (lang === "ruby") return extractRuby(tree);
  return extractJs(tree, lang);
}
