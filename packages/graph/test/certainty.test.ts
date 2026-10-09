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
// 7. A name re-exported through more modules than the graph follows is
//    recorded as a call on a value of unknown type (no-receiver-type) or a
//    miss, not as what it is: a chain cut by the graph's depth limit.
// 8. An untyped type known only by its spelling: `Any` imported under
//    another name, or read through a module alias (`t.Any`), or a
//    TypeScript alias of `any`, counts as external or as an unknown type,
//    while a class the repository names `Any` is taken for typing's.
import { afterAll, describe, expect, it } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getChange } from "@openqodex/core";
import { buildGraph, detectImpact, floorReasons, renderImpactBlock } from "../src/index.js";
import type { Graph } from "../src/index.js";
import { commitAll, makeRepo, symbol } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

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

  it("names a call through a re-export chain past the depth limit as export-chain-too-deep (7)", async () => {
    const chain = (link: (i: number) => string): Record<string, string> => {
      const files: Record<string, string> = { "x.ts": "export function f() {\n  return 1;\n}\n" };
      for (let i = 1; i <= 12; i++) files[`b${i}.ts`] = link(i);
      files["use.ts"] = 'import { f } from "./b12";\nexport function run() {\n  return f();\n}\n';
      return files;
    };
    const from = (i: number) => (i === 1 ? "./x" : `./b${i - 1}`);
    const named = await graphOf(chain((i) => `export { f } from "${from(i)}";\n`));
    const starred = await graphOf(chain((i) => `export * from "${from(i)}";\n`));
    for (const g of [named, starred]) {
      expect(g.unknowns.filter((u) => u.file === "use.ts").map((u) => `${u.name} ${u.cause}`)).toEqual(["f export-chain-too-deep"]);
      expect(tiers(g, symbol(g, "x.ts", "f"))).toEqual([]);
    }
  });

  it("knows an untyped type by what binds it, not by how it is spelled (8)", async () => {
    const g = await graphOf({
      "repo.py": "class Repo:\n    def save(self):\n        return 1\n",
      "alias.py": "from typing import Any as A\n\n\ndef use(x: A):\n    return x.save()\n",
      "module.py": "import typing as t\n\n\ndef use(x: t.Any):\n    return x.save()\n",
      "plain.py": "import typing\n\n\ndef use(x: typing.Any):\n    return x.save()\n",
      "own.py": "class Any:\n    def save(self):\n        return 2\n\n\ndef use(x: Any):\n    return x.save()\n",
      "loose.ts": "export type Loose = any;\nexport type Looser = Loose;\n",
      "use.ts": 'import type { Looser } from "./loose";\nexport function use(x: Looser) {\n  return x.save();\n}\n',
    });
    const cause = (file: string) => g.unknowns.filter((u) => u.file === file && u.name === "save").map((u) => u.cause);
    for (const file of ["alias.py", "module.py", "plain.py", "use.ts"]) expect(cause(file), file).toEqual(["untyped-receiver"]);
    // The repository's own class named Any binds; it is no untyped type.
    expect(cause("own.py")).toEqual([]);
    expect(tiers(g, symbol(g, "own.py", "save", "Any"))).toEqual(["own.py:7 certain"]);
  });
});
