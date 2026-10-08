// A repository can be written to attack the Express plugin: the plugin reads
// route files a stranger controls. These tests build a hostile repository of
// more than 1 MiB (thousands of nested routers, a mount chain that loops, a
// diamond of routers that doubles at every level, thousands of routes on one
// router, a path pattern with hundreds of wildcards, a file over the byte
// cap) and check that the plugin finishes well inside a second, stops at
// each cap, and says so with an unknown.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildGraph } from "../../index.js";
import type { Graph } from "../../index.js";
import { parserFor } from "../../parser.js";
import { readFacts } from "./facts.js";
import { MAX_SOURCE_BYTES } from "./js.js";
import { matches, MAX_MIDDLEWARE_CHAIN, MAX_MOUNTS_PER_APP, MAX_REGISTRATIONS_PER_APP } from "./resolve.js";

const files: Record<string, string> = {};
const HEAD = 'import express, { Router } from "express";\nimport { h } from "./h.js";\n';

// Thousands of routers in a chain, the last mounting the first again.
function chain(n: number): string {
  const lines = [HEAD, "export const app = express();"];
  for (let i = 0; i < n; i++) lines.push(`const c${i} = Router();`);
  for (let i = 0; i < n - 1; i++) lines.push(`c${i}.use("/c", c${i + 1});`);
  lines.push(`c${n - 1}.use("/loop", c0);`, 'app.use("/", c0);', `c${n - 1}.get("/end", h);`);
  return lines.join("\n");
}

// A diamond: every router mounts the next one three times, so the routes triple at every level.
function diamond(levels: number): string {
  const lines = [HEAD, "export const dapp = express();"];
  for (let i = 0; i <= levels; i++) lines.push(`const d${i} = Router();`);
  for (let i = 0; i < levels; i++) lines.push(`d${i}.use("/p", d${i + 1});`, `d${i}.use("/q", d${i + 1});`, `d${i}.use("/r", d${i + 1});`);
  lines.push('dapp.use("/", d0);');
  for (let i = 0; i < 40; i++) lines.push(`d${levels}.get("/r${i}", h);`);
  return lines.join("\n");
}

// A thousand routes on one router, mounted six times, and hundreds of
// middleware. (The core keeps 2,000 facts of one file, so one file cannot
// hold more routes than that; mounting them six times makes 6,000.)
function wide(routes: number, middleware: number): string {
  const lines = [HEAD, "export const wapp = express();", "const w = Router();"];
  for (let i = 0; i < middleware; i++) lines.push(`wapp.use(h);`);
  for (let i = 0; i < routes; i++) lines.push(`w.get("/w${i}/:id", h);`);
  for (const m of ["a", "b", "c", "d", "e", "f"]) lines.push(`wapp.use("/${m}", w);`);
  return lines.join("\n");
}

// A path pattern with hundreds of wildcards and optional segments, and a test that requests a long path.
const STARS = `/${Array.from({ length: 300 }, (_, i) => `:p${i}?`).join("/")}/${"*a".repeat(300)}`;
function wildcard(): string {
  return [HEAD, 'import request from "supertest";', "export const sapp = express();", `sapp.get(${JSON.stringify(STARS)}, h);`, 'sapp.get("/*/*/*/*/*/*/*/*/*/*/*/*/*/*/*/*", h);', `request(sapp).get(${JSON.stringify(`/${"a/".repeat(2000)}b`)});`].join("\n");
}

function pad(source: string, bytes: number): string {
  const filler = "\n// padding to reach the size of a large generated route file\n";
  return source + filler.repeat(Math.max(0, Math.ceil((bytes - source.length) / filler.length)));
}

let root: string;
let graph: Graph;
let factsMs = 0;

beforeAll(async () => {
  files["package.json"] = JSON.stringify({ name: "hostile", private: true, type: "module", dependencies: { express: "^4.21.2", supertest: "^7.1.0" } });
  files["src/h.ts"] = "export function h(_req: unknown, _res: unknown): void {}\n";
  // Thousands of nested routers: three chains of 900 (the core keeps 2,000 facts of one file).
  files["src/chain.ts"] = pad(chain(900), 200 * 1024);
  files["src/chain2.ts"] = pad(chain(900), 200 * 1024);
  files["src/chain3.ts"] = pad(chain(900), 200 * 1024);
  files["src/diamond.ts"] = pad(diamond(30), 120 * 1024);
  files["src/wide.ts"] = pad(wide(1000, 300), 240 * 1024);
  files["src/wildcard.ts"] = pad(wildcard(), 200 * 1024);
  // Over the byte cap: the plugin must not read it, and must say so.
  files["src/huge.ts"] = pad(wide(100, 1), MAX_SOURCE_BYTES + 64 * 1024);
  const total = Object.values(files).reduce((n, s) => n + Buffer.byteLength(s), 0);
  expect(total).toBeGreaterThan(1024 * 1024);

  root = mkdtempSync(join(tmpdir(), "oq-express-hostile-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const run = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
  run("init", "-q");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "test");
  run("add", "-A");
  run("commit", "-q", "-m", "hostile");

  const parser = await parserFor("typescript");
  for (const [path, content] of Object.entries(files)) {
    if (!path.endsWith(".ts")) continue;
    const tree = parser.parse(content);
    if (!tree) throw new Error(`no tree for ${path}`);
    const t0 = performance.now();
    readFacts(tree.rootNode);
    factsMs += performance.now() - t0;
    tree.delete();
  }
  graph = await buildGraph({ repoRoot: root, store: null, maxFileBytes: 2 * 1024 * 1024, budgetMs: 120_000 });
}, 120_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the Express plugin on a hostile repository", () => {
  it("reads the facts of more than 1 MiB of crafted route files in under a second", () => {
    expect(factsMs).toBeLessThan(1000);
  });

  it("resolves a crafted repository in under a second, so a route file cannot hang the build", () => {
    const run = graph.frameworks?.plugins.find((p) => p.id === "express");
    expect(run?.status).toBe("ok");
    expect(run?.ms ?? Infinity).toBeLessThan(1000);
  });

  it("does not read a file over the byte cap, and says so with an unknown", () => {
    const gap = graph.frameworks?.unknowns.find((u) => u.plugin === "express" && u.cause === "file-not-parsed" && u.site?.file === "src/huge.ts");
    expect(gap?.note).toContain(String(MAX_SOURCE_BYTES));
    expect(graph.frameworks?.entities.some((e) => e.kind === "registration" && e.site.file === "src/huge.ts")).toBe(false);
  });

  it("stops a diamond of routers at the mount cap and the registration cap, and says how far it got", () => {
    const capped = graph.frameworks?.unknowns.filter((u) => u.plugin === "express" && u.cause === "fan-out-capped") ?? [];
    expect(capped.some((u) => "app" in u.scope && u.scope.app === "fw:express:app:src/diamond.ts:4" && u.note.includes(`${MAX_MOUNTS_PER_APP} router mounts`))).toBe(true);
    expect(capped.some((u) => "app" in u.scope && u.scope.app === "fw:express:app:src/wide.ts:4" && u.note.includes(`${MAX_REGISTRATIONS_PER_APP} registrations`))).toBe(true);
    const perApp = new Map<string, number>();
    for (const e of graph.frameworks?.entities ?? []) if (e.kind === "registration" && e.app) perApp.set(e.app, (perApp.get(e.app) ?? 0) + 1);
    for (const n of perApp.values()) expect(n).toBeLessThanOrEqual(MAX_REGISTRATIONS_PER_APP);
  });

  it("caps the middleware chain of a route and says how many were left out", () => {
    const chainEdges = new Map<string, number>();
    for (const e of graph.frameworks?.edges ?? []) if (e.plugin === "express" && e.kind === "applies_middleware") chainEdges.set(e.from, (chainEdges.get(e.from) ?? 0) + 1);
    for (const n of chainEdges.values()) expect(n).toBeLessThanOrEqual(MAX_MIDDLEWARE_CHAIN);
    expect(graph.frameworks?.unknowns.some((u) => u.plugin === "express" && u.cause === "fan-out-capped" && u.note.includes("middleware"))).toBe(true);
  });

  it("stops a mount chain that loops back on itself without repeating it", () => {
    const loop = graph.frameworks?.entities.filter((e) => e.kind === "registration" && e.site.file === "src/chain.ts") ?? [];
    expect(loop.length).toBeLessThanOrEqual(1);
  });

  it("matches a request path against a pattern of hundreds of wildcards in linear time, with no regular expression", () => {
    const t0 = performance.now();
    expect(matches(STARS, `/${"a/".repeat(5000)}b`)).toBe(false);
    expect(matches("/*/*/*/*/*/*/*/*/*/*/*/*/*/*/*/*", `/${"a/".repeat(5000)}b`)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it("still matches the patterns Express serves: a parameter, an optional parameter and a wildcard segment", () => {
    expect(matches("/users/:id", "/users/42")).toBe(true);
    expect(matches("/users/:id", "/users/42/x")).toBe(false);
    expect(matches("/users/:id?", "/users")).toBe(true);
    expect(matches("/files/*", "/files/a/b/c")).toBe(true);
    expect(matches("/users", "/users/")).toBe(true);
    expect(matches("/", "/")).toBe(true);
  });
});
