// Reopening a kept build from a new process. Ways it could fail, each on a
// real repo with the real store:
// 1. A build kept as an index reads back as another graph (retained is not
//    equal to fresh): nodes, edges with their sites and tiers, unknowns.
// 2. A build kept without an index, reopened from its facts, answers
//    differently from the build that made it.
// 3. After the files are edited (and the objects collected), the bytes the
//    build read cannot be shown any more: `git show <tree>:<path>` must
//    still read them while the build is kept.
// 4. A build whose facts were collected reopens as complete instead of
//    saying it is partial.
// 5. A build that left out only files over the size cap (which the next
//    build leaves out the same way) counts as incomplete, so in a
//    repository with one large file no index is ever kept or loaded.
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { buildGraph, openStore } from "../src/index.js";
import type { Graph } from "../src/index.js";
import { graphOf } from "../src/session.js";
import { commitAll, makeRepo, writeFiles } from "./helpers.js";

const repos: string[] = [];
afterAll(() => {
  for (const r of repos) rmSync(r, { recursive: true, force: true });
});

const files = {
  "src/a.ts": "export function a() {\n  return b();\n}\nexport function b() {\n  return 1;\n}\n",
  "src/c.ts": 'import { a } from "./a";\nexport function c(x: { y(): void }) {\n  x.y();\n  return a();\n}\n',
  "py/m.py": "def f():\n    return g()\n\ndef g():\n    return 1\n",
};

// The parts of a graph an answer reads, in a form that compares.
function shape(g: Graph) {
  return {
    nodes: [...g.nodes.keys()].sort(),
    edges: g.edges.map((e) => `${e.kind} ${e.from} ${e.to} ${e.tier} ${e.sites.map((s) => `${s.file}:${s.line}:${s.column}:${s.tier}:${s.evidence}:${s.rule}`).join(",")}`).sort(),
    unknowns: g.unknowns.map((u) => `${u.file}:${u.line}:${u.column}:${u.name}:${u.cause}:${u.scope}`).sort(),
    importers: [...g.importers.entries()].map(([k, v]) => `${k}<-${v.map((e) => e.from).sort().join(",")}`).sort(),
  };
}

async function store(root: string) {
  const s = await openStore(root);
  if (!s.ok) throw new Error(s.reason);
  return s.store;
}

describe("reopening a kept build", () => {
  it("reads an index back as the same graph the build made (1)", async () => {
    const root = makeRepo(files);
    repos.push(root);
    const st = await store(root);
    const built = await buildGraph({ repoRoot: root, store: st, mode: "retained" });
    expect(built.status.generation).not.toBeNull();
    const gen = st.open({ id: built.status.generation as string });
    expect(gen?.manifest.hasIndex).toBe(true);
    const back = graphOf(st, gen!) as Graph;
    expect(shape(back)).toEqual(shape(built));
    // Every field, notes and the import lines that proved each site included.
    expect(back.edges).toEqual(built.edges);
    expect(back.unknowns).toEqual(built.unknowns);
    expect(back.misses).toEqual(built.misses);
    expect([...back.nodes.values()]).toEqual([...built.nodes.values()]);
  });

  it("resolves a build kept without an index from its facts to the same graph (2)", async () => {
    const root = makeRepo(files);
    repos.push(root);
    const st = await store(root);
    const built = await buildGraph({ repoRoot: root, store: st, mode: "fresh" });
    const gen = st.open({ id: built.status.generation as string });
    expect(gen?.manifest.hasIndex).toBe(false);
    expect(shape(graphOf(st, gen!) as Graph)).toEqual(shape(built));
  });

  it("still shows the bytes a build read after the file changed and objects were collected (3)", async () => {
    const root = makeRepo(files);
    repos.push(root);
    commitAll(root);
    writeFiles(root, { "src/a.ts": "export function a() {\n  return 42;\n}\n" });
    const st = await store(root);
    const built = await buildGraph({ repoRoot: root, store: st, capture: "working-tree" });
    const tree = st.open({ id: built.status.generation as string })?.manifest.capture.treeSha as string;
    expect(tree).toMatch(/^[0-9a-f]{40}$/);
    writeFiles(root, { "src/a.ts": "export function a() {\n  return 7;\n}\n" });
    execFileSync("git", ["gc", "--prune=now", "--quiet"], { cwd: root });
    expect(execFileSync("git", ["show", `${tree}:src/a.ts`], { cwd: root, encoding: "utf8" })).toContain("return 42;");
  });

  it("says a build whose facts are gone is partial when it is reopened (4)", async () => {
    const root = makeRepo(files);
    repos.push(root);
    const st = await store(root);
    const built = await buildGraph({ repoRoot: root, store: st, mode: "fresh" });
    const facts = join(root, ".openqodex", "graph", "facts");
    const sub = readdirSync(facts)[0] as string;
    unlinkSync(join(facts, sub, readdirSync(join(facts, sub))[0] as string));
    const reopened = graphOf(st, st.open({ id: built.status.generation as string })!) as Graph;
    expect(reopened.status.status).toBe("partial");
    expect(reopened.status.reasons.join(" ")).toMatch(/no longer kept/);
  });

  it("keeps and loads the index of a build whose only left-out files are over the size cap (5)", async () => {
    const root = makeRepo({ ...files, "big.ts": `export const big = "${"x".repeat(4096)}";\n` });
    repos.push(root);
    const st = await store(root);
    const first = await buildGraph({ repoRoot: root, store: st, mode: "retained", maxFileBytes: 1024 });
    expect(first.status.notRead).toEqual([{ file: "big.ts", reason: "size" }]);
    const kept = st.open({ id: first.status.generation as string })?.manifest;
    expect(kept).toMatchObject({ complete: true, hasIndex: true });
    const second = await buildGraph({ repoRoot: root, store: st, mode: "retained", maxFileBytes: 1024 });
    expect(Object.keys(second.status.stages)).toContain("load-index");
    expect(shape(second)).toEqual(shape(first));
  });
});
