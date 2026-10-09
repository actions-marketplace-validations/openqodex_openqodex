// The Next.js plugin on the sample application of the corpus
// (corpus/frameworks/nextjs/nextjs-app), built as a real git repository
// and run through the whole graph build, and on middleware matchers the
// plugin can and cannot read.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGraph, frameworkLayer } from "../../index.js";
import type { FrameworkLayer, Graph, Registration } from "../../index.js";
import { cpuMs, expectLinear } from "../../test-timing.js";
import { intersects, parseMatcher, routeSegments } from "./resolve.js";

const corpus = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "corpus", "frameworks");
function commit(root: string): void {
  const run = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
  run("init", "-q");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "test");
  run("add", "-A");
  run("commit", "-q", "-m", "base");
}
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
const reg = (g: Graph, site: string): Registration => {
  const found = layer(g)
    .registrations()
    .filter((r) => r.plugin === "nextjs" && `${r.site.file}:${r.site.line}` === site);
  if (found.length !== 1) throw new Error(`${found.length} registrations at ${site}`);
  return found[0] as Registration;
};

describe("the Next.js plugin on a small real application", () => {
  let root: string;
  let graph: Graph;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "oq-next-"));
    cpSync(join(corpus, "nextjs", "nextjs-app", "base"), root, { recursive: true });
    commit(root);
    cpSync(join(corpus, "nextjs", "nextjs-app", "change"), root, { recursive: true, force: true });
    graph = await buildGraph({ repoRoot: root, store: null });
  }, 60_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("answers which route maps to a changed route handler, from the file's path", () => {
    const routes = layer(graph).routesReaching(sym(graph, "app/api/users/route.ts", "GET")).routes;
    expect(routes.map((r) => `${r.registration.methods.join(",")} ${r.registration.pattern}`)).toEqual(["GET /api/users"]);
  });

  it("answers which route reaches a function a handler calls, one hop out", () => {
    const routes = layer(graph).routesReaching(sym(graph, "lib/users.ts", "listUsers")).routes;
    expect(routes.map((r) => `${r.registration.methods.join(",")} ${r.registration.pattern} ${r.hops}`)).toEqual(["GET /api/users 1"]);
  });

  it("keeps the app router and the pages router apart, each its own application", () => {
    expect(reg(graph, "app/page.tsx:4").app).toBe("fw:nextjs:app:app/:1");
    expect(reg(graph, "pages/old.tsx:1").app).toBe("fw:nextjs:app:pages/:1");
  });

  it("runs the middleware for the dashboard its matcher selects, and not for the home page", () => {
    const applied = (site: string) =>
      layer(graph)
        .edgesFrom(reg(graph, site).id)
        .filter((e) => e.kind === "applies_middleware").length;
    expect(applied("app/dashboard/page.tsx:4")).toBe(1);
    expect(applied("app/page.tsx:4")).toBe(0);
  });
});

describe("the Next.js plugin reads matchers segment by segment", () => {
  it("selects a route under a matcher with a trailing wildcard, and its own folder", () => {
    const m = parseMatcher("/dashboard/:path*");
    expect(m).not.toBeNull();
    expect(intersects(m ?? [], routeSegments("/dashboard") ?? [])).toBe(true);
    expect(intersects(m ?? [], routeSegments("/dashboard/[id]/edit") ?? [])).toBe(true);
    expect(intersects(m ?? [], routeSegments("/") ?? [])).toBe(false);
    expect(intersects(m ?? [], routeSegments("/blog/[slug]") ?? [])).toBe(false);
  });

  it("matches a dynamic or catch-all route segment against a literal matcher segment", () => {
    expect(intersects(parseMatcher("/blog/intro") ?? [], routeSegments("/blog/[slug]") ?? [])).toBe(true);
    expect(intersects(parseMatcher("/docs/a/b/c") ?? [], routeSegments("/docs/[...rest]") ?? [])).toBe(true);
    expect(intersects(parseMatcher("/docs") ?? [], routeSegments("/docs/[...rest]") ?? [])).toBe(false);
    expect(intersects(parseMatcher("/docs") ?? [], routeSegments("/docs/[[...rest]]") ?? [])).toBe(true);
  });

  it("does not read a matcher with a regular expression group, so the plugin never compiles one", () => {
    expect(parseMatcher("/((?!api|_next/static).*)")).toBeNull();
  });

  it("matches a matcher of sixty wildcards against a deep route in time linear in the route's depth", async () => {
    const m = parseMatcher(`/${Array.from({ length: 60 }, (_, i) => `:p${i}*`).join("/")}/end`) ?? [];
    const route = (depth: number) => routeSegments(`/${Array.from({ length: depth }, (_, i) => `[...r${i}]`).join("/")}/x`) ?? [];
    expect(intersects(m, route(60))).toBe(false);
    const quarter = route(15);
    const full = route(60);
    expectLinear("a matcher of sixty wildcards against routes 15 and 60 deep", await cpuMs(() => intersects(m, quarter)), await cpuMs(() => intersects(m, full)));
  });
});

describe("the Next.js plugin on a middleware whose matcher it cannot read, or that is computed", () => {
  let root: string;
  let graph: Graph;
  beforeAll(async () => {
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "mw", private: true, dependencies: { next: "^15.1.6", react: "^19.0.0" } }),
      "app/page.tsx": "export default function Home() {\n  return null;\n}\n",
      "app/api/ping/route.ts": "// export function POST() {}\nexport function GET() {\n  return new Response(\"pong\");\n}\n",
      "middleware.ts": 'export function middleware() {\n  return undefined;\n}\nexport const config = { matcher: ["/((?!api).*)"] };\n',
      "other/package.json": JSON.stringify({ name: "mw2", private: true, dependencies: { next: "^15.1.6", react: "^19.0.0" } }),
      "other/app/page.tsx": "export default function Other() {\n  return null;\n}\n",
      "other/middleware.ts": 'const paths = ["/a"];\nexport function middleware() {\n  return undefined;\n}\nexport const config = { matcher: paths };\n',
    };
    root = mkdtempSync(join(tmpdir(), "oq-next-mw-"));
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    commit(root);
    graph = await buildGraph({ repoRoot: root, store: null });
  }, 60_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("links a middleware whose matcher is a regular expression to every route as possible, with a note", () => {
    const edges = (graph.frameworks?.edges ?? []).filter((e) => e.plugin === "nextjs" && e.kind === "applies_middleware" && e.to.startsWith("middleware.ts#"));
    expect(edges.length).toBe(2);
    expect(edges.every((e) => e.evidence.tier === "possible" && (e.evidence.note ?? "").includes("does not read"))).toBe(true);
  });

  it("says a computed matcher is unknown and links the middleware to no route", () => {
    expect((graph.frameworks?.edges ?? []).some((e) => e.kind === "applies_middleware" && e.to.startsWith("other/middleware.ts#"))).toBe(false);
    expect(graph.frameworks?.unknowns.some((u) => u.plugin === "nextjs" && u.cause === "dynamic" && u.site?.file === "other/middleware.ts")).toBe(true);
  });

  it("registers no method that is written only in a comment", () => {
    const methods = layer(graph)
      .registrations()
      .filter((r) => r.site.file === "app/api/ping/route.ts")
      .flatMap((r) => r.methods);
    expect(methods).toEqual(["GET"]);
  });
});
