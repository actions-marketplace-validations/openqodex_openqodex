// Which files keep the Express plugin's values and scopes (facts.ts,
// `valuesRead`): only a file whose values resolve can read. Ways it could
// fail, written before the code:
// 1. A file with no watched call keeps its values and scopes, so every
//    file's kept facts carry what resolve never reads (on this repository
//    they were 21.6 MB against 11.8 MB before the plugins).
// 2. A file whose values a route rests on loses them: the application's
//    own file, which makes it from express and calls nothing on it, a file
//    that passes the application on under another name, or the route's
//    own file, whose path constant is a value; so a route registered
//    elsewhere no longer resolves, or its path is lost.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildGraph } from "../../index.js";
import type { Graph, Registration } from "../../index.js";
import { parserFor } from "../../parser.js";
import { frameworkFacts } from "../facts.js";

const files: Record<string, string> = {
  "package.json": JSON.stringify({ name: "kept", private: true, type: "module", dependencies: { express: "^4.21.2" } }),
  // Makes the application and calls nothing on it.
  "src/app.ts": ['import express from "express";', "export const app = express();", ""].join("\n"),
  // Passes it on under another name.
  "src/server.ts": ['import { app } from "./app.js";', "export const server = app;", ""].join("\n"),
  // Registers a route on it, with a path built from a constant.
  "src/routes.ts": ['import { server } from "./server.js";', 'import { getUser } from "./users.js";', 'const BASE = "/users";', 'server.get(BASE + "/:id", getUser);', ""].join("\n"),
  // No watched call: values and scopes resolve never reads.
  "src/users.ts": ["export function getUser(req: unknown, res: unknown): void {", "  const id = String(req);", "  void [id, res];", "}", ""].join("\n"),
  "src/plain.ts": ["export const total = [1, 2].reduce((a, b) => a + b, 0);", "export function twice(n: number): number {", "  const m = n * 2;", "  return m;", "}", ""].join("\n"),
};

let root: string;
let graph: Graph;
const kinds = async (path: string): Promise<string[]> => {
  const text = files[path] as string;
  const tree = (await parserFor("typescript")).parse(text);
  if (!tree) throw new Error("no tree");
  try {
    return (frameworkFacts(tree.rootNode, "typescript", text)?.express ?? []).map((f) => f.kind);
  } finally {
    tree.delete();
  }
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "oq-express-kept-"));
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
}, 60_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the Express plugin keeps values only where resolve reads them", () => {
  it("keeps no value or scope of a file with no watched call (1)", async () => {
    for (const path of ["src/users.ts", "src/plain.ts"]) {
      const kept = await kinds(path);
      expect(kept, path).toContain("function");
      expect(kept.filter((k) => k === "value" || k === "scope"), path).toEqual([]);
    }
  });

  it("keeps the values of the application's file, of an alias that passes it on, and of the route's file, and still resolves the route (2)", async () => {
    for (const path of ["src/app.ts", "src/server.ts", "src/routes.ts"]) expect(await kinds(path), path).toContain("value");
    const routes = (graph.frameworks?.entities ?? []).filter((e): e is Registration => e.kind === "registration" && e.plugin === "express");
    expect(routes.map((r) => `${r.methods.join(",")} ${r.pattern} ${r.handler.status} ${r.site.file}`)).toEqual(["GET /users/:id bound src/routes.ts"]);
    expect(routes[0]?.handler.targets.map((t) => graph.nodes.get(t)?.file)).toEqual(["src/users.ts"]);
  });
});
