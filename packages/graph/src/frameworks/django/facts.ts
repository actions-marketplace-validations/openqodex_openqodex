// The Django plugin's facts: what one Python file declares in Django's
// terms, read from its parse tree alone. Nothing here knows the file's
// path, whether Django is installed, or what a name is bound to: a fact
// records the dotted name as written (`views.index`, `models.CharField`),
// and resolve.ts decides through the file's imports whether it is
// Django's own API.
import type { Node } from "web-tree-sitter";
import type { FrameworkEdgeKind } from "../plugin.js";
import { dottedText, keptText, pathText } from "../shared/kept.js";
import { DYNAMIC, dotted, isLit, lineOf, pyArgs, pyString, pyStrings } from "../shared/literals.js";
import type { Lit } from "../shared/literals.js";

export type Ref = string[];

// The view side of a URL entry.
export type View =
  | { t: "ref"; ref: Ref } // views.index
  | { t: "as_view"; ref: Ref } // views.PostList.as_view()
  | { t: "instance"; ref: Ref } // feeds.LatestEntries(): an instance of a class is the view
  | { t: "include"; fn: Ref; module: Lit; ref: Ref | null; inline: boolean } // include("blog.urls"), include(router.urls), include([...])
  | { t: "other" }; // anything computed

type At = { line: number; column: number };

export type DjangoFact = At &
  (
    | { kind: "url"; list: string; parent: number; seq: number; fn: Ref; route: Lit; view: View; name: Lit; ns: Lit }
    // One statement that builds a URL list: it replaces the list or extends
    // it, in statement order (`seq`), inside a branch that may not run or not.
    | { kind: "urllist"; name: string; literal: boolean; seq: number; op: "replace" | "extend"; cond: boolean }
    | { kind: "urlrouter"; name: string; router: Ref }
    | { kind: "app_name"; value: Lit }
    | { kind: "assigned"; names: string[]; complete: boolean } // the names top-level assignments bind: module-level values
    // Something the facts saw and could not read: a URL list item that is
    // not a call, a list built by a call, a statement nested too deep, a cap.
    // `list` names the URL list it belongs to (null: the module), `join`
    // a list of this module joined into it, which resolve follows, and
    // `affects` the relations it can hide when it is not in a URL list.
    | { kind: "unread"; list: string | null; seq: number; cond: boolean; what: string; cause: "dynamic" | "unsupported-rule" | "fan-out-capped"; join?: string; affects?: FrameworkEdgeKind[] }
    | { kind: "router"; name: string; ctor: Ref; slash: "yes" | "no" | "dynamic" } // trailing_slash as written
    | { kind: "register"; router: string; prefix: Lit; view: Ref | null; basename: Lit }
    | { kind: "render"; fn: Ref; template: Lit }
    | { kind: "template_attr"; owner: string; template: Lit }
    | { kind: "field"; owner: string; name: string; ctor: Ref; related: Ref | string | null }
    | { kind: "db_table"; owner: string; table: Lit }
    | { kind: "mig_op"; owner: string; op: string; model: Lit; field: Lit; to: Lit; fn: Ref | null }
    | { kind: "tag_library"; name: string; ctor: Ref }
    | { kind: "tag"; lib: string; decorator: string; fn: string; template: Lit }
    | { kind: "receiver"; dec: Ref; signals: Ref[]; sender: Ref | null; fn: string }
    | { kind: "connect"; signal: Ref; handler: Ref | null; sender: Ref | null }
    | { kind: "signal_def"; name: string; ctor: Ref }
    // A setting's value is kept for ROOT_URLCONF alone, the one setting
    // resolve reads; every other setting is a name with no value.
    | { kind: "setting"; name: string; value: Lit }
    | { kind: "setting_read"; base: Ref; key: string }
    | { kind: "client"; recv: Ref; method: string; path: Lit }
    | { kind: "reverse"; fn: Ref; name: Lit }
  );

export const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];
const RENDER_FUNCTIONS: Record<string, number> = { render: 1, render_to_response: 0, render_to_string: 0, get_template: 0, select_template: 0, TemplateResponse: 1, SimpleTemplateResponse: 0 };
const URL_FUNCTIONS = new Set(["path", "re_path", "url"]);
const SETTING = /^[A-Z][A-Z0-9_]*$/;
const MAX_SETTINGS = 400;
const MAX_ASSIGNED = 2000;
// The relations an unread fact may name.
const UNREAD_AFFECTS: ReadonlySet<string> = new Set(["handles", "mounts", "renders", "tests", "declares_field", "changes_schema", "maps_to", "uses_type", "schedules", "reads_config", "defines_config", "runs"]);
const REVERSE_NAMES = new Set(["reverse", "reverse_lazy", "resolve_url"]);
// Statements whose body runs any number of times, or picks one branch.
const LOOPS: Record<string, string> = { for_statement: "a for loop", while_statement: "a while loop", match_statement: "a match statement" };
const LIST_REMOVERS = new Set(["remove", "pop", "clear"]);

export function wantsDjango(source: string): boolean {
  return /django|rest_framework|urlpatterns|INSTALLED_APPS|ROOT_URLCONF|client\.(get|post|put|patch|delete|head|options)\(/.test(source);
}

const last = (r: Ref | null): string | null => (r && r.length > 0 ? (r[r.length - 1] as string) : null);
// A literal resolve reads as a dotted name (a module path, a model or a
// field): kept when it is one, computed otherwise.
const moduleLit = (v: Lit): Lit => (typeof v === "string" ? (dottedText(v) ?? DYNAMIC) : v);
// A literal resolve reads by value (a route, a route or namespace name, a
// template, a table): bounded, with key-shaped text redacted, or computed
// when it hides an encoded key (shared/kept.ts).
const keep = (v: Lit): Lit => (typeof v === "string" ? (keptText(v) ?? DYNAMIC) : v);
const keepPath = (v: Lit): Lit => (typeof v === "string" ? (pathText(v) ?? DYNAMIC) : v);
const calleeOf = (call: Node): Ref | null => dotted(call.childForFieldName("function"));

// The names the file's own imports bind, to what they import: `show` to
// ["django", "shortcuts", "render"] for `from django.shortcuts import render
// as show`. Read from the same file, so the facts stay context-free; a name
// test on a call (is this `render`, `include`, `receiver`?) reads through
// it, and the fact keeps the name as written for resolve to bind.
function aliasesOf(statements: Statement[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const { node: stmt } of statements) {
    if (stmt.type === "import_from_statement") {
      const module = stmt.childForFieldName("module_name")?.text ?? "";
      const base = module.startsWith(".") ? [] : module.split(".");
      for (const n of stmt.childrenForFieldName("name")) {
        if (n.type === "aliased_import") {
          const name = n.childForFieldName("name")?.text;
          const alias = n.childForFieldName("alias")?.text;
          if (name && alias) out.set(alias, [...base, ...name.split(".")]);
        } else if (n.type === "dotted_name") out.set(n.text, [...base, ...n.text.split(".")]);
      }
    } else if (stmt.type === "import_statement") {
      for (const n of stmt.childrenForFieldName("name")) {
        if (n.type !== "aliased_import") continue;
        const name = n.childForFieldName("name")?.text;
        const alias = n.childForFieldName("alias")?.text;
        if (name && alias) out.set(alias, name.split("."));
      }
    }
  }
  return out;
}

// Statements at the top level of the module, through `if` and `try` blocks
// (settings and URL lists are often assembled under `if DEBUG:`).
const COMPOUND = new Set(["if_statement", "try_statement", "with_statement"]);
const CLAUSES = new Set(["elif_clause", "else_clause", "except_clause", "finally_clause"]);

// `cond`: inside a branch that may not run (an `if`, `elif` or `else` body,
// an `except` or a try's `else`); a `try` body, a `finally` and a `with`
// body run.
type Statement = { node: Node; cond: boolean };
// `bind` gets the target of every `with ... as x` and `except ... as x` the
// walk passes: the names they bind at module level.
function topStatements(root: Node, deep: (node: Node) => void, bind: (target: Node) => void): Statement[] {
  const out: Statement[] = [];
  const body = (block: Node, cond: boolean, depth: number) => {
    for (const s of block.namedChildren) {
      if (COMPOUND.has(s.type)) {
        if (depth < 4) compound(s, cond, depth + 1);
        else deep(s);
        continue;
      }
      out.push({ node: s, cond });
    }
  };
  const compound = (s: Node, cond: boolean, depth: number) => {
    const caught = s.type === "except_clause" ? s.childForFieldName("value") : null;
    if (caught?.type === "as_pattern") {
      const alias = caught.childForFieldName("alias");
      if (alias) bind(alias);
    }
    for (const c of s.namedChildren) {
      if (c.type === "with_clause") {
        for (const item of c.namedChildren) {
          const v = item.childForFieldName("value");
          const alias = v?.type === "as_pattern" ? v.childForFieldName("alias") : null;
          if (alias) bind(alias);
        }
        continue;
      }
      if (c.type === "block") body(c, cond || s.type === "if_statement" || s.type === "elif_clause" || s.type === "else_clause" || s.type === "except_clause", depth);
      else if (CLAUSES.has(c.type)) compound(c, cond || (s.type === "if_statement" && c.type !== "finally_clause"), depth);
    }
  };
  body(root, false, 0);
  return out;
}

// The names a binding target binds: `a`, `a, (b, c)`, `[a, *b]`; an
// attribute or a subscript binds none.
function boundNames(target: Node | null, out: string[]): void {
  if (!target) return;
  if (target.type === "identifier") out.push(target.text);
  else if (target.type === "pattern_list" || target.type === "tuple_pattern" || target.type === "list_pattern" || target.type === "tuple" || target.type === "list" || target.type === "list_splat_pattern" || target.type === "as_pattern_target" || target.type === "parenthesized_expression") for (const c of target.namedChildren) boundNames(c, out);
}

function assignmentOf(stmt: Node): Node | null {
  if (stmt.type !== "expression_statement") return null;
  const first = stmt.namedChildren[0];
  return first && (first.type === "assignment" || first.type === "augmented_assignment") ? first : null;
}

// Words a walk needs in the file's text before it runs: a file without them
// has nothing that walk records, so the tree is not walked for it. An
// aliased import still names the original in its import line.
const CLASS_WORDS = /\bclass\s/;
const DECORATOR_WORDS = /@[^\n]*(receiver|register|tag|filter|\bon\b)|receiver/;
const CALL_WORDS = /render|get_template|select_template|TemplateResponse|\.connect\(|\.register\(|reverse|resolve_url|DJANGO_SETTINGS_MODULE|getattr\(|client\./;

export function djangoFacts(root: Node): DjangoFact[] {
  const out: DjangoFact[] = [];
  const text = root.text;
  const assigned = new Set<string>();
  let assignedComplete = true;
  const bindName = (name: string) => {
    if (assigned.size < MAX_ASSIGNED) assigned.add(name);
    else if (!assigned.has(name)) assignedComplete = false;
  };
  const bindTarget = (target: Node | null) => {
    const names: string[] = [];
    boundNames(target, names);
    for (const n of names) bindName(n);
  };
  const statements = topStatements(
    root,
    (node) => out.push({ kind: "unread", ...lineOf(node), list: null, seq: 0, cond: true, what: "module-level statements nested deeper than four blocks are not read", cause: "fan-out-capped" }),
    bindTarget,
  );
  const aliases = aliasesOf(statements);
  // A dotted name with its head read through the file's imports.
  const named = (ref: Ref | null): Ref | null => {
    if (!ref) return null;
    const to = aliases.get(ref[0] as string);
    return to ? [...to, ...ref.slice(1)] : ref;
  };
  const tailOf = (ref: Ref | null): string | null => last(named(ref));

  // ---------- URL lists ----------
  const view = (node: Node | undefined, entryIndex: () => number, list: string, seq: number): { view: View; ns: Lit } => {
    if (!node) return { view: { t: "other" }, ns: null };
    if (node.type === "call") {
      const fn = calleeOf(node);
      if (fn && tailOf(fn) === "include") {
        const { positional, keyword } = pyArgs(node);
        const arg = positional[0] ?? keyword.get("arg");
        const ns = keyword.has("namespace") ? keep(pyString(keyword.get("namespace"))) : null;
        if (arg?.type === "list") {
          const parent = entryIndex();
          for (const item of arg.namedChildren) {
            if (item.type === "call") urlEntry(item, list, parent, seq);
            else if (item.type !== "comment") unread(item, list, seq, "an item of the included list that is not a call (a name, a spread or a comprehension)", "dynamic");
          }
          return { view: { t: "include", fn, module: null, ref: null, inline: true }, ns };
        }
        if (arg?.type === "string" || arg?.type === "concatenated_string" || arg?.type === "binary_operator") return { view: { t: "include", fn, module: moduleLit(pyString(arg)), ref: null, inline: false }, ns };
        const ref = dotted(arg);
        if (ref) return { view: { t: "include", fn, module: null, ref, inline: false }, ns };
        return { view: { t: "include", fn, module: DYNAMIC, ref: null, inline: false }, ns };
      }
      if (last(fn) === "as_view" && fn && fn.length >= 2) return { view: { t: "as_view", ref: fn.slice(0, -1) }, ns: null };
      // A class called with no arguments: an instance whose __call__ answers requests.
      const head = last(fn);
      const args = node.childForFieldName("arguments");
      if (fn && head && head[0] !== undefined && head[0] >= "A" && head[0] <= "Z" && args !== null && args.namedChildCount === 0) return { view: { t: "instance", ref: fn }, ns: null };
      return { view: { t: "other" }, ns: null };
    }
    const ref = dotted(node);
    return { view: ref ? { t: "ref", ref } : { t: "other" }, ns: null };
  };
  const unread = (node: Node, list: string, seq: number, what: string, cause: "dynamic" | "unsupported-rule", join?: string) => out.push({ kind: "unread", ...lineOf(node), list, seq, cond: cur.cond, what, cause, ...(join !== undefined ? { join } : {}) });
  const urlEntry = (call: Node, list: string, parent: number, seq: number) => {
    const fn = calleeOf(call);
    if (!fn) {
      unread(call, list, seq, "a URL entry whose function is not a name the graph reads", "unsupported-rule");
      return;
    }
    const { positional, keyword } = pyArgs(call);
    const routeNode = positional[0] ?? keyword.get("route");
    if (!routeNode) {
      unread(call, list, seq, `${fn.join(".")} with no route argument the graph reads`, "dynamic");
      return;
    }
    const at = lineOf(call);
    const fact = { kind: "url", ...at, list, parent, seq, fn, route: keep(pyString(routeNode)), view: { t: "other" }, name: keyword.has("name") ? keep(pyString(keyword.get("name"))) : null, ns: null } as DjangoFact & { kind: "url" };
    out.push(fact);
    const index = out.length - 1;
    const v = view(positional[1] ?? keyword.get("view"), () => index, list, seq);
    fact.view = v.view;
    fact.ns = v.ns;
  };
  const urlItems = (list: Node, name: string, force: boolean, seq: number) => {
    const calls = list.namedChildren.filter((c) => c.type === "call");
    // A list counts when it is `urlpatterns`, or when its items call path, re_path or url.
    if (!force && !calls.some((c) => URL_FUNCTIONS.has(tailOf(calleeOf(c)) ?? ""))) return false;
    for (const c of list.namedChildren) {
      if (c.type === "call") urlEntry(c, name, -1, seq);
      else if (c.type !== "comment") unread(c, name, seq, "an item of the URL list that is not a call (a name, a spread or a comprehension)", "dynamic");
    }
    return true;
  };
  let cur: Statement = { node: root, cond: false };

  let settings = 0;
  // The URL lists of the module so far: urlpatterns, and every list whose
  // items call path, re_path or url.
  const urlLists = new Set<string>(["urlpatterns"]);
  // The URL lists a statement names anywhere in it.
  const listsIn = (node: Node): string[] => {
    const hits = new Set<string>();
    for (const id of node.descendantsOfType("identifier")) if (urlLists.has(id.text)) hits.add(id.text);
    return [...hits];
  };
  let seq = 0;
  for (const st of statements) {
    const { node: stmt, cond } = st;
    cur = st;
    seq++;
    const asg = assignmentOf(stmt);
    if (asg) {
      const left = asg.childForFieldName("left");
      const right = asg.childForFieldName("right");
      const name = left?.type === "identifier" ? left.text : null;
      bindTarget(left);
      // `a = b = value` binds b too.
      for (let r = right; r?.type === "assignment"; r = r.childForFieldName("right")) bindTarget(r.childForFieldName("left"));
      if (!name || !right) continue;
      const at = lineOf(asg);
      const augmented = asg.type === "augmented_assignment";
      if (name === "app_name") out.push({ kind: "app_name", ...at, value: keep(pyString(right)) });
      // urlpatterns = [...]; urlpatterns += [...]; urlpatterns = a + [...]; urlpatterns += router.urls
      const parts = right.type === "binary_operator" ? [right.childForFieldName("left"), right.childForFieldName("right")] : [right];
      let sawList = false;
      for (const part of parts) if (part?.type === "list") sawList = urlItems(part, name, name === "urlpatterns", seq) || sawList;
      if (sawList) urlLists.add(name);
      for (const part of parts) {
        const ref = dotted(part);
        if (ref && ref.length >= 2 && last(ref) === "urls" && (name === "urlpatterns" || sawList)) out.push({ kind: "urlrouter", ...at, name, router: ref.slice(0, -1) });
      }
      // The parts of a URL list's right side the facts do not read as entries:
      // another list of the module joined in (resolve follows it), or a call.
      if (name === "urlpatterns" || sawList) {
        for (const part of parts) {
          if (!part || part.type === "list") continue;
          const ref = dotted(part);
          if (ref && ref.length === 1 && ref[0] !== name) unread(part, name, seq, `the list ${ref[0]} joined into ${name}`, "dynamic", ref[0]);
          else if (!(ref && ((ref.length === 1 && ref[0] === name) || (ref.length >= 2 && last(ref) === "urls")))) unread(part, name, seq, `a part of ${name} built by code the graph does not run`, "dynamic");
        }
      }
      // `urlpatterns = urlpatterns + [...]` extends; any other `=` replaces.
      const extend = augmented || parts.some((p) => p?.type === "identifier" && p.text === name);
      if (name === "urlpatterns" || sawList) out.push({ kind: "urllist", ...at, name, literal: sawList || augmented || parts.some((p) => p?.type === "identifier"), seq, op: extend ? "extend" : "replace", cond });
      if (right.type === "call") {
        const fn = calleeOf(right);
        const tail = tailOf(fn);
        if (fn && (tail === "DefaultRouter" || tail === "SimpleRouter")) {
          const option = pyArgs(right).keyword.get("trailing_slash");
          const slash = option === undefined || option.type === "true" ? "yes" : option.type === "false" ? "no" : "dynamic";
          out.push({ kind: "router", ...at, name, ctor: fn, slash });
        }
        if (fn && tail === "Library") out.push({ kind: "tag_library", ...at, name, ctor: fn });
        if (fn && tail === "Signal") out.push({ kind: "signal_def", ...at, name, ctor: fn });
      }
      if (SETTING.test(name) && !augmented && settings === MAX_SETTINGS) {
        settings++;
        out.push({ kind: "unread", ...at, list: null, seq, cond, what: `settings past the first ${MAX_SETTINGS} of the module are not read`, cause: "fan-out-capped" });
      }
      if (SETTING.test(name) && !augmented && settings < MAX_SETTINGS) {
        settings++;
        const value = name === "ROOT_URLCONF" ? (right.type === "string" || right.type === "concatenated_string" ? moduleLit(pyString(right)) : DYNAMIC) : null;
        out.push({ kind: "setting", ...at, name, value });
      }
      continue;
    }
    // A loop or a match at module level runs its body any number of times:
    // a URL list it names is said, and the names it binds no longer prove
    // an import.
    if (Object.hasOwn(LOOPS, stmt.type)) {
      if (stmt.type === "for_statement") bindTarget(stmt.childForFieldName("left"));
      for (const list of listsIn(stmt)) unread(stmt, list, seq, `${LOOPS[stmt.type]} that uses ${list}, which the graph does not run`, "dynamic");
      continue;
    }
    if (stmt.type === "delete_statement") {
      for (const list of listsIn(stmt)) unread(stmt, list, seq, `a del of entries of ${list}, which the graph does not track; a listed route may not be served`, "dynamic");
      continue;
    }
    // list.append(path(...)), list.extend([...]) and list.insert(i, path(...))
    // on a URL list; a remove, pop or clear is said.
    if (stmt.type === "expression_statement" && stmt.namedChildren[0]?.type === "call") {
      const call = stmt.namedChildren[0];
      const fn = calleeOf(call);
      const list = fn && fn.length === 2 && urlLists.has(fn[0] as string) ? (fn[0] as string) : null;
      const method = fn?.[1];
      if (list !== null && (method === "append" || method === "extend" || method === "insert")) {
        const args = pyArgs(call).positional;
        const arg = method === "insert" ? args[1] : args[0];
        if (arg?.type === "call") urlEntry(arg, list, -1, seq);
        else if (arg?.type === "list" && method === "extend") urlItems(arg, list, true, seq);
        else unread(arg ?? call, list, seq, `${list}.${method} of a value the graph does not read`, "dynamic");
        out.push({ kind: "urllist", ...lineOf(call), name: list, literal: true, seq, op: "extend", cond });
      } else if (list !== null && method !== undefined && LIST_REMOVERS.has(method)) {
        unread(call, list, seq, `${list}.${method}() takes out entries the graph does not track; a listed route may not be served`, "dynamic");
      }
    }
  }

  if (assigned.size > 0) out.push({ kind: "assigned", line: 1, column: 0, names: [...assigned], complete: assignedComplete });
  if (!assignedComplete) out.push({ kind: "unread", line: 1, column: 0, list: null, seq: 0, cond: false, what: `the module assigns more than ${MAX_ASSIGNED} names, so none of its imports is taken as proof of Django's API`, cause: "fan-out-capped" });

  // One walk of the tree for every node kind the reads below need: each
  // walk of a large file costs as much as the next, whatever it finds.
  const kinds: string[] = [];
  if (CLASS_WORDS.test(text)) kinds.push("class_definition");
  if (text.includes("@") && DECORATOR_WORDS.test(text)) kinds.push("decorated_definition");
  if (CALL_WORDS.test(text)) kinds.push("call");
  const settingsRead = /settings\.[A-Z]/.test(text);
  if (settingsRead) kinds.push("attribute", "assignment", "augmented_assignment");
  const found = new Map<string, Node[]>(kinds.map((k) => [k, []]));
  if (kinds.length > 0) for (const n of root.descendantsOfType(kinds)) found.get(n.type)?.push(n);
  const nodes = (kind: string): Node[] => found.get(kind) ?? [];

  // ---------- class bodies ----------
  for (const cls of nodes("class_definition")) {
    const name = cls.childForFieldName("name")?.text;
    const body = cls.childForFieldName("body");
    if (!name || !body) continue;
    const bases = (cls.childForFieldName("superclasses")?.namedChildren ?? []).map((b) => dotted(b));
    const migration = bases.some((b) => last(b) === "Migration");
    for (const stmt of body.namedChildren) {
      if (bases.length > 0 && (COMPOUND.has(stmt.type) || Object.hasOwn(LOOPS, stmt.type))) {
        out.push({ kind: "unread", ...lineOf(stmt), list: null, seq: 0, cond: true, what: `a block in the class body of ${name} is not read, so a field or template set in it is not known`, cause: "unsupported-rule", affects: ["declares_field", "renders", "maps_to"] });
        continue;
      }
      if (stmt.type === "class_definition" && stmt.childForFieldName("name")?.text === "Meta") {
        for (const m of stmt.childForFieldName("body")?.namedChildren ?? []) {
          const a = assignmentOf(m);
          if (a?.childForFieldName("left")?.text === "db_table") out.push({ kind: "db_table", ...lineOf(a), owner: name, table: keep(pyString(a.childForFieldName("right"))) });
        }
        continue;
      }
      const asg = assignmentOf(stmt);
      if (!asg || asg.type !== "assignment") continue;
      const left = asg.childForFieldName("left");
      const right = asg.childForFieldName("right");
      if (left?.type !== "identifier" || !right) continue;
      const at = lineOf(asg);
      if (left.text === "template_name") {
        out.push({ kind: "template_attr", ...at, owner: name, template: keep(pyString(right)) });
        continue;
      }
      if (migration && left.text === "operations" && right.type !== "list") out.push({ kind: "unread", ...at, list: null, seq: 0, cond: false, what: "the migration's operations are built by code the graph does not run", cause: "dynamic" });
      if (migration && left.text === "operations" && right.type === "list") {
        for (const op of right.namedChildren) {
          if (op.type === "comment") continue;
          const fn = op.type === "call" ? calleeOf(op) : null;
          const opName = last(fn);
          if (!opName) {
            out.push({ kind: "unread", ...lineOf(op), list: null, seq: 0, cond: false, what: "a migration operation that is not a call of a named operation", cause: "dynamic" });
            continue;
          }
          const { positional, keyword } = pyArgs(op);
          // Model and field names: a dotted name, or computed.
          const lit = (kw: string, pos: number): Lit => moduleLit(keyword.has(kw) ? pyString(keyword.get(kw)) : positional[pos] ? pyString(positional[pos]) : null);
          let model: Lit = null;
          let field: Lit = null;
          let to: Lit = null;
          if (opName === "CreateModel" || opName === "DeleteModel" || opName === "AlterModelTable" || opName === "AlterModelOptions" || opName === "AlterUniqueTogether" || opName === "AlterIndexTogether") model = lit("name", 0);
          else if (opName === "RenameModel") {
            model = lit("old_name", 0);
            to = lit("new_name", 1);
          } else if (opName === "RenameField") {
            model = lit("model_name", 0);
            field = lit("old_name", 1);
            to = lit("new_name", 2);
          } else if (opName === "AddField" || opName === "RemoveField" || opName === "AlterField") {
            model = lit("model_name", 0);
            field = lit("name", 1);
          } else if (opName === "AddIndex" || opName === "RemoveIndex" || opName === "AddConstraint" || opName === "RemoveConstraint") model = lit("model_name", 0);
          const code = opName === "RunPython" ? dotted(positional[0] ?? keyword.get("code")) : null;
          out.push({ kind: "mig_op", ...lineOf(op), owner: name, op: opName, model, field, to, fn: code });
        }
        continue;
      }
      // Every class attribute built by a call of a named constructor, in a
      // class with a base: resolve proves by the constructor's class which
      // ones are fields, never by its name.
      if (right.type === "call" && bases.length > 0) {
        const ctor = calleeOf(right);
        const tail = last(ctor);
        if (ctor && tail) {
          const { positional, keyword } = pyArgs(right);
          const target = keyword.get("to") ?? (tail === "ForeignKey" || tail === "OneToOneField" || tail === "ManyToManyField" ? positional[0] : undefined);
          let related: Ref | string | null = null;
          if (target) {
            const s = pyString(target);
            related = typeof s === "string" ? dottedText(s) : dotted(target);
          }
          out.push({ kind: "field", ...at, owner: name, name: left.text, ctor, related });
        }
      }
    }
  }

  // ---------- decorated functions: template tags and signal receivers ----------
  for (const dec of nodes("decorated_definition")) {
    const def = dec.childForFieldName("definition");
    if (def?.type !== "function_definition") continue;
    const fnName = def.childForFieldName("name")?.text;
    if (!fnName) continue;
    for (const d of dec.namedChildren) {
      if (d.type !== "decorator") continue;
      const expr = d.namedChildren[0];
      if (!expr) continue;
      const call = expr.type === "call" ? expr : null;
      const ref = call ? calleeOf(call) : dotted(expr);
      if (!ref) continue;
      const tail = ref.length === 2 ? last(ref) : tailOf(ref);
      const at = lineOf(d);
      if (ref.length === 2 && (tail === "simple_tag" || tail === "filter" || tail === "inclusion_tag" || tail === "tag")) {
        const args = call ? pyArgs(call) : { positional: [] as Node[], keyword: new Map<string, Node>() };
        const template = tail === "inclusion_tag" ? keep(args.keyword.has("filename") ? pyString(args.keyword.get("filename")) : args.positional[0] ? pyString(args.positional[0]) : null) : null;
        out.push({ kind: "tag", ...at, lib: ref[0] as string, decorator: tail, fn: fnName, template });
      }
      if (tail === "receiver" && call) {
        const { positional, keyword } = pyArgs(call);
        const first = positional[0] ?? keyword.get("signal");
        const signals: Ref[] = [];
        let unreadSignal = !first;
        if (first && (first.type === "list" || first.type === "tuple")) for (const s of first.namedChildren) {
          if (s.type === "comment") continue;
          const r = dotted(s);
          if (r) signals.push(r);
          else unreadSignal = true;
        }
        else {
          const r = dotted(first);
          if (r) signals.push(r);
          else unreadSignal = true;
        }
        if (unreadSignal) out.push({ kind: "unread", ...at, list: null, seq: 0, cond: false, what: `the signal of the receiver ${fnName} is not a name the graph reads`, cause: "dynamic", affects: ["schedules"] });
        out.push({ kind: "receiver", ...at, dec: ref, signals, sender: dotted(keyword.get("sender")), fn: fnName });
      }
    }
  }

  // ---------- calls anywhere ----------
  // The last name of a callee this loop reads, and the local names the
  // file's imports bind to one of them.
  const wanted = new Set<string>([...Object.keys(RENDER_FUNCTIONS), "connect", "register", "reverse", "reverse_lazy", "resolve_url", "setdefault", "getattr", ...HTTP_METHODS]);
  for (const [local, to] of aliases) if (wanted.has(to[to.length - 1] as string)) wanted.add(local);
  for (const call of nodes("call")) {
    // The callee's last name first, without building the dotted name of every call.
    const callee = call.childForFieldName("function");
    const name = callee?.type === "identifier" ? callee.text : callee?.type === "attribute" ? callee.childForFieldName("attribute")?.text : undefined;
    if (name === undefined || !wanted.has(name)) continue;
    const fn = dotted(callee);
    const tail = fn && fn.length === 1 ? tailOf(fn) : last(fn);
    if (!fn || !tail) continue;
    const at = lineOf(call);
    if (Object.hasOwn(RENDER_FUNCTIONS, tail)) {
      const { positional, keyword } = pyArgs(call);
      const pos = RENDER_FUNCTIONS[tail] as number;
      const node = keyword.get(tail === "TemplateResponse" || tail === "SimpleTemplateResponse" ? "template" : "template_name") ?? positional[pos];
      // No template argument the facts read (a spread, a keyword they do not know): computed.
      let template: Lit = DYNAMIC;
      if (node && (node.type === "list" || node.type === "tuple")) {
        const items = pyStrings(node);
        template = items && items.length > 0 ? (items[0] as string) : DYNAMIC;
      } else if (node) template = pyString(node);
      out.push({ kind: "render", ...at, fn, template: keep(template) });
      continue;
    }
    if (tail === "connect" && fn.length >= 2) {
      const { positional, keyword } = pyArgs(call);
      out.push({ kind: "connect", ...at, signal: fn.slice(0, -1), handler: dotted(positional[0] ?? keyword.get("receiver")), sender: dotted(keyword.get("sender")) });
      continue;
    }
    if (tail === "register" && fn.length === 2) {
      const { positional, keyword } = pyArgs(call);
      const prefix = positional[0] ?? keyword.get("prefix");
      out.push({ kind: "register", ...at, router: fn[0] as string, prefix: prefix ? keepPath(pyString(prefix)) : DYNAMIC, view: dotted(positional[1] ?? keyword.get("viewset")), basename: keep(keyword.has("basename") ? pyString(keyword.get("basename")) : keyword.has("base_name") ? pyString(keyword.get("base_name")) : null) });
      continue;
    }
    if (tail === "reverse" || tail === "reverse_lazy" || tail === "resolve_url") {
      const { positional, keyword } = pyArgs(call);
      const node = positional[0] ?? keyword.get("viewname") ?? keyword.get("to");
      if (node) out.push({ kind: "reverse", ...at, fn, name: keep(pyString(node)) });
      continue;
    }
    if (tail === "getattr" && fn.length === 1) {
      const { positional } = pyArgs(call);
      const base = dotted(positional[0]);
      const key = pyString(positional[1]);
      if (base && last(base) === "settings" && typeof key === "string" && SETTING.test(key) && keptText(key) === key) out.push({ kind: "setting_read", ...at, base, key });
      else if (base && last(base) === "settings" && typeof key !== "string") out.push({ kind: "unread", ...at, list: null, seq: 0, cond: false, what: "a settings read whose key is computed", cause: "dynamic", affects: ["reads_config"] });
      continue;
    }
    if (fn.length >= 2 && HTTP_METHODS.includes(tail)) {
      const recv = fn.slice(0, -1);
      const r = last(recv);
      if (r !== "client" && r !== "api_client") continue;
      const { positional, keyword } = pyArgs(call);
      const node = positional[0] ?? keyword.get("path");
      if (!node) continue;
      // A path from reverse() is linked by the route's name; any other
      // value that is not a literal is computed.
      const fromReverse = node.type === "call" && REVERSE_NAMES.has(tailOf(calleeOf(node)) ?? "");
      const path = fromReverse ? null : keepPath(pyString(node));
      out.push({ kind: "client", ...at, recv, method: tail, path });
    }
  }

  // ---------- settings reads ----------
  if (settingsRead) {
    // Assignment targets, from the same walk: asking a node for its parent
    // descends from the root again, so a lookup per node is quadratic.
    const targets = new Set<number>();
    for (const a of [...nodes("assignment"), ...nodes("augmented_assignment")]) {
      const left = a.childForFieldName("left");
      if (left) targets.add(left.id);
    }
    for (const attr of nodes("attribute")) {
      const key = attr.childForFieldName("attribute")?.text;
      if (!key || !SETTING.test(key)) continue;
      const base = dotted(attr.childForFieldName("object"));
      if (!base || last(base) !== "settings") continue;
      // Not the target of an assignment (settings are never written by code here).
      if (targets.has(attr.id)) continue;
      out.push({ kind: "setting_read", ...lineOf(attr), base, key });
    }
  }
  return out;
}

// ---------- the shape check for a cached fact ----------

const isRef = (v: unknown): v is Ref => Array.isArray(v) && v.length > 0 && v.length <= 32 && v.every((x) => typeof x === "string");
const optRef = (v: unknown) => v === null || isRef(v);
const isStr = (v: unknown): v is string => typeof v === "string";

function isView(v: unknown): v is View {
  if (typeof v !== "object" || v === null) return false;
  const x = v as Record<string, unknown>;
  if (x.t === "ref" || x.t === "as_view" || x.t === "instance") return isRef(x.ref);
  if (x.t === "include") return isRef(x.fn) && isLit(x.module) && optRef(x.ref) && typeof x.inline === "boolean";
  return x.t === "other";
}

export function isDjangoFact(v: unknown): v is DjangoFact {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  if (!Number.isInteger(f.line) || !Number.isInteger(f.column)) return false;
  switch (f.kind) {
    case "url":
      return isStr(f.list) && Number.isInteger(f.parent) && Number.isInteger(f.seq) && isRef(f.fn) && isLit(f.route) && isView(f.view) && isLit(f.name) && isLit(f.ns);
    case "urllist":
      return isStr(f.name) && typeof f.literal === "boolean" && Number.isInteger(f.seq) && (f.op === "replace" || f.op === "extend") && typeof f.cond === "boolean";
    case "urlrouter":
      return isStr(f.name) && isRef(f.router);
    case "assigned":
      return Array.isArray(f.names) && f.names.length <= MAX_ASSIGNED && f.names.every(isStr) && typeof f.complete === "boolean";
    case "unread":
      return (f.list === null || isStr(f.list)) && Number.isInteger(f.seq) && typeof f.cond === "boolean" && isStr(f.what) && (f.cause === "dynamic" || f.cause === "unsupported-rule" || f.cause === "fan-out-capped") && (f.join === undefined || isStr(f.join)) && (f.affects === undefined || (Array.isArray(f.affects) && f.affects.length <= UNREAD_AFFECTS.size && f.affects.every((a) => typeof a === "string" && UNREAD_AFFECTS.has(a))));
    case "app_name":
      return isLit(f.value);
    case "router":
      return isStr(f.name) && isRef(f.ctor) && (f.slash === "yes" || f.slash === "no" || f.slash === "dynamic");
    case "tag_library":
    case "signal_def":
      return isStr(f.name) && isRef(f.ctor);
    case "register":
      return isStr(f.router) && isLit(f.prefix) && optRef(f.view) && isLit(f.basename);
    case "render":
      return isRef(f.fn) && isLit(f.template);
    case "template_attr":
      return isStr(f.owner) && isLit(f.template);
    case "field":
      return isStr(f.owner) && isStr(f.name) && isRef(f.ctor) && (f.related === null || isStr(f.related) || isRef(f.related));
    case "db_table":
      return isStr(f.owner) && isLit(f.table);
    case "mig_op":
      return isStr(f.owner) && isStr(f.op) && isLit(f.model) && isLit(f.field) && isLit(f.to) && optRef(f.fn);
    case "tag":
      return isStr(f.lib) && isStr(f.decorator) && isStr(f.fn) && isLit(f.template);
    case "receiver":
      return isRef(f.dec) && Array.isArray(f.signals) && f.signals.every(isRef) && optRef(f.sender) && isStr(f.fn);
    case "connect":
      return isRef(f.signal) && optRef(f.handler) && optRef(f.sender);
    case "setting":
      return isStr(f.name) && isLit(f.value);
    case "setting_read":
      return isRef(f.base) && isStr(f.key);
    case "client":
      return isRef(f.recv) && isStr(f.method) && isLit(f.path);
    case "reverse":
      return isRef(f.fn) && isLit(f.name);
    default:
      return false;
  }
}
