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
// Failures 1, 2, 3, 6 and 7 are proved by the corpus cases
// typescript/exports/export-alias-removed, barrel-retarget, deep-barrel-chain,
// typescript/workspace/metadata-only-change and typescript/lineage/.
import { afterAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { getChange } from "@openqodex/core";
import { buildGraph, detectImpact } from "../src/index.js";
import { commitAll, makeRepo, writeFiles } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

// Builds the graph of `after` against the commit of `before`, and the impact.
async function change(before: Record<string, string>, after: Record<string, string | null>) {
  const root = makeRepo(before);
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
});
