// The walk that lists what a file exports through `export *`. Ways it could
// fail, each on a real repo built as two commits:
// 1. Two barrels that `export *` from each other make the walk recurse
//    until the stack overflows, so the review gets no graph.
// 2. A diamond of barrels (each level re-exports both barrels of the level
//    below) is walked once per path, which doubles with every level: 2,000
//    barrels never finish.
// 3. A walk stopped by its step budget drops the names past the stop with
//    nothing said.
import { afterAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { getChange } from "@openqodex/core";
import { buildGraph, detectImpact } from "../src/index.js";
import { EXPORT_WALK_STEPS } from "../src/resolve.js";
import { commitAll, makeRepo, writeFiles } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const repos: string[] = [];
afterAll(() => {
  for (const r of repos) rmSync(r, { recursive: true, force: true });
});

async function change(before: Record<string, string>, after: Record<string, string>) {
  const root = makeRepo(before);
  repos.push(root);
  commitAll(root);
  writeFiles(root, after);
  const c = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
  const graph = await buildGraph({ repoRoot: root, store: null, files: c.changedPaths, base: { sha: c.baseSha, files: c.files }, budgetMs: 60_000, maxFiles: 100_000 });
  return { graph, impact: detectImpact(graph, c) };
}

// Levels of two barrels, each re-exporting both barrels of the level below;
// `top.ts` re-exports the last level and has a name of its own.
function diamond(levels: number, own: string): Record<string, string> {
  const files: Record<string, string> = { "x.ts": "export function target() {\n  return 1;\n}\n" };
  for (let i = 1; i <= levels; i++) {
    const below = i === 1 ? ['export * from "./x";\n'] : [`export * from "./d${i - 1}a";\n`, `export * from "./d${i - 1}b";\n`];
    files[`d${i}a.ts`] = below.join("");
    files[`d${i}b.ts`] = below.join("");
  }
  files["top.ts"] = `export * from "./d${levels}a";\nexport * from "./d${levels}b";\n${own}`;
  return files;
}

describe("the export walk", () => {
  it("finishes on two barrels that export * from each other (1)", async () => {
    const { graph, impact } = await change(
      {
        "a.ts": 'export * from "./b";\nexport function fa() {\n  return 1;\n}\n',
        "b.ts": 'export * from "./a";\nexport function fb() {\n  return 2;\n}\n',
        "use.ts": 'import { fa } from "./b";\nexport function run() {\n  return fa();\n}\n',
      },
      { "a.ts": 'export * from "./b";\nfunction fa() {\n  return 1;\n}\n' },
    );
    expect(graph.status.stages.compare ?? 0).toBeLessThan(1000);
    const removed = impact.exports.find((e) => e.name === "fa");
    expect(removed?.consumers.map((c) => `${c.file}:${c.now}`)).toContain("use.ts:broken");
  });

  it("walks a 2,000-barrel diamond in under a second (2)", async () => {
    const own = "export function mine() {\n  return 2;\n}\n";
    const { graph, impact } = await change(diamond(1000, own), { "top.ts": diamond(1000, "function mine() {\n  return 2;\n}\n")["top.ts"] as string });
    expect(graph.status.stages.compare ?? 0).toBeLessThan(1000);
    expect(impact.exports.find((e) => e.name === "mine")).toMatchObject({ file: "top.ts", change: "removed" });
  }, 120_000);

  it("records a cut when the walk passes its step budget (3)", async () => {
    const levels = Math.ceil(EXPORT_WALK_STEPS / 2) + 5;
    const files: Record<string, string> = { "x.ts": "export function target() {\n  return 1;\n}\n" };
    // A chain, one barrel a level: every step is a new file.
    for (let i = 1; i <= 2 * levels; i++) files[`c${i}.ts`] = i === 1 ? 'export * from "./x";\n' : `export * from "./c${i - 1}";\n`;
    files["top.ts"] = `export * from "./c${2 * levels}";\nexport function mine() {\n  return 2;\n}\n`;
    const { graph } = await change(files, { "top.ts": `export * from "./c${2 * levels}";\nfunction mine() {\n  return 2;\n}\n` });
    const cut = graph.status.cuts.find((c) => c.by === "export-walk");
    expect(cut).toMatchObject({ by: "export-walk", exact: false, omitted: null, unit: "files" });
    expect(cut?.note).toMatch(/export \*/);
  }, 300_000);
});
