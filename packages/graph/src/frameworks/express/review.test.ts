// Cases a review of the Express plugin found, each a way the plugin could
// state a route, a pattern or a chain as proved when the code does not
// prove it, or drop a gap without saying so. Each file of the repository
// below plants one; each test names the failure it guards.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildGraph } from "../../index.js";
import type { FrameworkUnknown, Graph, Registration } from "../../index.js";
import { MAX_APPS, MAX_MATCH_WORK, MAX_TEST_REQUESTS } from "./resolve.js";

const H = 'import { h } from "./h.js";';
const many = (n: number) => Array.from({ length: n }, () => "h").join(", ");
const deep = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`).join("/");
const files: Record<string, string> = {
  "package.json": JSON.stringify({ name: "review", private: true, type: "module", dependencies: { express: "^4.21.2", supertest: "^7.1.0" }, devDependencies: { vitest: "^3.2.4" } }),
  "src/h.ts": "export function h(_req: unknown, _res: unknown, next?: () => void): void {\n  next?.();\n}\nexport function last(_req: unknown, _res: unknown): void {}\nexport function chooseAuth(): (req: unknown, res: unknown, next: () => void) => void {\n  return (_q, _s, next) => next();\n}\n",
  // A factory parameter named express shadows the import: its call makes no Express application.
  "src/shadow.ts": ['import express from "express";', H, "export function build(express: () => { get(p: string, f: unknown): void }) {", "  const app = express();", '  app.get("/shadowed", h);', "  return app;", "}", "export const real = express();"].join("\n"),
  // A mount under a computed prefix, then a literal mount below it.
  "src/nested.ts": ['import express, { Router } from "express";', H, "const tenant = process.env.TENANT;", "export const app = express();", "const r = Router();", "const child = Router();", 'child.get("/x", h);', 'r.use("/v1", child);', "app.use(`/${tenant}`, r);"].join("\n"),
  // A path held in a binding that changes: no literal proves which path is registered.
  "src/mutable.ts": ['import express from "express";', H, "export const app = express();", 'let path = "/old";', 'path = "/new";', "app.get(path, h);", 'const FIXED = "/fixed";', "export function inner(FIXED: string) {", "  app.get(FIXED, h);", "}", "app.get(FIXED, h);"].join("\n"),
  // A route with more arguments than the reader keeps: the handler is past the cut.
  "src/wide.ts": ['import express from "express";', 'import { h, last } from "./h.js";', "export const app = express();", `app.get("/wide", ${many(30)}, last);`].join("\n"),
  // Middleware whose function is a value the code computes.
  "src/auth.ts": ['import express from "express";', 'import { chooseAuth, h } from "./h.js";', "export const app = express();", "const auth = chooseAuth();", "app.use(auth);", 'app.get("/guarded", h);'].join("\n"),
  // A route deeper than the matcher reads, a route it cannot read, and the test requests for both.
  "src/long.ts": ['import express from "express";', H, "export const app = express();", `app.get("/${deep(70)}", h);`, 'app.get("/re/:id(\\\\d+)", h);'].join("\n"),
  "src/long.test.ts": ['import request from "supertest";', 'import { it } from "vitest";', 'import { app } from "./long.js";', 'it("reaches the long route", async () => {', `  await request(app).get("/${deep(70)}");`, '  await request(app).get("/re/42");', "});"].join("\n"),
};

let root: string;
let graph: Graph;
const regs = (file: string): Registration[] => (graph.frameworks?.entities ?? []).filter((e): e is Registration => e.kind === "registration" && e.plugin === "express" && e.site.file === file);
const gaps = (file: string): FrameworkUnknown[] => (graph.frameworks?.unknowns ?? []).filter((u) => u.plugin === "express" && u.site?.file === file);

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "oq-express-review-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const run = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
  run("init", "-q");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "test");
  run("add", "-A");
  run("commit", "-q", "-m", "base");
  graph = await buildGraph({ repoRoot: root, store: null });
}, 120_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the Express plugin on what a review found", () => {
  it("makes no application from a call of a parameter that shadows the express import", () => {
    expect(regs("src/shadow.ts")).toEqual([]);
    expect(graph.frameworks?.apps.filter((a) => a.plugin === "express" && a.site.file === "src/shadow.ts").map((a) => a.site.line)).toEqual([8]);
  });

  it("keeps the pattern unknown under every mount below a computed prefix, never restarting from the literal mount", () => {
    const x = regs("src/nested.ts");
    expect(x.map((r) => r.pattern)).toEqual([null]);
  });

  it("does not take a path from a binding that is reassigned or shadowed: each such route is a dynamic unknown", () => {
    const patterns = regs("src/mutable.ts").map((r) => r.pattern);
    expect(patterns).not.toContain("/old");
    expect(patterns).not.toContain("/new");
    expect(gaps("src/mutable.ts").some((u) => u.site?.line === 6 && u.cause === "dynamic")).toBe(true);
    // The module constant at module level is a literal; the parameter that shadows it is not.
    expect(patterns).toEqual(["/fixed"]);
    expect(gaps("src/mutable.ts").some((u) => u.site?.line === 9 && u.cause === "dynamic")).toBe(true);
  });

  it("never names a middleware as the handler when the reader cut the argument list, and says the list was cut", () => {
    const [wide] = regs("src/wide.ts");
    expect(wide?.handler.status).toBe("unresolved");
    expect(wide?.handler.targets).toEqual([]);
    expect(gaps("src/wide.ts").some((u) => u.cause === "fan-out-capped")).toBe(true);
  });

  it("says when a middleware in a route's chain cannot be bound, rather than leaving it out silently", () => {
    const gap = gaps("src/auth.ts").find((u) => u.affects.includes("applies_middleware"));
    expect(gap?.cause).toBe("dynamic");
    expect(gap?.name).toBe("auth");
  });

  it("keeps at most the build's applications and says how many were left out, so the stage can always append them", async () => {
    const many: Record<string, string> = { "package.json": files["package.json"] as string, "src/h.ts": files["src/h.ts"] as string };
    for (let f = 0; f < 2; f++) many[`src/apps${f}.ts`] = ['import express from "express";', ...Array.from({ length: 1100 }, (_, i) => `export const a${i} = express();`)].join("\n");
    const at = mkdtempSync(join(tmpdir(), "oq-express-apps-"));
    try {
      for (const [path, content] of Object.entries(many)) {
        mkdirSync(dirname(join(at, path)), { recursive: true });
        writeFileSync(join(at, path), content);
      }
      const run = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: at, encoding: "utf8" });
      run("init", "-q");
      run("config", "user.email", "test@example.com");
      run("config", "user.name", "test");
      run("add", "-A");
      run("commit", "-q", "-m", "apps");
      const g = await buildGraph({ repoRoot: at, store: null });
      expect(g.frameworks?.apps.filter((a) => a.plugin === "express").length).toBe(MAX_APPS);
      expect(g.frameworks?.unknowns.find((u) => u.plugin === "express" && u.note.includes(`${MAX_APPS} applications`))?.count).toBe(2200 - MAX_APPS);
    } finally {
      rmSync(at, { recursive: true, force: true });
    }
  }, 120_000);

  // A repository of its own for each budget, so one cap's unknown cannot be
  // mistaken for the other's.
  async function buildRepo(prefix: string, own: Record<string, string>): Promise<Graph> {
    const at = mkdtempSync(join(tmpdir(), prefix));
    try {
      for (const [path, content] of Object.entries({ "package.json": files["package.json"] as string, "src/h.ts": files["src/h.ts"] as string, ...own })) {
        mkdirSync(dirname(join(at, path)), { recursive: true });
        writeFileSync(join(at, path), content);
      }
      const run = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: at, encoding: "utf8" });
      run("init", "-q");
      run("config", "user.email", "test@example.com");
      run("config", "user.name", "test");
      run("add", "-A");
      run("commit", "-q", "-m", "budget");
      return await buildGraph({ repoRoot: at, store: null });
    } finally {
      rmSync(at, { recursive: true, force: true });
    }
  }
  const testFile = (requests: string[]) => ['import request from "supertest";', 'import { it } from "vitest";', 'import { app } from "./app.js";', 'it("requests", async () => {', ...requests.map((p) => `  await request(app).get("${p}");`), "});"].join("\n");
  const unmatched = (g: Graph) => (g.frameworks?.unknowns ?? []).filter((u) => u.plugin === "express" && u.affects.includes("tests") && u.site === null);

  it("names the pattern-step budget, not the request cap, when matching runs out of steps", async () => {
    // 100 routes and requests of 60 segments: each request costs about 370,000 steps.
    const params = Array.from({ length: 60 }, (_, i) => `:p${i}`).join("/");
    const path = `/${Array.from({ length: 60 }, (_, i) => `v${i}`).join("/")}`;
    const app = ['import express from "express";', H, "export const app = express();", ...Array.from({ length: 100 }, (_, i) => `app.get("/${params}", h); // ${i}`)].join("\n");
    const g = await buildRepo("oq-express-steps-", { "src/app.ts": app, "src/app.test.ts": testFile(Array.from({ length: 30 }, () => path)) });
    const cut = unmatched(g);
    expect(cut.map((u) => u.cause)).toEqual(["budget"]);
    expect(cut[0]?.note).toContain(String(MAX_MATCH_WORK));
    expect(cut[0]?.note).not.toContain(String(MAX_TEST_REQUESTS));
    expect(cut[0]?.count).toBeGreaterThan(0);
  }, 120_000);

  it("names the request cap, not the pattern-step budget, when a build has more test requests than it matches", async () => {
    const app = ['import express from "express";', H, "export const app = express();", 'app.get("/x", h);'].join("\n");
    // Spread over three files, each under the facts the stage keeps per file.
    const tests: Record<string, string> = {};
    for (let f = 0; f < 3; f++) tests[`src/app${f}.test.ts`] = testFile(Array.from({ length: (MAX_TEST_REQUESTS + 100) / 3 }, () => "/x"));
    const g = await buildRepo("oq-express-requests-", { "src/app.ts": app, ...tests });
    const cut = unmatched(g);
    expect(cut.map((u) => u.count)).toEqual([100]);
    expect(cut[0]?.note).toContain(String(MAX_TEST_REQUESTS));
    expect(cut[0]?.note).not.toContain(String(MAX_MATCH_WORK));
  }, 120_000);

  it("says when a test request could not be matched because the route or the request is beyond what the matcher reads", () => {
    const atRequests = gaps("src/long.test.ts").filter((u) => u.affects.includes("tests"));
    expect(atRequests.map((u) => u.site?.line).sort()).toEqual([5, 6]);
  });
});
