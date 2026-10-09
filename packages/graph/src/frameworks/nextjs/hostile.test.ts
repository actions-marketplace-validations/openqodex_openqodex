// A repository can be written to attack the Next.js plugin: its routes come
// from a file tree a stranger controls. This test builds a hostile
// repository of more than 1 MiB that splits its routes over 1,500 route
// files of seven methods each (more routes than the build's budget, though
// no file holds more than seven), a page seventy folders deep, a middleware
// with sixty wildcards, and a file over the byte cap, and checks that the
// plugin finishes well inside a second, stops at the budget, and says so.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildGraph } from "../../index.js";
import type { Graph } from "../../index.js";
import { MAX_SOURCE_BYTES } from "../express/js.js";
import { MAX_PATTERN_SEGMENTS, MAX_REGISTRATIONS } from "./resolve.js";

const METHODS = ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"];

describe("the Next.js plugin on a hostile repository", () => {
  let root: string;
  let graph: Graph;
  beforeAll(async () => {
    const files: Record<string, string> = { "package.json": JSON.stringify({ name: "hostile", private: true, dependencies: { next: "^15.1.6", react: "^19.0.0" } }) };
    const handler = METHODS.map((m) => `export function ${m}() {\n  return new Response("${m}");\n}`).join("\n");
    // Each file differs, so each is parsed and read on its own.
    for (let i = 0; i < 1500; i++) files[`app/api/r${i}/[id]/route.ts`] = `${handler}\nexport const id = ${i};\n// ${"padding ".repeat(60)}\n`;
    files[`app/${Array.from({ length: 70 }, (_, i) => `d${i}`).join("/")}/page.tsx`] = "export default function Deep() {\n  return null;\n}\n";
    files["middleware.ts"] = `export function middleware() {\n  return undefined;\n}\nexport const config = { matcher: ["/${Array.from({ length: 60 }, (_, i) => `:p${i}*`).join("/")}/end"] };\n`;
    files["app/huge/page.tsx"] = `export default function Huge() {\n  return null;\n}\n${"// padding\n".repeat(Math.ceil((MAX_SOURCE_BYTES + 64 * 1024) / 11))}`;
    const total = Object.values(files).reduce((n, s) => n + Buffer.byteLength(s), 0);
    expect(total).toBeGreaterThan(1024 * 1024);
    root = mkdtempSync(join(tmpdir(), "oq-next-hostile-"));
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
    graph = await buildGraph({ repoRoot: root, store: null, maxFileBytes: 2 * 1024 * 1024, budgetMs: 120_000 });
  }, 600_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("resolves a crafted file tree in under a second, so a route tree cannot hang the build", () => {
    const run = graph.frameworks?.plugins.find((p) => p.id === "nextjs");
    expect(run?.status).toBe("ok");
    expect(run?.ms ?? Infinity).toBeLessThan(1000);
  });

  it("stops at the build's registration budget, though no file holds more than seven routes, and says how many were left out", () => {
    const regs = (graph.frameworks?.entities ?? []).filter((e) => e.kind === "registration" && e.plugin === "nextjs");
    expect(regs.length).toBe(MAX_REGISTRATIONS);
    const cut = graph.frameworks?.unknowns.find((u) => u.plugin === "nextjs" && u.note.includes(`${MAX_REGISTRATIONS} in one build`));
    expect(cut?.count).toBe(1500 * 7 + 1 - MAX_REGISTRATIONS);
  });

  it("does not read a route seventy folders deep, and says so", () => {
    expect(graph.frameworks?.unknowns.some((u) => u.plugin === "nextjs" && u.note.includes(`more than ${MAX_PATTERN_SEGMENTS} folders deep`))).toBe(true);
  });

  it("does not read a file over the byte cap, and says so", () => {
    expect(graph.frameworks?.unknowns.some((u) => u.plugin === "nextjs" && u.cause === "file-not-parsed" && u.site?.file === "app/huge/page.tsx")).toBe(true);
  });
});
