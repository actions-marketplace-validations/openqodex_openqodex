// Cases a review of the Next.js plugin found: a matcher list the reader cut
// read as if whole, a middleware file with no function the graph holds left
// out silently, and a matching budget or a route past the matcher's reach
// reported as syntax the plugin does not read.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildGraph } from "../../index.js";
import type { FrameworkEdge, Graph, Registration } from "../../index.js";
import { MAX_MATCH_WORK } from "./resolve.js";

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "oq-next-review-"));
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
  return root;
}
const pkg = (name: string) => JSON.stringify({ name, private: true, dependencies: { next: "^15.1.6", react: "^19.0.0" } });
const page = (name: string) => `export default function ${name}() {\n  return null;\n}\n`;
const middlewareEdges = (g: Graph, project: string): FrameworkEdge[] => (g.frameworks?.edges ?? []).filter((e) => e.plugin === "nextjs" && e.kind === "applies_middleware" && e.to.startsWith(`${project}/middleware.ts#`));
const reg = (g: Graph, file: string): Registration | undefined => (g.frameworks?.entities ?? []).find((e): e is Registration => e.kind === "registration" && e.site.file === file);

describe("the Next.js plugin on matchers and middleware it cannot read whole", () => {
  let root: string;
  let graph: Graph;
  beforeAll(async () => {
    const thirty = Array.from({ length: 29 }, (_, i) => JSON.stringify(`/other${i}`)).join(", ");
    root = repo({
      // A matcher list of 30 entries; only the last selects the dashboard.
      "cut/package.json": pkg("cut"),
      "cut/app/dashboard/page.tsx": page("Dashboard"),
      "cut/middleware.ts": `export function middleware() {\n  return undefined;\n}\nexport const config = { matcher: [${thirty}, "/dashboard"] };\n`,
      // A middleware file whose function is a value the code makes.
      "made/package.json": pkg("made"),
      "made/app/page.tsx": page("Home"),
      "made/middleware.ts": "function wrap(f: () => void) {\n  return f;\n}\nexport const middleware = wrap(() => undefined);\n",
      // A route deeper than the matcher reads.
      "deep/package.json": pkg("deep"),
      [`deep/app/${Array.from({ length: 66 }, (_, i) => `d${i}`).join("/")}/page.tsx`]: page("Deep"),
      "deep/app/page.tsx": page("Home"),
      "deep/middleware.ts": 'export function middleware() {\n  return undefined;\n}\nexport const config = { matcher: ["/:path*"] };\n',
    });
    graph = await buildGraph({ repoRoot: root, store: null });
  }, 120_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("never reads a cut matcher list as whole: a route only a later entry could select is possible, and the cut is an unknown", () => {
    const edges = middlewareEdges(graph, "cut");
    expect(edges.map((e) => e.evidence.tier)).toEqual(["possible"]);
    expect(edges[0]?.evidence.note).toContain("past the");
    expect(graph.frameworks?.unknowns.some((u) => u.plugin === "nextjs" && u.cause === "fan-out-capped" && u.site?.file === "cut/middleware.ts")).toBe(true);
  });

  it("says when the middleware file's function is not a definition the graph holds, rather than linking nothing silently", () => {
    expect(middlewareEdges(graph, "made")).toEqual([]);
    const gap = graph.frameworks?.unknowns.find((u) => u.plugin === "nextjs" && u.site?.file === "made/middleware.ts");
    expect(gap?.affects).toContain("applies_middleware");
  });

  it("says a route deeper than the matcher reads may run the middleware because of its depth, not because of the matcher's syntax", () => {
    const deep = (graph.frameworks?.entities ?? []).find((e): e is Registration => e.kind === "registration" && e.site.file.startsWith("deep/app/d0/"));
    expect(deep).toBeUndefined();
    const home = reg(graph, "deep/app/page.tsx");
    const edge = middlewareEdges(graph, "deep").find((e) => e.from === home?.id);
    expect(edge?.evidence.tier).toBe("certain");
  });
});

describe("the Next.js plugin when the matching budget runs out", () => {
  let root: string;
  let graph: Graph;
  beforeAll(async () => {
    const segs = (p: string) => Array.from({ length: 60 }, (_, i) => `${p}${i}`).join("/");
    const files: Record<string, string> = { "package.json": pkg("budget") };
    const methods = ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"].map((m) => `export function ${m}() {\n  return new Response("${m}");\n}`).join("\n");
    for (let i = 0; i < 12; i++) files[`app/r${i}/${segs("s")}/route.ts`] = `${methods}\nexport const id = ${i};\n`;
    const matchers = Array.from({ length: 24 }, (_, i) => JSON.stringify(`/m${i}/${segs("x")}`)).join(", ");
    files["middleware.ts"] = `export function middleware() {\n  return undefined;\n}\nexport const config = { matcher: [${matchers}] };\n`;
    root = repo(files);
    graph = await buildGraph({ repoRoot: root, store: null });
  }, 600_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("stops matching when the budget runs out and says so with one budget unknown, never blaming the matcher's syntax", () => {
    const gap = graph.frameworks?.unknowns.filter((u) => u.plugin === "nextjs" && u.cause === "budget" && u.note.includes(String(MAX_MATCH_WORK)));
    expect(gap?.length).toBe(1);
    const notes = middlewareEdges(graph, "").map((e) => e.evidence.note ?? "");
    expect(notes.some((n) => n.includes("does not read"))).toBe(false);
  });
});
