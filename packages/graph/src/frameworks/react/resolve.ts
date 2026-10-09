// The React plugin's resolve step: which functions and classes are
// components, which functions are hooks, which component renders which,
// and which tests render a component.
//
// API identity: a hook is a function named `use...` that calls a hook of
// the "react" module (bound through the file's own import of it) or a hook
// of the repository; the `use` prefix alone is never enough. A class is a
// component when its base binds to React's Component or PureComponent, or to
// a component class of the repository. A JSX element renders the component
// its name binds to, by the same rules as a call; an element whose name is
// a local value (a prop, a lookup in a table) is an unknown of cause
// "dynamic", never an edge, and an element from a dependency is external.
// A test links to a component only through an element given to a testing
// library's render function bound by import.
//
// Every budget counts the work done across the whole build, is checked
// where the work is done, and once reached stops that work with one
// unknown; nothing restarts per file or component.
import type { Detection, FrameworkEdge, FrameworkEvidence, FrameworkUnknown, Lookup, PluginIndex, PluginOutput, RoleAssignment } from "../plugin.js";
import { appId } from "../plugin.js";
import { weakest } from "../../model/records.js";
import type { Tier } from "../../model/records.js";
import { isTestFile, JS_RUNNERS, MAX_SOURCE_BYTES } from "../express/js.js";
import type { ReactFact } from "./facts.js";
import { isComponentName, isHookName } from "./facts.js";

export const PLUGIN = "react";
export const RULE_VERSION = 1;
const rule = (id: string) => ({ id, version: RULE_VERSION });

// A cap on one item: how many components or hooks deep a chain is followed.
export const MAX_CHAIN_DEPTH = 8;

// Budgets for the whole build.
export const MAX_FACTS_READ = 400_000; // facts of every file together
export const MAX_LOOKUPS = 200_000; // names looked up through the index
export const MAX_RENDER_EDGES = 40_000; // renders edges made
export const MAX_TEST_LINKS = 10_000; // tests edges made
export const MAX_ROLES = 20_000; // roles given
export const MAX_UNKNOWNS = 5000; // unknowns kept; past it one more says how many were left out

type Spend = "facts" | "lookups" | "renders" | "tests" | "roles";
const LIMIT: Record<Spend, number> = { facts: MAX_FACTS_READ, lookups: MAX_LOOKUPS, renders: MAX_RENDER_EDGES, tests: MAX_TEST_LINKS, roles: MAX_ROLES };

type Fact<K extends ReactFact["kind"]> = Extract<ReactFact, { kind: K }>;

type FileIndex = {
  components: Fact<"component">[];
  elements: Fact<"element">[];
  hookCalls: Fact<"hook-call">[];
  contexts: Set<string>;
  testBlocks: number;
  tooLarge: Fact<"too-large"> | null;
  syntaxError: Fact<"syntax-error"> | null;
  unread: boolean;
};

type Identity = {
  react: Set<string>; // locals bound to the react module itself: default or namespace import
  named: Map<string, string>; // local name to the react export it binds
  render: Set<string>; // locals that render a tree in a test: `render`, `mount`, `create` and namespaces of them
  renderNs: Set<string>; // namespace locals of a testing library: `TestRenderer.create`
};

// The testing libraries a render call may come from, with the exports that render.
const TESTING: Record<string, ReadonlySet<string>> = {
  "@testing-library/react": new Set(["render", "renderHook"]),
  "@testing-library/react-native": new Set(["render", "renderHook"]),
  "react-test-renderer": new Set(["create"]),
  enzyme: new Set(["mount", "shallow", "render"]),
};

export type Analysis = { apps: Detection[]; output: PluginOutput };

const memo = new WeakMap<object, Analysis>();

export function analyse(index: PluginIndex<ReactFact>): Analysis {
  const kept = memo.get(index);
  if (kept) return kept;
  const result = run(index);
  memo.set(index, result);
  return result;
}

function run(index: PluginIndex<ReactFact>): Analysis {
  const roles: RoleAssignment[] = [];
  const edges: FrameworkEdge[] = [];
  const unknowns: FrameworkUnknown[] = [];
  const apps: Detection[] = [];

  // ---------- the build's budgets ----------
  const refused: Record<Spend, number> = { facts: 0, lookups: 0, renders: 0, tests: 0, roles: 0 };
  const spent: Record<Spend, number> = { facts: 0, lookups: 0, renders: 0, tests: 0, roles: 0 };
  const take = (k: Spend, n = 1): boolean => {
    if (spent[k] + n > LIMIT[k]) {
      refused[k] += n;
      return false;
    }
    spent[k] += n;
    return true;
  };
  let unknownsLeftOut = 0;
  const seen = new Set<string>();
  const addUnknown = (u: FrameworkUnknown) => {
    const key = `${u.cause}\0${u.site ? `${u.site.file}:${u.site.line}:${u.site.column}` : JSON.stringify(u.scope)}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (unknowns.length >= MAX_UNKNOWNS) unknownsLeftOut++;
    else unknowns.push(u);
  };
  const lookup = (file: string, path: readonly string[]): Lookup => {
    if (!take("lookups")) return { kind: "gap", cause: "budget", note: `the React plugin makes at most ${MAX_LOOKUPS} lookups in one build`, candidates: null };
    return index.lookup(file, path);
  };

  // ---------- which projects use React ----------
  const enabled = new Map<string, boolean>();
  const isEnabled = (file: string): boolean => {
    const project = index.projectOf(file);
    let on = enabled.get(project);
    if (on === undefined) {
      on = index.declares(project, "npm", "react");
      enabled.set(project, on);
    }
    return on;
  };

  // ---------- each file's facts, read once ----------
  const indexes = new Map<string, FileIndex>();
  const fx = (file: string): FileIndex => {
    let f = indexes.get(file);
    if (f) return f;
    f = { components: [], elements: [], hookCalls: [], contexts: new Set(), testBlocks: 0, tooLarge: null, syntaxError: null, unread: false };
    indexes.set(file, f);
    const list = index.factsOf(file);
    if (!take("facts", list.length)) {
      f.unread = true;
      return f;
    }
    for (const fact of list) {
      switch (fact.kind) {
        case "component":
          f.components.push(fact);
          break;
        case "element":
          f.elements.push(fact);
          break;
        case "hook-call":
          f.hookCalls.push(fact);
          break;
        case "context":
          f.contexts.add(fact.name);
          break;
        case "test-block":
          f.testBlocks++;
          break;
        case "too-large":
          f.tooLarge = fact;
          break;
        case "syntax-error":
          f.syntaxError = fact;
          break;
      }
    }
    return f;
  };

  const identities = new Map<string, Identity>();
  const identity = (file: string): Identity => {
    let id = identities.get(file);
    if (id) return id;
    id = { react: new Set(), named: new Map(), render: new Set(), renderNs: new Set() };
    identities.set(file, id);
    const lf = index.languageFacts(file);
    if (!lf) return id;
    const outside = (spec: string) => take("lookups") && index.module(file, spec).kind === "external";
    for (const imp of lf.imports) {
      if (imp.scoped) continue;
      const whole = [...imp.names.filter((n) => n.imported === "default").map((n) => n.local), ...(imp.namespace ? [imp.namespace] : [])];
      if (imp.spec === "react" && outside("react")) {
        for (const l of whole) id.react.add(l);
        for (const n of imp.names) if (n.imported !== "default") id.named.set(n.local, n.imported);
      }
      const renders = TESTING[imp.spec];
      if (renders && outside(imp.spec)) {
        for (const n of imp.names) if (renders.has(n.imported)) id.render.add(n.local);
        for (const l of whole) id.renderNs.add(l);
      }
    }
    return id;
  };

  const files = index.factFiles().filter(isEnabled);
  const live: string[] = [];
  let unreadFiles = 0;
  for (const file of files) {
    const f = fx(file);
    if (f.unread) {
      unreadFiles++;
      continue;
    }
    if (f.tooLarge) {
      addUnknown({ plugin: PLUGIN, site: { file, line: 1, column: 1 }, scope: { file }, affects: ["renders", "tests"], cause: "file-not-parsed", name: null, note: `the file is ${f.tooLarge.bytes} bytes, over the ${MAX_SOURCE_BYTES}-byte cap of the React plugin, so its components were not read`, count: null, exact: false });
      continue;
    }
    if (f.syntaxError) addUnknown({ plugin: PLUGIN, site: { file, line: f.syntaxError.line, column: 1 }, scope: { file }, affects: ["renders", "tests"], cause: "file-not-parsed", name: null, note: `the file has ${f.syntaxError.regions} region(s) the parser could not read, the first at line ${f.syntaxError.line}; no element or component was read from them`, count: f.syntaxError.regions, exact: true });
    live.push(file);
  }

  // ---------- roles ----------
  const roleSeen = new Set<string>();
  const projectApp = new Map<string, string>(); // project to its detection id
  const appOf = (file: string): string | null => projectApp.get(index.projectOf(file)) ?? null;
  const addRole = (target: string, role: "component" | "hook" | "test", detail: string | null, file: string, evidence: FrameworkEvidence) => {
    const k = `${target}\0${role}`;
    if (roleSeen.has(k)) return;
    roleSeen.add(k);
    if (!take("roles")) return;
    const project = index.projectOf(file);
    if (!projectApp.has(project)) projectApp.set(project, appId(PLUGIN, manifestOf(project), 1));
    roles.push({ target, role, detail, app: appOf(file), evidence });
  };
  const manifestOf = (project: string): string => index.model().node.find((p) => p.dir === project)?.file ?? (project === "" ? "package.json" : `${project}/package.json`);

  // The symbol a component or hook fact names: the definition of that name
  // on that line, else the only one of that name in the file.
  // Each file's definitions by name, built once, so a file of thousands of
  // components is not scanned once per component.
  const byName = new Map<string, Map<string, { id: string; startLine: number }[]>>();
  const symbolOf = (file: string, name: string, line: number): string | null => {
    let names = byName.get(file);
    if (!names) {
      names = new Map();
      for (const n of index.symbols(file)) {
        if (n.kind === "file") continue;
        const list = names.get(n.name);
        if (list) list.push(n);
        else names.set(n.name, [n]);
      }
      byName.set(file, names);
    }
    const defs = names.get(name) ?? [];
    const exact = defs.find((n) => n.startLine === line);
    if (exact) return exact.id;
    return defs.length === 1 ? (defs[0] as { id: string }).id : null;
  };

  // Components: functions that return JSX, and classes on React's Component.
  const components = new Map<string, { tier: Tier; note: string | null }>();
  const classFacts = new Map<string, { file: string; fact: Fact<"component"> }>(); // symbol id to its class fact
  for (const file of live) {
    for (const c of fx(file).components) {
      const id = symbolOf(file, c.name, c.line);
      if (!id) continue;
      if (c.form === "class") classFacts.set(id, { file, fact: c });
      else if (c.returnsJsx) components.set(id, { tier: "certain", note: null });
    }
  }
  // A class is a component when its base binds to React's Component, or to a
  // component class of the repository, followed at most MAX_CHAIN_DEPTH deep.
  const classVerdict = new Map<string, { tier: Tier; note: string | null } | null>();
  const isComponentClass = (id: string, depth: number): { tier: Tier; note: string | null } | null => {
    if (classVerdict.has(id)) return classVerdict.get(id) ?? null;
    const entry = classFacts.get(id);
    if (!entry || depth > MAX_CHAIN_DEPTH) return null;
    classVerdict.set(id, null); // a cycle of bases proves nothing
    const { file, fact } = entry;
    const base = fact.base;
    let out: { tier: Tier; note: string | null } | null = null;
    if (base) {
      const ident = identity(file);
      const head = base[0] as string;
      const last = base[base.length - 1] as string;
      const react = (base.length === 2 && ident.react.has(head) && (last === "Component" || last === "PureComponent")) || (base.length === 1 && (ident.named.get(head) === "Component" || ident.named.get(head) === "PureComponent"));
      if (react) out = { tier: "certain", note: null };
      else {
        const found = lookup(file, base);
        if (found.kind === "symbol") {
          for (const b of found.ids) {
            const v = isComponentClass(b, depth + 1);
            if (v) {
              const tier = weakest(found.tier, v.tier);
              out = { tier, note: tier === "certain" ? null : (found.note ?? v.note ?? "the base class is bound by a convention") };
              break;
            }
          }
        }
      }
    }
    if (!out && fact.returnsJsx) out = { tier: "likely", note: "a class whose render method returns JSX; its base class could not be bound to React's Component" };
    classVerdict.set(id, out);
    return out;
  };
  for (const id of classFacts.keys()) {
    const v = isComponentClass(id, 0);
    if (v) components.set(id, v);
  }
  for (const [id, v] of components) {
    const n = index.node(id);
    if (!n) continue;
    const c = classFacts.get(id);
    addRole(id, "component", c ? "class" : "function", n.file, { kind: c ? "role-base" : "declaration", tier: v.tier, site: { file: n.file, line: n.startLine, column: 1 }, via: null, premises: [], rule: rule("react-component"), note: v.note });
  }

  // Hooks: a function named use... that calls a hook of React or of the repository.
  const hookCallsOf = new Map<string, { file: string; call: Fact<"hook-call"> }[]>();
  for (const file of live) {
    for (const call of fx(file).hookCalls) {
      const encl = index.enclosing(file, call.line);
      if (!encl || !isHookName(encl.name)) continue;
      const list = hookCallsOf.get(encl.id);
      if (list) list.push({ file, call });
      else hookCallsOf.set(encl.id, [{ file, call }]);
    }
  }
  const hookVerdict = new Map<string, { tier: Tier; note: string | null; site: { file: string; line: number; column: number } } | null>();
  const isHook = (id: string, depth: number): { tier: Tier; note: string | null; site: { file: string; line: number; column: number } } | null => {
    if (hookVerdict.has(id)) return hookVerdict.get(id) ?? null;
    const calls = hookCallsOf.get(id);
    if (!calls || depth > MAX_CHAIN_DEPTH) return null;
    hookVerdict.set(id, null); // a cycle of hooks proves nothing
    let out: { tier: Tier; note: string | null; site: { file: string; line: number; column: number } } | null = null;
    for (const { file, call } of calls) {
      // A parameter or local of that name is whatever the code passes: it proves no hook.
      if (call.local) continue;
      const ident = identity(file);
      const site = { file, line: call.line, column: call.column };
      const head = call.name[0] as string;
      const last = call.name[call.name.length - 1] as string;
      if ((call.name.length === 1 && isHookName(ident.named.get(head) ?? "")) || (call.name.length === 2 && ident.react.has(head) && isHookName(last))) {
        out = { tier: "certain", note: null, site };
        break;
      }
      const found = lookup(file, call.name);
      if (found.kind !== "symbol") continue;
      for (const target of found.ids) {
        if (target === id) continue;
        const v = isHook(target, depth + 1);
        if (!v) continue;
        const tier = weakest(found.tier, v.tier);
        const candidate = { tier, note: tier === "certain" ? null : (found.note ?? v.note ?? "the hook it calls is bound by a convention"), site };
        if (!out || (tier === "certain" && out.tier !== "certain")) out = candidate;
      }
      if (out?.tier === "certain") break;
    }
    hookVerdict.set(id, out);
    return out;
  };
  for (const id of hookCallsOf.keys()) {
    const v = isHook(id, 0);
    const n = index.node(id);
    if (v && n) addRole(id, "hook", "react", n.file, { kind: "declaration", tier: v.tier, site: v.site, via: null, premises: [], rule: rule("react-hook"), note: v.note });
  }

  // ---------- which component renders which, and which test renders it ----------
  const isContext = (file: string, path: readonly string[]): boolean => {
    if (path.length !== 2 || (path[1] !== "Provider" && path[1] !== "Consumer")) return false;
    const head = path[0] as string;
    if (fx(file).contexts.has(head)) return true;
    // A context made in another module shows as a miss there: a value, not a definition.
    const found = lookup(file, [head]);
    return found.kind === "miss" && fx(found.target).contexts.has(found.name);
  };
  const testFiles = new Set<string>();
  for (const file of live) {
    const ident = identity(file);
    for (const el of fx(file).elements) {
      const site = { file, line: el.line, column: el.column };
      const shown = el.name.join(".");
      if (el.local) {
        addUnknown({ plugin: PLUGIN, site, scope: { file }, affects: ["renders"], cause: "dynamic", name: shown, note: `<${shown}> names a value the code computes (a parameter or a local), so the component it renders is not known`, count: null, exact: false });
        continue;
      }
      if (isContext(file, el.name)) continue;
      const renderCall = el.render;
      const inTest = renderCall !== null && ((renderCall.length === 1 && ident.render.has(renderCall[0] as string)) || (renderCall.length === 2 && ident.renderNs.has(renderCall[0] as string)));
      const found = lookup(file, el.name);
      const from = index.enclosing(file, el.line)?.id ?? file;
      switch (found.kind) {
        case "symbol": {
          for (const to of found.ids) {
            const ev: FrameworkEvidence = { kind: "component-element", tier: found.tier, site, via: found.via, premises: [], rule: rule(inTest ? "react-test-render" : "react-renders"), note: found.tier === "certain" ? null : (found.note ?? `the element's binding is ${found.tier}`) };
            if (inTest) {
              if (take("tests")) edges.push({ from, to, kind: "tests", plugin: PLUGIN, app: appOf(file), category: "component-render", evidence: ev });
              testFiles.add(file);
            } else if (take("renders")) edges.push({ from, to, kind: "renders", plugin: PLUGIN, app: appOf(file), evidence: ev });
          }
          break;
        }
        case "miss":
          addUnknown({ plugin: PLUGIN, site, scope: { file }, affects: ["renders"], cause: "miss", name: shown, note: `<${shown}> names ${found.name} in ${found.target}, where no such definition exists now`, count: null, exact: false });
          break;
        case "gap":
          addUnknown({ plugin: PLUGIN, site, scope: { file }, affects: ["renders"], cause: found.cause, name: shown, note: found.note, count: null, exact: false });
          break;
        case "none":
          if (isComponentName(el.name[0] as string)) addUnknown({ plugin: PLUGIN, site, scope: { file }, affects: ["renders"], cause: "dynamic", name: shown, note: `<${shown}> names a value the code makes (a memo, a styled wrapper, a lookup), not a definition, so the component it renders is not known`, count: null, exact: false });
          break;
        default:
          break; // external: a dependency's component; a module: not a component
      }
    }
  }

  // ---------- test files ----------
  for (const file of live) {
    if (!isTestFile(file) || fx(file).testBlocks === 0) continue;
    const ident = identity(file);
    if (ident.render.size === 0 && ident.renderNs.size === 0 && !testFiles.has(file)) continue;
    const project = index.projectOf(file);
    if (!JS_RUNNERS.some((n) => index.declares(project, "npm", n))) continue;
    addRole(file, "test", "react-testing", file, { kind: "role-path", tier: "certain", site: { file, line: 1, column: 1 }, via: null, premises: [], rule: rule("react-test-file"), note: null });
  }

  // ---------- one application per project with components ----------
  for (const [project, id] of projectApp) {
    const manifest = manifestOf(project);
    const version = index.model().node.find((p) => p.dir === project)?.pkg.deps.get("react") ?? null;
    apps.push({ id, name: `React (${project === "" ? "the repository root" : project})`, project, root: project, site: { file: manifest, line: 1, column: 1 }, evidence: [{ file: manifest, line: 1, note: "declares react, and the project has components" }], version });
  }

  // ---------- what the budgets left out ----------
  const whole = { project: "" } as const;
  const cut = (affects: FrameworkUnknown["affects"], cause: FrameworkUnknown["cause"], count: number, note: string) => unknowns.push({ plugin: PLUGIN, site: null, scope: whole, affects, cause, name: null, note, count, exact: true });
  if (unreadFiles > 0) cut(["renders", "tests"], "budget", unreadFiles, `${unreadFiles} files were not read: the React plugin reads at most ${MAX_FACTS_READ} facts in one build`);
  if (refused.lookups > 0) cut(["renders", "tests"], "budget", refused.lookups, `${refused.lookups} names were not looked up: the React plugin makes at most ${MAX_LOOKUPS} lookups in one build`);
  if (refused.renders > 0) cut(["renders"], "fan-out-capped", refused.renders, `${refused.renders} renders edges were left out: the React plugin keeps at most ${MAX_RENDER_EDGES} in one build`);
  if (refused.tests > 0) cut(["tests"], "fan-out-capped", refused.tests, `${refused.tests} test links were left out: the React plugin keeps at most ${MAX_TEST_LINKS} in one build`);
  if (refused.roles > 0) cut(["renders", "tests"], "fan-out-capped", refused.roles, `${refused.roles} roles were left out: the React plugin gives at most ${MAX_ROLES} roles in one build`);
  if (unknownsLeftOut > 0) cut(["renders", "tests"], "fan-out-capped", unknownsLeftOut, `${unknownsLeftOut} more unknowns past the first ${MAX_UNKNOWNS} were left out`);

  return { apps, output: { roles, entities: [], edges, unknowns } };
}
