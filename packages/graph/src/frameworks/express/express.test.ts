// The Express plugin on the sample application of the corpus
// (corpus/frameworks/express/express-app), built as a real git repository
// and run through the whole graph build: the questions a review asks of a
// handler change, answered from the framework layer.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGraph, frameworkLayer } from "../../index.js";
import type { FrameworkLayer, Graph, Registration } from "../../index.js";

// A corpus case as a real git repository: the base committed, the change
// written over it when asked.
const corpus = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "corpus", "frameworks");
function caseRepo(name: string): { root: string; applyChange: () => void } {
  const root = mkdtempSync(join(tmpdir(), "oq-express-"));
  cpSync(join(corpus, name, "base"), root, { recursive: true });
  const run = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
  run("init", "-q");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "test");
  run("add", "-A");
  run("commit", "-q", "-m", "base");
  return { root, applyChange: () => cpSync(join(corpus, name, "change"), root, { recursive: true, force: true }) };
}

// The id of the one symbol `name` in `file`.
function sym(graph: Graph, file: string, name: string): string {
  const hits = (graph.defsByFile.get(file) ?? []).filter((n) => n.name === name);
  if (hits.length !== 1) throw new Error(`${hits.length} symbols named ${name} in ${file}`);
  return (hits[0] as { id: string }).id;
}

let base: Graph;
let changed: Graph;
let root: string;
const layer = (g: Graph): FrameworkLayer => {
  const l = frameworkLayer(g);
  if (!l) throw new Error("the graph has no framework layer");
  return l;
};
const reg = (g: Graph, site: string): Registration => {
  const found = layer(g)
    .registrations()
    .filter((r) => r.plugin === "express" && `${r.site.file}:${r.site.line}` === site);
  if (found.length !== 1) throw new Error(`${found.length} registrations at ${site}`);
  return found[0] as Registration;
};

beforeAll(async () => {
  const repo = caseRepo("express/express-app");
  root = repo.root;
  base = await buildGraph({ repoRoot: root, store: null });
  repo.applyChange();
  changed = await buildGraph({ repoRoot: root, store: null });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the Express plugin on a small real application", () => {
  it("answers which route maps to a handler with the mount prefix composed, so a handler change names the URL it serves", () => {
    const getUser = sym(changed, "src/handlers/users.ts", "getUser");
    const routes = layer(changed).routesReaching(getUser).routes;
    expect(routes.map((r) => `${r.registration.methods.join(",")} ${r.registration.pattern} ${r.hops}`)).toEqual(["GET /users/:id 0"]);
    expect(routes[0]?.registration.mountedVia.map((s) => `${s.file}:${s.line}`)).toEqual(["src/app.ts:12"]);
  });

  it("answers which route reaches a function the handler calls, one hop out, so a change below a handler still names its route", () => {
    const findUser = sym(changed, "src/store.ts", "findUser");
    const routes = layer(changed).routesReaching(findUser).routes;
    expect(routes.map((r) => `${r.registration.pattern} ${r.hops}`)).toEqual(["/users/:id 1"]);
  });

  it("keeps the middleware chain of a route in order, the application's before the mount's before the route's own", () => {
    const post = reg(changed, "src/routes/users.ts:9");
    const chain = layer(changed)
      .edgesFrom(post.id)
      .filter((e) => e.kind === "applies_middleware")
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((e) => changed.nodes.get(e.to)?.name);
    expect(chain).toEqual(["logRequests", "requireAuth", "validate"]);
  });

  it("never lets a handler change reach the second application, though both serve GET /health", () => {
    const status = sym(changed, "src/handlers/health.ts", "status");
    const apps = new Set(layer(changed).routesReaching(status).routes.map((r) => r.registration.app));
    expect(apps).toEqual(new Set(["fw:express:app:src/app.ts:7", "fw:express:app:src/admin.ts:5"]));
    const getUser = sym(changed, "src/handlers/users.ts", "getUser");
    expect(layer(changed).routesReaching(getUser).routes.every((r) => r.registration.app === "fw:express:app:src/app.ts:7")).toBe(true);
  });

  it("keeps a route whose handler the change deleted, bound before and missing after, with an unknown naming the handler", () => {
    expect(reg(base, "src/routes/users.ts:10").handler.status).toBe("bound");
    const after = reg(changed, "src/routes/users.ts:10");
    expect(after.handler.status).toBe("missing");
    expect(after.pattern).toBe("/users/:id");
    const gap = changed.frameworks?.unknowns.find((u) => u.plugin === "express" && u.site?.file === "src/routes/users.ts" && u.site.line === 10);
    expect(gap?.cause).toBe("miss");
    expect(gap?.name).toBe("removeUser");
  });

  it("lists the tests of a handler as a request that may reach its route and a direct call, never as coverage", () => {
    const getUser = sym(changed, "src/handlers/users.ts", "getUser");
    const links = layer(changed)
      .testsOf(getUser)
      .map((l) => `${l.test} ${l.category} ${l.tier}`)
      .sort();
    expect(links).toEqual(["tests/users.test.ts direct-call certain", "tests/users.test.ts route-request likely"]);
  });

  it("does not bind a wrapped handler to the function inside the wrapper, and says why", () => {
    const wrapped = reg(changed, "src/routes/items.ts:8");
    expect(wrapped.handler.status).toBe("unresolved");
    expect(layer(changed).routesReaching(sym(changed, "src/handlers/items.ts", "getItem")).routes).toEqual([]);
    const gap = changed.frameworks?.unknowns.find((u) => u.plugin === "express" && u.site?.file === "src/routes/items.ts" && u.site.line === 8);
    expect(gap?.note).toContain("asyncHandler");
  });
});
