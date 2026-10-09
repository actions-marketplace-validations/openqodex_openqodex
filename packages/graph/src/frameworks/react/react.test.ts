// The React plugin on the sample application of the corpus
// (corpus/frameworks/react/react-app), built as a real git repository and
// run through the whole graph build, and on files written to look like
// React where the language sees none.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGraph, frameworkLayer } from "../../index.js";
import type { FrameworkLayer, Graph } from "../../index.js";

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

describe("the React plugin on a small real application", () => {
  let root: string;
  let graph: Graph;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "oq-react-"));
    cpSync(join(corpus, "react", "react-app", "base"), root, { recursive: true });
    commit(root);
    cpSync(join(corpus, "react", "react-app", "change"), root, { recursive: true, force: true });
    graph = await buildGraph({ repoRoot: root, store: null });
  }, 60_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("calls useUser a hook because it calls React's hooks, and not useLabel, which only has the name", () => {
    const roles = (id: string) => layer(graph).rolesOf(id).map((r) => r.role);
    expect(roles(sym(graph, "src/hooks/useUser.ts", "useUser"))).toContain("hook");
    expect(roles(sym(graph, "src/hooks/useLabel.ts", "useLabel"))).not.toContain("hook");
  });
});

describe("the React plugin reads what the language reads", () => {
  let root: string;
  let graph: Graph;
  beforeAll(async () => {
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "diff", private: true, dependencies: { react: "^19.0.0" } }),
      "src/Badge.tsx": "export function Badge() {\n  return <span />;\n}\n",
      "src/Page.tsx": [
        'import { Badge } from "./Badge";',
        "// <Badge /> in a comment renders nothing",
        'export const markup = "<Badge />";',
        "export function Page() {",
        "  return <div>{markup}</div>;",
        "}",
      ].join("\n"),
      // A broken element: the parser cannot read it, so it renders nothing.
      "src/Broken.tsx": ['import { Badge } from "./Badge";', "export function Broken() {", "  return <div><Badge </div>;", "}"].join("\n"),
    };
    root = mkdtempSync(join(tmpdir(), "oq-react-diff-"));
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    commit(root);
    graph = await buildGraph({ repoRoot: root, store: null });
  }, 60_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("renders nothing for an element written in a comment or a string", () => {
    expect(layer(graph).edgesFrom(sym(graph, "src/Page.tsx", "Page")).filter((e) => e.kind === "renders")).toEqual([]);
  });

  it("reads no element from a region with a syntax error, and says the file was not fully read", () => {
    expect((graph.frameworks?.edges ?? []).some((e) => e.plugin === "react" && e.evidence.site.file === "src/Broken.tsx")).toBe(false);
    expect(graph.frameworks?.unknowns.some((u) => u.plugin === "react" && u.cause === "file-not-parsed" && u.site?.file === "src/Broken.tsx")).toBe(true);
  });
});
