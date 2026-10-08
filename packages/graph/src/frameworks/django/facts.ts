// The Django plugin's facts: what one Python file declares in Django's
// terms, read from its parse tree alone. Nothing here knows the file's
// path, whether Django is installed, or what a name is bound to: a fact
// records the dotted name as written (`views.index`, `models.CharField`),
// and resolve.ts decides through the file's imports whether it is
// Django's own API.
import type { Node } from "web-tree-sitter";
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
    | { kind: "url"; list: string; parent: number; fn: Ref; route: Lit; view: View; name: Lit; ns: Lit }
    | { kind: "urllist"; name: string; literal: boolean }
    | { kind: "urlrouter"; name: string; router: Ref }
    | { kind: "app_name"; value: Lit }
    | { kind: "assigned"; names: string[] } // the names top-level assignments bind: module-level values
    | { kind: "router"; name: string; ctor: Ref }
    | { kind: "register"; router: string; prefix: Lit; view: Ref | null; basename: Lit }
    | { kind: "render"; fn: Ref; template: Lit }
    | { kind: "template_attr"; owner: string; template: Lit }
    | { kind: "field"; owner: string; name: string; ctor: Ref; related: Ref | string | null }
    | { kind: "db_table"; owner: string; table: Lit }
    | { kind: "mig_op"; owner: string; op: string; model: Lit; field: Lit; to: Lit; fn: Ref | null }
    | { kind: "mig_dep"; owner: string; app: string; name: string }
    | { kind: "tag_library"; name: string; ctor: Ref }
    | { kind: "tag"; lib: string; decorator: string; fn: string; name: Lit; template: Lit }
    | { kind: "receiver"; dec: Ref; signals: Ref[]; sender: Ref | null; fn: string }
    | { kind: "connect"; signal: Ref; handler: Ref | null; sender: Ref | null }
    | { kind: "signal_def"; name: string; ctor: Ref }
    | { kind: "setting"; name: string; value: Lit; items: string[] | null }
    | { kind: "settings_module"; value: Lit }
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

export function wantsDjango(source: string): boolean {
  return /django|urlpatterns|INSTALLED_APPS|ROOT_URLCONF|client\.(get|post|put|patch|delete|head|options)\(/.test(source);
}

const last = (r: Ref | null): string | null => (r && r.length > 0 ? (r[r.length - 1] as string) : null);
const calleeOf = (call: Node): Ref | null => dotted(call.childForFieldName("function"));

// The names the file's own imports bind, to what they import: `show` to
// ["django", "shortcuts", "render"] for `from django.shortcuts import render
// as show`. Read from the same file, so the facts stay context-free; a name
// test on a call (is this `render`, `include`, `receiver`?) reads through
// it, and the fact keeps the name as written for resolve to bind.
function aliasesOf(statements: Node[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const stmt of statements) {
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
function topStatements(root: Node): Node[] {
  const out: Node[] = [];
  const visit = (block: Node, depth: number) => {
    for (const s of block.namedChildren) {
      if (s.type === "if_statement" || s.type === "try_statement" || s.type === "else_clause" || s.type === "elif_clause" || s.type === "except_clause" || s.type === "finally_clause" || s.type === "with_statement") {
        if (depth < 4) {
          for (const c of s.namedChildren) if (c.type === "block") visit(c, depth + 1);
          for (const c of s.namedChildren) if (c.type === "else_clause" || c.type === "elif_clause" || c.type === "except_clause" || c.type === "finally_clause") visit(c, depth + 1);
        }
        continue;
      }
      out.push(s);
    }
  };
  visit(root, 0);
  return out;
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
  const statements = topStatements(root);
  const aliases = aliasesOf(statements);
  // A dotted name with its head read through the file's imports.
  const named = (ref: Ref | null): Ref | null => {
    if (!ref) return null;
    const to = aliases.get(ref[0] as string);
    return to ? [...to, ...ref.slice(1)] : ref;
  };
  const tailOf = (ref: Ref | null): string | null => last(named(ref));

  // ---------- URL lists ----------
  const view = (node: Node | undefined, entryIndex: () => number, list: string): { view: View; ns: Lit } => {
    if (!node) return { view: { t: "other" }, ns: null };
    if (node.type === "call") {
      const fn = calleeOf(node);
      if (fn && tailOf(fn) === "include") {
        const { positional, keyword } = pyArgs(node);
        const arg = positional[0] ?? keyword.get("arg");
        const ns = keyword.has("namespace") ? pyString(keyword.get("namespace")) : null;
        if (arg?.type === "list") {
          const parent = entryIndex();
          for (const item of arg.namedChildren) if (item.type === "call") urlEntry(item, list, parent);
          return { view: { t: "include", fn, module: null, ref: null, inline: true }, ns };
        }
        if (arg?.type === "string" || arg?.type === "concatenated_string" || arg?.type === "binary_operator") return { view: { t: "include", fn, module: pyString(arg), ref: null, inline: false }, ns };
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
  const urlEntry = (call: Node, list: string, parent: number) => {
    const fn = calleeOf(call);
    if (!fn) return;
    const { positional, keyword } = pyArgs(call);
    const routeNode = positional[0] ?? keyword.get("route");
    if (!routeNode) return;
    const at = lineOf(call);
    const fact = { kind: "url", ...at, list, parent, fn, route: pyString(routeNode), view: { t: "other" }, name: keyword.has("name") ? pyString(keyword.get("name")) : null, ns: null } as DjangoFact & { kind: "url" };
    out.push(fact);
    const index = out.length - 1;
    const v = view(positional[1] ?? keyword.get("view"), () => index, list);
    fact.view = v.view;
    fact.ns = v.ns;
  };
  const urlItems = (list: Node, name: string, force: boolean) => {
    const calls = list.namedChildren.filter((c) => c.type === "call");
    // A list counts when it is `urlpatterns`, or when its items call path, re_path or url.
    if (!force && !calls.some((c) => URL_FUNCTIONS.has(tailOf(calleeOf(c)) ?? ""))) return false;
    for (const c of calls) urlEntry(c, name, -1);
    return true;
  };

  let settings = 0;
  const assigned = new Set<string>();
  for (const stmt of statements) {
    const asg = assignmentOf(stmt);
    if (asg) {
      const left = asg.childForFieldName("left");
      const right = asg.childForFieldName("right");
      const name = left?.type === "identifier" ? left.text : null;
      if (name && assigned.size < MAX_ASSIGNED) assigned.add(name);
      if (!name || !right) continue;
      const at = lineOf(asg);
      const augmented = asg.type === "augmented_assignment";
      if (name === "app_name") out.push({ kind: "app_name", ...at, value: pyString(right) });
      // urlpatterns = [...]; urlpatterns += [...]; urlpatterns = a + [...]; urlpatterns += router.urls
      const parts = right.type === "binary_operator" ? [right.childForFieldName("left"), right.childForFieldName("right")] : [right];
      let sawList = false;
      for (const part of parts) {
        if (part?.type === "list") sawList = urlItems(part, name, name === "urlpatterns") || sawList;
        const ref = dotted(part);
        if (ref && ref.length >= 2 && last(ref) === "urls" && name === "urlpatterns") out.push({ kind: "urlrouter", ...at, name, router: ref.slice(0, -1) });
      }
      if (name === "urlpatterns") out.push({ kind: "urllist", ...at, name, literal: sawList || augmented || parts.some((p) => p?.type === "identifier") });
      if (right.type === "call") {
        const fn = calleeOf(right);
        const tail = tailOf(fn);
        if (fn && (tail === "DefaultRouter" || tail === "SimpleRouter")) out.push({ kind: "router", ...at, name, ctor: fn });
        if (fn && tail === "Library") out.push({ kind: "tag_library", ...at, name, ctor: fn });
        if (fn && tail === "Signal") out.push({ kind: "signal_def", ...at, name, ctor: fn });
      }
      if (SETTING.test(name) && !augmented && settings < MAX_SETTINGS) {
        settings++;
        const items = pyStrings(right);
        const value = right.type === "string" || right.type === "concatenated_string" ? pyString(right) : null;
        out.push({ kind: "setting", ...at, name, value, items });
      }
      continue;
    }
    // urlpatterns.append(path(...)) and urlpatterns.extend([...])
    if (stmt.type === "expression_statement" && stmt.namedChildren[0]?.type === "call") {
      const call = stmt.namedChildren[0];
      const fn = calleeOf(call);
      if (fn && fn.length === 2 && fn[0] === "urlpatterns" && (fn[1] === "append" || fn[1] === "extend")) {
        const arg = pyArgs(call).positional[0];
        if (arg?.type === "call") urlEntry(arg, "urlpatterns", -1);
        else if (arg?.type === "list") urlItems(arg, "urlpatterns", true);
      }
    }
  }

  if (assigned.size > 0) out.push({ kind: "assigned", line: 1, column: 0, names: [...assigned] });

  // One walk of the tree for every node kind the reads below need: each
  // walk of a large file costs as much as the next, whatever it finds.
  const kinds: string[] = [];
  if (CLASS_WORDS.test(text)) kinds.push("class_definition");
  if (text.includes("@") && DECORATOR_WORDS.test(text)) kinds.push("decorated_definition");
  if (CALL_WORDS.test(text)) kinds.push("call");
  const settingsRead = /settings\.[A-Z]/.test(text);
  if (settingsRead) kinds.push("attribute");
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
      if (stmt.type === "class_definition" && stmt.childForFieldName("name")?.text === "Meta") {
        for (const m of stmt.childForFieldName("body")?.namedChildren ?? []) {
          const a = assignmentOf(m);
          if (a?.childForFieldName("left")?.text === "db_table") out.push({ kind: "db_table", ...lineOf(a), owner: name, table: pyString(a.childForFieldName("right")) });
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
        out.push({ kind: "template_attr", ...at, owner: name, template: pyString(right) });
        continue;
      }
      if (migration && left.text === "operations" && right.type === "list") {
        for (const op of right.namedChildren) {
          if (op.type !== "call") continue;
          const fn = calleeOf(op);
          const opName = last(fn);
          if (!opName) continue;
          const { positional, keyword } = pyArgs(op);
          const lit = (kw: string, pos: number): Lit => (keyword.has(kw) ? pyString(keyword.get(kw)) : positional[pos] ? pyString(positional[pos]) : null);
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
      if (migration && left.text === "dependencies" && right.type === "list") {
        for (const dep of right.namedChildren) {
          const pair = pyStrings(dep);
          if (pair && pair.length === 2) out.push({ kind: "mig_dep", ...lineOf(dep), owner: name, app: pair[0] as string, name: pair[1] as string });
        }
        continue;
      }
      if (right.type === "call") {
        const ctor = calleeOf(right);
        const tail = last(ctor);
        if (ctor && tail && (tail.endsWith("Field") || tail === "ForeignKey" || tail === "GenericForeignKey")) {
          const { positional, keyword } = pyArgs(right);
          const target = keyword.get("to") ?? (tail === "ForeignKey" || tail === "OneToOneField" || tail === "ManyToManyField" ? positional[0] : undefined);
          let related: Ref | string | null = null;
          if (target) {
            const s = pyString(target);
            related = typeof s === "string" ? s : dotted(target);
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
        const template = tail === "inclusion_tag" ? (args.keyword.has("filename") ? pyString(args.keyword.get("filename")) : args.positional[0] ? pyString(args.positional[0]) : null) : null;
        const named = args.keyword.has("name") ? pyString(args.keyword.get("name")) : tail !== "inclusion_tag" && args.positional[0] ? pyString(args.positional[0]) : null;
        out.push({ kind: "tag", ...at, lib: ref[0] as string, decorator: tail, fn: fnName, name: named, template });
      }
      if (tail === "receiver" && call) {
        const { positional, keyword } = pyArgs(call);
        const first = positional[0] ?? keyword.get("signal");
        const signals: Ref[] = [];
        if (first && (first.type === "list" || first.type === "tuple")) for (const s of first.namedChildren) {
          const r = dotted(s);
          if (r) signals.push(r);
        }
        else {
          const r = dotted(first);
          if (r) signals.push(r);
        }
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
      let template: Lit = null;
      if (node && (node.type === "list" || node.type === "tuple")) {
        const items = pyStrings(node);
        template = items && items.length > 0 ? (items[0] as string) : DYNAMIC;
      } else if (node) template = pyString(node);
      out.push({ kind: "render", ...at, fn, template });
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
      if (!prefix) continue;
      out.push({ kind: "register", ...at, router: fn[0] as string, prefix: pyString(prefix), view: dotted(positional[1] ?? keyword.get("viewset")), basename: keyword.has("basename") ? pyString(keyword.get("basename")) : keyword.has("base_name") ? pyString(keyword.get("base_name")) : null });
      continue;
    }
    if (tail === "reverse" || tail === "reverse_lazy" || tail === "resolve_url") {
      const { positional, keyword } = pyArgs(call);
      const node = positional[0] ?? keyword.get("viewname") ?? keyword.get("to");
      if (node) out.push({ kind: "reverse", ...at, fn, name: pyString(node) });
      continue;
    }
    if (tail === "setdefault" && fn.length >= 2 && last(fn.slice(0, -1)) === "environ") {
      const { positional } = pyArgs(call);
      if (pyString(positional[0]) === "DJANGO_SETTINGS_MODULE") out.push({ kind: "settings_module", ...at, value: pyString(positional[1]) });
      continue;
    }
    if (tail === "getattr" && fn.length === 1) {
      const { positional } = pyArgs(call);
      const base = dotted(positional[0]);
      const key = pyString(positional[1]);
      if (base && last(base) === "settings" && typeof key === "string" && SETTING.test(key)) out.push({ kind: "setting_read", ...at, base, key });
      continue;
    }
    if (fn.length >= 2 && HTTP_METHODS.includes(tail)) {
      const recv = fn.slice(0, -1);
      const r = last(recv);
      if (r !== "client" && r !== "api_client") continue;
      const { positional, keyword } = pyArgs(call);
      const node = positional[0] ?? keyword.get("path");
      if (!node) continue;
      const path = node.type === "string" || node.type === "concatenated_string" || node.type === "binary_operator" ? pyString(node) : null;
      out.push({ kind: "client", ...at, recv, method: tail, path });
    }
  }

  // ---------- settings reads ----------
  if (settingsRead) {
    for (const attr of nodes("attribute")) {
      const key = attr.childForFieldName("attribute")?.text;
      if (!key || !SETTING.test(key)) continue;
      const base = dotted(attr.childForFieldName("object"));
      if (!base || last(base) !== "settings") continue;
      // Not the target of an assignment (settings are never written by code here).
      const parent = attr.parent;
      if (parent && (parent.type === "assignment" || parent.type === "augmented_assignment") && parent.childForFieldName("left")?.id === attr.id) continue;
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
      return isStr(f.list) && Number.isInteger(f.parent) && isRef(f.fn) && isLit(f.route) && isView(f.view) && isLit(f.name) && isLit(f.ns);
    case "urllist":
      return isStr(f.name) && typeof f.literal === "boolean";
    case "urlrouter":
      return isStr(f.name) && isRef(f.router);
    case "assigned":
      return Array.isArray(f.names) && f.names.length <= MAX_ASSIGNED && f.names.every(isStr);
    case "app_name":
    case "settings_module":
      return isLit(f.value);
    case "router":
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
    case "mig_dep":
      return isStr(f.owner) && isStr(f.app) && isStr(f.name);
    case "tag":
      return isStr(f.lib) && isStr(f.decorator) && isStr(f.fn) && isLit(f.name) && isLit(f.template);
    case "receiver":
      return isRef(f.dec) && Array.isArray(f.signals) && f.signals.every(isRef) && optRef(f.sender) && isStr(f.fn);
    case "connect":
      return isRef(f.signal) && optRef(f.handler) && optRef(f.sender);
    case "setting":
      return isStr(f.name) && isLit(f.value) && (f.items === null || (Array.isArray(f.items) && f.items.every(isStr)));
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
