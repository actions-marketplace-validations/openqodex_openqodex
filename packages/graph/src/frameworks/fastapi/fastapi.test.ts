// The FastAPI plugin on the sample application of the corpus
// (corpus/frameworks/fastapi/fastapi-app), built as a real git repository
// and run through the whole graph build: the questions a review asks of a
// handler change, answered from the framework layer. Then the same plugin
// on Python a stranger wrote to fool or stall it: routes written inside a
// string or a comment, computed paths, a broken file, and more than 1 MiB of
// crafted routers, includes, dependencies and patterns.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGraph, frameworkLayer } from "../../index.js";
import type { FrameworkLayer, Graph, Registration } from "../../index.js";
import { parserFor } from "../../parser.js";
import { MAX_SOURCE_BYTES, readFacts } from "./facts.js";
import { matches, MAX_MIDDLEWARE_CHAIN, MAX_MOUNTS, MAX_REGISTRATIONS } from "./resolve.js";

const git = (root: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
function commitAll(root: string): void {
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "test");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
}
function writeTree(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

// The id of the one symbol `name` in `file`.
function sym(graph: Graph, file: string, name: string): string {
  const hits = (graph.defsByFile.get(file) ?? []).filter((n) => n.name === name);
  if (hits.length !== 1) throw new Error(`${hits.length} symbols named ${name} in ${file}`);
  return (hits[0] as { id: string }).id;
}
const layer = (g: Graph): FrameworkLayer => {
  const l = frameworkLayer(g);
  if (!l) throw new Error("the graph has no framework layer");
  return l;
};
const fastapiRegs = (g: Graph): Registration[] =>
  layer(g)
    .registrations()
    .filter((r) => r.plugin === "fastapi");
const reg = (g: Graph, site: string): Registration => {
  const found = fastapiRegs(g).filter((r) => `${r.site.file}:${r.site.line}` === site);
  if (found.length !== 1) throw new Error(`${found.length} registrations at ${site}`);
  return found[0] as Registration;
};

describe("the FastAPI plugin on a small real application", () => {
  const MAIN = "fw:fastapi:app:app/main.py:5";
  const ADMIN = "fw:fastapi:app:app/admin.py:3";
  let base: Graph;
  let changed: Graph;
  let root: string;

  beforeAll(async () => {
    const corpus = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "corpus", "frameworks", "fastapi", "fastapi-app");
    root = mkdtempSync(join(tmpdir(), "oq-fastapi-"));
    cpSync(join(corpus, "base"), root, { recursive: true });
    commitAll(root);
    base = await buildGraph({ repoRoot: root, store: null });
    cpSync(join(corpus, "change"), root, { recursive: true, force: true });
    changed = await buildGraph({ repoRoot: root, store: null });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("answers which route maps to read_item with the include prefix and the router prefix joined, on the main application only", () => {
    const readItem = sym(changed, "app/routers/items.py", "read_item");
    const routes = layer(changed).routesReaching(readItem).routes;
    expect(routes.map((r) => `${r.registration.methods.join(",")} ${r.registration.pattern} ${r.hops}`)).toEqual(["GET /items/v1/{item_id} 0"]);
    expect(routes[0]?.registration.app).toBe(MAIN);
    expect(routes[0]?.registration.mountedVia.map((s) => `${s.file}:${s.line}`)).toEqual(["app/main.py:7"]);
  });

  it("follows a router made through an aliased APIRouter import, so a handler there still names its URL", () => {
    const me = sym(changed, "app/routers/users.py", "me");
    expect(layer(changed).routesReaching(me).routes.map((r) => `${r.registration.methods.join(",")} ${r.registration.pattern}`)).toEqual(["GET /users/me"]);
  });

  it("keeps the admin application's /health apart from the main one's, though both serve GET /health", () => {
    const health = fastapiRegs(changed).filter((r) => r.pattern === "/health");
    expect(new Set(health.map((r) => r.app))).toEqual(new Set([MAIN, ADMIN]));
    const adminHealth = sym(changed, "app/admin.py", "admin_health");
    expect(layer(changed).routesReaching(adminHealth).routes.map((r) => r.registration.app)).toEqual([ADMIN]);
    const mainHealth = sym(changed, "app/main.py", "health");
    expect(layer(changed).routesReaching(mainHealth).routes.map((r) => r.registration.app)).toEqual([MAIN]);
  });

  it("keeps the dependency chain of POST /items/v1/ in the order FastAPI runs it, the decorator's before the parameter's", () => {
    const post = reg(changed, "app/routers/items.py:18");
    expect(post.pattern).toBe("/items/v1/");
    const chain = layer(changed)
      .edgesFrom(post.id)
      .filter((e) => e.kind === "applies_middleware")
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((e) => changed.nodes.get(e.to)?.name);
    expect(chain).toEqual(["require_user", "get_db"]);
  });

  it("lists the tests of read_item as a direct call and a request that may reach its route, never as coverage", () => {
    const readItem = sym(changed, "app/routers/items.py", "read_item");
    const links = layer(changed)
      .testsOf(readItem)
      .map((l) => `${changed.nodes.get(l.test)?.name} ${l.category} ${l.tier}`)
      .sort();
    expect(links).toEqual(["test_read_item route-request likely", "test_read_item_direct direct-call certain"]);
  });

  it("marks the Pydantic models by their base, and nothing else in the repository", () => {
    const models = (changed.frameworks?.roles ?? []).filter((r) => r.plugin === "fastapi" && r.role === "model").map((r) => changed.nodes.get(r.target)?.name);
    expect(models.sort()).toEqual(["Item", "ItemIn"]);
  });

  it("makes no route of a decorator on a registry of the repository's own, though it is called app and its method get", () => {
    expect(layer(changed).registrationsIn("app/cache.py")).toEqual([]);
    expect(layer(changed).routesReaching(sym(changed, "app/cache.py", "cached")).routes).toEqual([]);
  });

  it("lists no route for a path the change computes, and names its handler in an unknown instead", () => {
    expect(fastapiRegs(base).filter((r) => r.site.file === "app/admin.py").map((r) => r.pattern)).toEqual(["/health"]);
    expect(fastapiRegs(changed).filter((r) => r.site.file === "app/admin.py").map((r) => r.pattern)).toEqual(["/health"]);
    const gap = changed.frameworks?.unknowns.find((u) => u.plugin === "fastapi" && u.site?.file === "app/admin.py" && u.site.line === 14);
    expect(gap?.cause).toBe("dynamic");
    expect(gap?.name).toBe("admin_probe");
  });
});

describe("the FastAPI plugin on routes a stranger wrote to fool it", () => {
  let root: string;
  let graph: Graph;
  const MAIN = [
    "from fastapi import FastAPI",
    "",
    'VERSION = "v2"',
    "app = FastAPI()",
    "",
    'DOC = """',
    '@app.get("/in-string")',
    "def in_string():",
    "    pass",
    '"""',
    "",
    '# @app.get("/in-comment")',
    "# def in_comment():",
    "#     pass",
    "",
    "",
    '@app.get(f"/items/{VERSION}")',
    "def fstring_route():",
    "    return 1",
    "",
    "",
    '@app.get("/tab\\tescaped\\x41\\u0042")',
    "def escaped():",
    "    return 2",
    "",
    "",
    '@app.get("/joined" "/parts")',
    "def joined():",
    "    return 3",
    "",
    "",
    '@app.get(r"/raw\\d")',
    "def raw():",
    "    return 4",
    "",
    "",
    'PREFIX = "/old"',
    'PREFIX += "/new"',
    "",
    "",
    '@app.get(PREFIX + "/x")',
    "def reassigned():",
    "    return 5",
    "",
  ].join("\n");
  const BROKEN = ["from fastapi import FastAPI", "", "app = FastAPI()", "", "", '@app.get("/fine")', "def fine():", "    return 1", "", "", '@app.get("/broken"', "def broken(:", "    pass", ""].join("\n");

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "oq-fastapi-fool-"));
    writeTree(root, { "pyproject.toml": '[project]\nname = "fool"\nversion = "0.1.0"\ndependencies = ["fastapi>=0.115"]\n', "app/__init__.py": "", "app/main.py": MAIN, "app/broken.py": BROKEN });
    commitAll(root);
    graph = await buildGraph({ repoRoot: root, store: null });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("registers nothing for a decorator written inside a string literal or a comment", () => {
    const written = fastapiRegs(graph).map((r) => r.written);
    expect(written).not.toContain("/in-string");
    expect(written).not.toContain("/in-comment");
  });

  it("decodes route paths by Python's string rules: escapes, adjacent literals and raw strings", () => {
    const main = fastapiRegs(graph)
      .filter((r) => r.site.file === "app/main.py")
      .map((r) => r.pattern);
    expect(main.sort()).toEqual(["/joined/parts", "/raw\\d", "/tab\tescapedAB"]);
  });

  it("treats an f-string path with a replacement field as computed: an unknown naming the handler, never a registration", () => {
    expect(fastapiRegs(graph).some((r) => r.site.line === 17)).toBe(false);
    const gap = graph.frameworks?.unknowns.find((u) => u.plugin === "fastapi" && u.site?.file === "app/main.py" && u.site.line === 17);
    expect(gap?.cause).toBe("dynamic");
    expect(gap?.name).toBe("fstring_route");
  });

  it("treats a module name assigned more than once as no constant, so a path built from it is an unknown, never a stale pattern", () => {
    expect(fastapiRegs(graph).some((r) => r.handler.written === "reassigned")).toBe(false);
    const gap = graph.frameworks?.unknowns.find((u) => u.plugin === "fastapi" && u.name === "reassigned");
    expect(gap?.cause).toBe("dynamic");
  });

  it("reads no decorator inside a broken region of a file, keeps the routes before it, and says the file has a syntax error", () => {
    expect(
      fastapiRegs(graph)
        .filter((r) => r.site.file === "app/broken.py")
        .map((r) => r.pattern),
    ).toEqual(["/fine"]);
    expect(graph.frameworks?.unknowns.some((u) => u.plugin === "fastapi" && u.cause === "file-not-parsed" && u.site?.file === "app/broken.py")).toBe(true);
  });

  it("still matches the request paths FastAPI serves: a parameter, a path parameter, a converter and a trailing slash", () => {
    expect(matches("/items/v1/{item_id}", "/items/v1/1")).toBe(true);
    expect(matches("/items/v1/{item_id}", "/items/v1/1/x")).toBe(false);
    expect(matches("/files/{file_path:path}", "/files/a/b/c.txt")).toBe(true);
    expect(matches("/files/{file_path:path}/edit", "/files/a/b/edit")).toBe(true);
    expect(matches("/n/{id:int}", "/n/12")).toBe(true);
    expect(matches("/n/{id:int}", "/n/ab")).toBe(false);
    expect(matches("/items/v1/", "/items/v1")).toBe(true);
    expect(matches("/report/{name}.csv", "/report/june.csv")).toBe(true);
  });
});

// A repository written to attack the plugin: the plugin reads Python files a
// stranger controls. More than 1 MiB of it: chains of routers each including
// the next, one looping back on itself, a diamond of includes, thousands of
// routes on one router, a dependency list hundreds long, a pattern of
// hundreds of path parameters, hundreds of small applications that together
// pass every build cap, and a file over the byte cap.
describe("the FastAPI plugin on a hostile repository", () => {
  const files: Record<string, string> = {};
  const HOSTILE_PATTERN = `/${Array.from({ length: 300 }, (_, i) => (i % 2 === 0 ? `{p${i}:path}` : `{q${i}}`)).join("/")}`;
  const LONG_PATH = `/${"a/".repeat(3000)}b`;
  let root: string;
  let graph: Graph;
  let factsMs = 0;

  const HEAD = "from fastapi import APIRouter, Depends, FastAPI\nfrom fastapi.testclient import TestClient\n\nfrom hostile.h import h\n\n";

  // A chain of routers each including the next, the last including the first.
  function chain(n: number): string {
    const lines = [HEAD, "capp = FastAPI()", 'c0 = APIRouter(prefix="/c")', "capp.include_router(c0)"];
    for (let i = 1; i < n; i++) lines.push(`c${i} = APIRouter(prefix="/c")`, `c${i - 1}.include_router(c${i})`);
    lines.push(`c${n - 1}.include_router(c0)`, `@c${n - 1}.get("/end")`, "def end():", "    return 1");
    return lines.join("\n");
  }
  // A diamond: every router includes the next one twice, so routes double per level.
  function diamond(levels: number): string {
    const lines = [HEAD, "dapp = FastAPI()"];
    for (let i = 0; i <= levels; i++) lines.push(`d${i} = APIRouter()`);
    for (let i = 0; i < levels; i++) lines.push(`d${i}.include_router(d${i + 1}, prefix="/p")`, `d${i}.include_router(d${i + 1}, prefix="/q")`);
    lines.push("dapp.include_router(d0)");
    for (let i = 0; i < 20; i++) lines.push(`@d${levels}.get("/r${i}")`, `def r${i}():`, "    return 1");
    return lines.join("\n");
  }
  // Thousands of routes on one router, in two files, included twice, and a dependency list hundreds long.
  function wide(from: number, n: number, own: boolean): string {
    const lines = [HEAD];
    if (own) lines.push("wapp = FastAPI()", `w = APIRouter(dependencies=[${Array.from({ length: 300 }, () => "Depends(h)").join(", ")}])`);
    else lines.push("from hostile.wide import w");
    for (let i = from; i < from + n; i++) lines.push(`@w.get("/w${i}/{id}")`, `def w${i}(id):`, "    return 1");
    if (own) lines.push('wapp.include_router(w, prefix="/a")', 'wapp.include_router(w, prefix="/b")');
    return lines.join("\n");
  }
  // A pattern of hundreds of path parameters, and a test that requests a long path.
  function wildcard(): string {
    return [HEAD, "sapp = FastAPI()", `@sapp.get(${JSON.stringify(HOSTILE_PATTERN)})`, "def wild():", "    return 1", "", "client = TestClient(sapp)", "", "def test_wild():", `    client.get(${JSON.stringify(LONG_PATH)})`].join("\n");
  }
  // One small application with its own routes, or its own includes.
  function smallRoutes(k: number): string {
    const lines = ["from fastapi import FastAPI", "", "app = FastAPI()"];
    for (let i = 0; i < 40; i++) lines.push(`@app.get("/s${k}/r${i}")`, `def r${i}():`, "    return 1");
    return lines.join("\n");
  }
  function smallIncludes(): string {
    const lines = ["from fastapi import APIRouter, FastAPI", "", "app = FastAPI()", "r = APIRouter()"];
    for (let i = 0; i < 8; i++) lines.push(`app.include_router(r, prefix="/p${i}")`);
    return lines.join("\n");
  }
  // Padded with statements, not comments: tree-sitter-python parses a long
  // run of comment lines slowly enough that the core's parse cap stops it,
  // and then no plugin ever sees the file.
  function pad(source: string, bytes: number): string {
    const filler = "\n_padding_to_reach_the_size_of_a_large_generated_route_module = 0\n";
    return source + filler.repeat(Math.max(0, Math.ceil((bytes - source.length) / filler.length)));
  }

  beforeAll(async () => {
    files["pyproject.toml"] = '[project]\nname = "hostile"\nversion = "0.1.0"\ndependencies = ["fastapi>=0.115", "pytest>=8"]\n';
    files["hostile/__init__.py"] = "";
    files["hostile/h.py"] = "def h():\n    return 1\n";
    files["hostile/chain_a.py"] = chain(990);
    files["hostile/chain_b.py"] = chain(990).replaceAll("capp", "capp2");
    files["hostile/diamond.py"] = diamond(30);
    files["hostile/wide.py"] = wide(0, 1900, true);
    files["hostile/wide_more.py"] = wide(1900, 1900, false);
    files["hostile/test_wild.py"] = wildcard();
    files["split/__init__.py"] = "";
    for (let k = 0; k < 300; k++) files[`split/routes_${String(k).padStart(3, "0")}.py`] = smallRoutes(k);
    for (let k = 0; k < 300; k++) files[`split/includes_${String(k).padStart(3, "0")}.py`] = smallIncludes();
    // Over the byte cap: the plugin must not read it, and must say so.
    files["hostile/huge.py"] = pad(wide(5000, 100, false), MAX_SOURCE_BYTES + 64 * 1024);
    const total = Object.values(files).reduce((n, s) => n + Buffer.byteLength(s), 0);
    expect(total).toBeGreaterThan(1024 * 1024);
    for (const [path, content] of Object.entries(files)) if (path !== "hostile/huge.py") expect(Buffer.byteLength(content)).toBeLessThan(MAX_SOURCE_BYTES);

    root = mkdtempSync(join(tmpdir(), "oq-fastapi-hostile-"));
    writeTree(root, files);
    commitAll(root);

    const parser = await parserFor("python");
    for (const [path, content] of Object.entries(files)) {
      if (!path.endsWith(".py")) continue;
      const tree = parser.parse(content);
      if (!tree) throw new Error(`no tree for ${path}`);
      const t0 = performance.now();
      readFacts(tree.rootNode);
      factsMs += performance.now() - t0;
      tree.delete();
    }
    graph = await buildGraph({ repoRoot: root, store: null, maxFileBytes: 2 * 1024 * 1024, budgetMs: 120_000 });
  }, 180_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const mine = () => ({
    regs: (graph.frameworks?.entities ?? []).filter((e): e is Registration => e.kind === "registration" && e.plugin === "fastapi"),
    edges: (graph.frameworks?.edges ?? []).filter((e) => e.plugin === "fastapi"),
    unknowns: (graph.frameworks?.unknowns ?? []).filter((u) => u.plugin === "fastapi"),
  });

  it("a crafted repository cannot hang or exhaust the build: facts of more than 1 MiB in under a second, resolve in under a second", () => {
    expect(factsMs).toBeLessThan(1000);
    const run = graph.frameworks?.plugins.find((p) => p.id === "fastapi");
    expect(run?.status, run?.reason ?? "").toBe("ok");
    expect(run?.ms ?? Infinity).toBeLessThan(1000);
  });

  it("does not read a file over the byte cap, and says so with an unknown", () => {
    const gap = mine().unknowns.find((u) => u.cause === "file-not-parsed" && u.site?.file === "hostile/huge.py");
    expect(gap?.note).toContain(String(MAX_SOURCE_BYTES));
    expect(mine().regs.some((r) => r.site.file === "hostile/huge.py")).toBe(false);
  });

  it("stops at the build's registration and include caps though the work is split over hundreds of small applications, and says so once each", () => {
    const { regs, edges, unknowns } = mine();
    expect(regs.length).toBeLessThanOrEqual(MAX_REGISTRATIONS);
    expect(edges.filter((e) => e.kind === "mounts").length).toBeLessThanOrEqual(MAX_MOUNTS);
    const regCap = unknowns.filter((u) => u.cause === "fan-out-capped" && u.note.includes(`${MAX_REGISTRATIONS} registrations`));
    const mountCap = unknowns.filter((u) => u.cause === "fan-out-capped" && u.note.includes(`${MAX_MOUNTS} router includes`));
    expect(regCap.length).toBe(1);
    expect(mountCap.length).toBe(1);
    expect(regCap[0]?.count ?? 0).toBeGreaterThan(0);
  });

  it("caps the dependency chain of a route and says how many were left out", () => {
    const perReg = new Map<string, number>();
    for (const e of mine().edges) if (e.kind === "applies_middleware") perReg.set(e.from, (perReg.get(e.from) ?? 0) + 1);
    expect(perReg.size).toBeGreaterThan(0);
    for (const n of perReg.values()) expect(n).toBeLessThanOrEqual(MAX_MIDDLEWARE_CHAIN);
    expect(mine().unknowns.some((u) => u.cause === "fan-out-capped" && u.note.includes("dependency chain") && (u.count ?? 0) > 0)).toBe(true);
  });

  it("stops an include chain that loops back on itself without repeating it, and says where the depth cap cut it", () => {
    const end = mine().regs.filter((r) => r.site.file === "hostile/chain_a.py");
    expect(end.length).toBeLessThanOrEqual(1);
    expect(mine().unknowns.some((u) => u.cause === "fan-out-capped" && u.note.includes("levels deep"))).toBe(true);
  });

  it("matches a request path against a pattern of hundreds of path parameters in linear time, with no regular expression", () => {
    const t0 = performance.now();
    expect(matches(HOSTILE_PATTERN, LONG_PATH)).toBe(false);
    expect(matches(`/${"{a:path}/".repeat(60)}x`, `/${"a/".repeat(60)}x`)).toBe(true);
    expect(matches(`/${"{a}".repeat(200)}`, `/${"a".repeat(250)}`)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(50);
  });
});
