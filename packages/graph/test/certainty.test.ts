// A call is certain only when every step it rests on is proved. Ways the
// resolver could claim more than it proved, each on a real repo:
// 1. A method found on a base class that was bound through a likely
//    mapping (a workspace package reached through its built entry) is
//    certain, because inheritance drops the base binding's evidence; a
//    `super` call the same.
// 2. Two `export *` statements that bring the same name from different
//    modules bind it certainly to the first.
// 3. A workspace package path its `exports` map does not expose binds
//    certainly through the folder layout, though Node refuses the import.
// 4. A Python module found next to the importer shadows one under a source
//    root with no ambiguity recorded.
// 5. A method called on a value typed `any`, `unknown` or `object` counts
//    as external, so no floor says a repository method of that name may be
//    reached.
// 6. A caller two hops out is printed in the brief as certain because its
//    own call is, while the step it reaches the change through is only
//    likely.
import { afterAll, describe, expect, it } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getChange } from "@openqodex/core";
import { buildGraph, detectImpact, floorReasons, renderImpactBlock } from "../src/index.js";
import type { Graph } from "../src/index.js";
import { commitAll, makeRepo, symbol } from "./helpers.js";

const repos: string[] = [];
afterAll(() => {
  for (const r of repos) rmSync(r, { recursive: true, force: true });
});

async function graphOf(files: Record<string, string>): Promise<Graph> {
  const root = makeRepo(files);
  repos.push(root);
  return buildGraph({ repoRoot: root, store: null });
}

// "file:line tier" of each call site into `id`.
function tiers(graph: Graph, id: string): string[] {
  return (graph.in.get(id) ?? [])
    .filter((e) => e.kind === "calls")
    .flatMap((e) => e.sites.map((s) => `${s.file}:${s.line} ${s.tier}`))
    .sort();
}

const workspace = {
  "package.json": '{ "name": "root", "private": true, "workspaces": ["packages/*"] }\n',
  "packages/a/package.json": '{ "name": "a", "main": "./dist/index.js" }\n',
  "packages/a/src/index.ts": "export class Base {\n  m() {\n    return 1;\n  }\n}\n",
  "packages/b/package.json": '{ "name": "b", "dependencies": { "a": "workspace:*" } }\n',
};

describe("certainty", () => {
  it("keeps a base class's likely binding on a method inherited from it, and on super (1)", async () => {
    const g = await graphOf({
      ...workspace,
      "packages/b/src/use.ts":
        'import { Base } from "a";\nclass Child extends Base {\n  n() {\n    return super.m();\n  }\n}\nexport function run() {\n  const c = new Child();\n  return c.m();\n}\n',
    });
    const m = symbol(g, "packages/a/src/index.ts", "m", "Base");
    expect(tiers(g, m)).toEqual(["packages/b/src/use.ts:4 likely", "packages/b/src/use.ts:9 likely"]);
    const site = (g.in.get(m) ?? []).flatMap((e) => e.sites).find((s) => s.line === 9);
    expect(site?.note).toMatch(/dist/);
  });

  it("records two export * of one name from different modules as possible, with both candidates (2)", async () => {
    const g = await graphOf({
      "one.ts": "export function f() {\n  return 1;\n}\n",
      "two.ts": "export function f() {\n  return 2;\n}\n",
      "same.ts": 'export { f } from "./one";\n',
      "barrel.ts": 'export * from "./one";\nexport * from "./two";\n',
      "dedupe.ts": 'export * from "./one";\nexport * from "./same";\n',
      "use.ts": 'import { f } from "./barrel";\nimport { f as g } from "./dedupe";\nexport function run() {\n  return f() + g();\n}\n',
    });
    // Both candidates, never certain; the same definition twice is one certain target.
    expect(tiers(g, symbol(g, "one.ts", "f"))).toEqual(["use.ts:4 certain", "use.ts:4 possible"]);
    expect(tiers(g, symbol(g, "two.ts", "f"))).toEqual(["use.ts:4 possible"]);
  });

  it("does not bind a workspace path the package's exports map does not expose (3)", async () => {
    const files = {
      ...workspace,
      "packages/a/src/internal.ts": "export function hidden() {\n  return 1;\n}\n",
      "packages/b/src/use.ts": 'import { hidden } from "a/src/internal";\nexport function run() {\n  return hidden();\n}\n',
    };
    const governed = await graphOf({ ...files, "packages/a/package.json": '{ "name": "a", "exports": { ".": "./src/index.ts" } }\n' });
    expect(tiers(governed, symbol(governed, "packages/a/src/internal.ts", "hidden"))).toEqual([]);
    const gap = governed.unknowns.find((u) => u.name === "hidden");
    expect(gap?.cause).toBe("not-exported");
    // With no exports map, the folder layout is how Node finds it.
    const open = await graphOf({ ...files, "packages/a/package.json": '{ "name": "a", "main": "./src/index.ts" }\n' });
    expect(tiers(open, symbol(open, "packages/a/src/internal.ts", "hidden"))).toEqual(["packages/b/src/use.ts:3 certain"]);
  });

  it("records a Python module found both next to the importer and under a source root as ambiguous (4)", async () => {
    const g = await graphOf({
      "utils.py": "def helper():\n    return 1\n",
      "src/utils.py": "def helper():\n    return 2\n",
      "src/app/__init__.py": "",
      "src/app/core.py": "def x():\n    return 0\n",
      "tests/test_x.py": "import utils\n\n\ndef test_it():\n    return utils.helper()\n",
    });
    expect(tiers(g, symbol(g, "utils.py", "helper"))).toEqual([]);
    expect(tiers(g, symbol(g, "src/utils.py", "helper"))).toEqual([]);
    const gap = g.unknowns.find((u) => u.file === "tests/test_x.py" && u.name === "helper");
    expect(gap?.cause).toBe("ambiguous");
  });

  it("records a call on an any, unknown or object value as untyped, and floors the methods it may reach (5)", async () => {
    const g = await graphOf({
      "repo.ts": "export class Repo {\n  save() {\n    return 1;\n  }\n  load() {\n    return 2;\n  }\n  drop() {\n    return 3;\n  }\n}\n",
      "use.ts":
        "export function use(a: any, b: unknown, c: object) {\n  return a.save() + (b as any) + c.drop();\n}\nexport function more(b: unknown) {\n  return b.load();\n}\nexport function shaped(d: { save(): number }) {\n  return d.save();\n}\n",
    });
    const gaps = g.unknowns.filter((u) => u.file === "use.ts").map((u) => `${u.name} ${u.cause}`).sort();
    expect(gaps).toEqual(["drop untyped-receiver", "load untyped-receiver", "save untyped-receiver", "save untyped-receiver"]);
    const save = symbol(g, "repo.ts", "save", "Repo");
    expect(floorReasons(g, { id: save, name: "save", file: "repo.ts" }, new Set()).join(" ")).toMatch(/save/);
  });

  it("prints a caller two hops out no surer than the weaker of its two steps (6)", async () => {
    const root = makeRepo({
      ...workspace,
      "packages/a/src/index.ts": "export function core() {\n  return 1;\n}\n",
      "packages/b/src/mid.ts": 'import { core } from "a";\nexport function mid() {\n  return core();\n}\n',
      "packages/b/src/top.ts": 'import { mid } from "./mid";\nexport function top() {\n  return mid();\n}\n',
    });
    repos.push(root);
    commitAll(root);
    writeFileSync(join(root, "packages/a/src/index.ts"), "export function core() {\n  return 2;\n}\n");
    const change = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
    const g = await buildGraph({ repoRoot: root, store: null, files: change.changedPaths, base: { sha: change.baseSha, files: change.files } });
    const block = renderImpactBlock(detectImpact(g, change));
    const line = block.split("\n").find((l) => l.startsWith("- packages/b/src/top.ts:3"));
    expect(line).toMatch(/\(2 hops, likely: /);
  });
});
