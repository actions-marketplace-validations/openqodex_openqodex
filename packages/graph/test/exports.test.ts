// The export-surface diff: what public name a change removed or bound to
// another definition, and who used it. Each failure below is a real
// change, built as two commits in a temp repo:
// 1. Removing `export { target as publicApi }` while `target` stays reports
//    nothing (T3-astra fixture 4: risk none, no consumer).
// 2. A barrel that now re-exports another definition under the same name
//    (`export { a as api }` to `export { b as api }`) reports nothing, and
//    the unchanged consumers of `api` are not listed.
// 3. A removed name reached through a chain of six barrels loses its
//    consumer past four hops.
// 4. A consumer of a removed name is reported as still working, or a
//    consumer whose binding did not change is reported as broken.
// 5. A definition the change deleted outright is reported twice: as a
//    removed symbol and as a removed public name.
// 6. A package.json change that points a workspace package's entry at
//    another file goes unnoticed by the consumers that import the package.
// 7. A definition moved to another file under another name, with the same
//    body, reads as removed with its callers broken; two identical bodies
//    gained in two files are paired with it anyway.
import { afterAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { getChange } from "@openqodex/core";
import { buildGraph, detectImpact } from "../src/index.js";
import { commitAll, makeRepo, writeFiles } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const repos: string[] = [];
afterAll(() => {
  for (const r of repos) rmSync(r, { recursive: true, force: true });
});

// Builds the graph of `after` against the commit of `before`, and the impact.
async function change(before: Record<string, string>, after: Record<string, string | null>) {
  const root = makeRepo(before);
  repos.push(root);
  commitAll(root);
  for (const [path, content] of Object.entries(after)) {
    if (content === null) rmSync(`${root}/${path}`);
    else writeFiles(root, { [path]: content });
  }
  const c = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
  const graph = await buildGraph({ repoRoot: root, store: null, files: c.changedPaths, base: { sha: c.baseSha, files: c.files } });
  return { graph, impact: detectImpact(graph, c) };
}

describe("the export-surface diff", () => {
  it("reports a removed alias whose implementation stays, with its consumer (1)", async () => {
    const { impact } = await change(
      {
        "lib.ts": "function target() {\n  return 1;\n}\nexport { target as publicApi };\n",
        "use.ts": 'import { publicApi } from "./lib";\nexport function run() {\n  return publicApi();\n}\n',
      },
      { "lib.ts": "function target() {\n  return 1;\n}\nexport { target };\n" },
    );
    const removed = impact.exports.find((e) => e.name === "publicApi");
    expect(removed).toMatchObject({ file: "lib.ts", change: "removed", line: 4 });
    expect(removed?.consumers.map((c) => `${c.file}:${c.line}:${c.now}`)).toContain("use.ts:3:broken");
    expect(impact.risk).not.toBe("none");
  });

  it("reports a barrel that now binds its public name to another definition, with the unchanged consumers (2)", async () => {
    const { impact } = await change(
      {
        "impl.ts": "export function a() {\n  return 1;\n}\nexport function b() {\n  return 2;\n}\n",
        "index.ts": 'export { a as api } from "./impl";\n',
        "use.ts": 'import { api } from "./index";\nexport function run() {\n  return api();\n}\n',
      },
      { "index.ts": 'export { b as api } from "./impl";\n' },
    );
    const retarget = impact.exports.find((e) => e.name === "api");
    expect(retarget).toMatchObject({ file: "index.ts", change: "retargeted" });
    expect(retarget?.before?.id).toContain("impl.ts#a@");
    expect(retarget?.after?.id).toContain("impl.ts#b@");
    expect(retarget?.consumers.map((c) => `${c.file}:${c.line}:${c.now}`)).toContain("use.ts:3:retargeted");
  });

  it("finds the consumer of a removed name through six barrels (3)", async () => {
    const before: Record<string, string> = { "x.ts": "export function target() {\n  return 1;\n}\nexport function other() {\n  return 2;\n}\n" };
    before["b1.ts"] = 'export * from "./x";\n';
    for (let i = 2; i <= 6; i++) before[`b${i}.ts`] = `export * from "./b${i - 1}";\n`;
    before["use.ts"] = 'import { target } from "./b6";\nexport function run() {\n  return target();\n}\n';
    const { impact } = await change(before, { "x.ts": "function target() {\n  return 1;\n}\nexport function other() {\n  return 2;\n}\nexport const keep = target;\n" });
    const removed = impact.exports.find((e) => e.name === "target");
    expect(removed?.change).toBe("removed");
    expect(removed?.consumers.map((c) => `${c.file}:${c.line}:${c.now}`)).toContain("use.ts:3:broken");
  });

  it("marks a consumer whose binding did not change as unchanged, never broken (4)", async () => {
    const { impact } = await change(
      {
        "impl.ts": "export function a() {\n  return 1;\n}\n",
        "index.ts": 'export { a as api, a as alias } from "./impl";\n',
        "use.ts": 'import { alias } from "./index";\nexport function run() {\n  return alias();\n}\n',
      },
      { "index.ts": 'export { a as alias } from "./impl";\n' },
    );
    // `api` is gone and nobody used it; `alias` still binds to `a`.
    expect(impact.exports.map((e) => e.name)).toEqual(["api"]);
    expect(impact.exports[0]?.consumersTotal).toBe(0);
  });

  it("leaves a deleted definition to the removed symbols, never a second time as a public name (5)", async () => {
    const { impact } = await change(
      {
        "lib.ts": "export function gone() {\n  return 1;\n}\nexport function stay() {\n  return 2;\n}\n",
        "use.ts": 'import { gone } from "./lib";\nexport function run() {\n  return gone();\n}\n',
      },
      { "lib.ts": "export function stay() {\n  return 2;\n}\n" },
    );
    expect(impact.removed.length).toBe(1);
    expect(impact.exports).toEqual([]);
  });

  it("lists the importers of a workspace package whose entry the package.json now points elsewhere (6)", async () => {
    const pkg = (main: string) => `{ "name": "@x/core", "version": "1.0.0", "main": "${main}" }\n`;
    const { impact } = await change(
      {
        "package.json": '{ "name": "root", "private": true, "workspaces": ["packages/*"] }\n',
        "packages/core/package.json": pkg("src/index.ts"),
        "packages/core/src/index.ts": "export function boot() {\n  return 1;\n}\n",
        "packages/core/src/next.ts": "export function other() {\n  return 2;\n}\n",
        "packages/app/package.json": '{ "name": "@x/app", "dependencies": { "@x/core": "workspace:*" } }\n',
        "packages/app/src/main.ts": 'import { boot } from "@x/core";\nexport function start() {\n  return boot();\n}\n',
      },
      { "packages/core/package.json": pkg("src/next.ts") },
    );
    const entry = impact.exports.find((e) => e.file === "packages/core/package.json");
    expect(entry?.change).toBe("removed");
    expect(entry?.consumers.map((c) => `${c.file}:${c.line}:${c.now}`)).toContain("packages/app/src/main.ts:3:broken");
  });

  it("pairs a definition moved and renamed by its body, and never pairs two identical bodies (7)", async () => {
    const body = "(a: number) {\n  const doubled = a * 2;\n  return doubled + 1;\n}\n";
    const moved = await change(
      { "a.ts": `export function oldName${body}`, "b.ts": "export function unrelated() {\n  return 0;\n}\n" },
      { "a.ts": "export const placeholder = 1;\n", "b.ts": `export function unrelated() {\n  return 0;\n}\nexport function newName${body}` },
    );
    const sym = moved.impact.symbols.find((s) => s.name === "oldName");
    expect(sym?.movedTo).toMatchObject({ file: "b.ts", renamed: true });

    const twice = await change(
      { "a.ts": `export function oldName${body}`, "b.ts": "export const x = 1;\n", "c.ts": "export const y = 1;\n" },
      { "a.ts": "export const placeholder = 1;\n", "b.ts": `export function first${body}`, "c.ts": `export function second${body}` },
    );
    expect(twice.impact.symbols.find((s) => s.name === "oldName")?.movedTo).toBeUndefined();
  });
});
