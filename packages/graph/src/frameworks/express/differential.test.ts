// The Express plugin reads routes only from the syntax tree the extractor
// already made, and reads each string the way JavaScript does. A plugin
// that read the text a second way could register a route the language
// would not (one written in a comment or a string) or miss one it would (a
// file that never says "express", an escaped name). These tests write such
// files into a real repository and check what the build reports.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildGraph } from "../../index.js";
import type { Graph, Registration } from "../../index.js";

const B = "\\"; // one backslash, so the escapes below reach the file as written
const files: Record<string, string> = {
  "package.json": JSON.stringify({ name: "diff", private: true, type: "module", dependencies: { express: "^4.21.2" } }),
  "src/app.ts": ['import express from "express";', 'import { h } from "./h.js";', "export const app = express();", 'app.get("/real", h);', "app.listen(1);"].join("\n"),
  "src/h.ts": "export function h(_req: unknown, _res: unknown): void {}\n",
  // Routes registered on an imported application, in a file that never names express.
  "src/more.ts": ['import { app } from "./app.js";', 'import { h } from "./h.js";', 'app.post("/more", h);'].join("\n"),
  // Look-alikes the language never runs, and a route path computed at run time.
  "src/fake.ts": [
    'import { app } from "./app.js";',
    'import { h } from "./h.js";',
    '// app.get("/in-comment", h);',
    "/* app.get(\"/in-block-comment\", h); */",
    'export const text = "app.get(\'/in-string\', h)";',
    "export const tpl = `app.get(\"/in-template\", h)`;",
    "const version = process.env.V;",
    "app.get(`/v${version}/computed`, h);",
  ].join("\n"),
  // Escapes the language decodes: / is "/", \x2F is "/", a backslash before
  // a line break joins the lines, \' is a quote, and get is the name get.
  "src/escapes.ts": [
    'import { app } from "./app.js";',
    'import { h } from "./h.js";',
    `app.get("/a${B}u002fb", h);`,
    `app.get("/c${B}x2Fd", h);`,
    `app.get("/e${B}`,
    `f", h);`,
    `app.get('/it${B}'s', h);`,
    `app.${B}u0067et("/escaped-name", h);`,
  ].join("\n"),
  // A call cut short by a syntax error: the language would not run the file.
  "src/broken.ts": ['import { app } from "./app.js";', 'import { h } from "./h.js";', 'app.get("/broken", h', 'app.get("/after", h);'].join("\n"),
};

let root: string;
let graph: Graph;
const regs = (): Registration[] => (graph.frameworks?.entities ?? []).filter((e): e is Registration => e.kind === "registration" && e.plugin === "express");
const patterns = (): string[] => regs().map((r) => String(r.pattern)).sort();

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "oq-express-diff-"));
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

describe("the Express plugin reads what the language reads", () => {
  it("registers nothing for a route written in a comment, a string or a template with no code in it", () => {
    for (const p of ["/in-comment", "/in-block-comment", "/in-string", "/in-template"]) expect(patterns()).not.toContain(p);
  });

  it("records a route path computed at run time as a gap with the handler named, not as a route", () => {
    expect(regs().some((r) => r.site.file === "src/fake.ts")).toBe(false);
    const gap = graph.frameworks?.unknowns.find((u) => u.plugin === "express" && u.site?.file === "src/fake.ts" && u.site.line === 8);
    expect(gap?.cause).toBe("dynamic");
    expect(gap?.name).toBe("h");
    expect(graph.frameworks?.edges.some((e) => e.kind === "handles" && e.evidence.site.file === "src/fake.ts")).toBe(false);
  });

  it("finds routes in a file that never names express, on an application it imports", () => {
    expect(patterns()).toContain("/more");
  });

  it("decodes string escapes as JavaScript does: unicode and hex escapes, a joined line, an escaped quote", () => {
    expect(patterns()).toEqual(expect.arrayContaining(["/a/b", "/c/d", "/ef", "/it's"]));
  });

  it("reads a property name written with a unicode escape as the name it spells", () => {
    expect(patterns()).toContain("/escaped-name");
  });

  it("reads no route from a region with a syntax error, and says the file was not fully read", () => {
    expect(patterns()).not.toContain("/broken");
    const gap = graph.frameworks?.unknowns.find((u) => u.plugin === "express" && u.cause === "file-not-parsed" && u.site?.file === "src/broken.ts");
    expect(gap).toBeDefined();
  });
});
