// Reusing a kept index only when everything it was resolved from is the
// same. Ways it could fail, each on a real repo with the real store:
// 1. A changed tsconfig `paths` alias (a committed file edited in the work
//    tree) loads the old index, so the call keeps binding to the old target.
// 2. A change to a file a tsconfig `extends` (an untracked base config in
//    another folder) loads the old index.
// 3. A workspace package's `exports` entry moved to another file loads the
//    old index, so importers keep binding to the old entry.
// 4. A changed lockfile loads the old index, so a dependency's linkage
//    (workspace or published) stays as it was.
// 5. A new file over the size cap (a file the graph leaves out) loads the
//    old index, whose floors do not name it.
// 6. Nothing changed at all, and the index is not loaded (the checks above
//    would then pass for the wrong reason).
// 7. A tsconfig extends a config with no extension (`./configs/base`),
//    which TypeScript reads as written; a change to it loads the old index,
//    because only names a filter knows count.
// 8. A file the model looked for and did not find (`./configs/base` as
//    written, while `configs/base.json` answered) appears and now wins, and
//    the old index is loaded, because only files that were read count.
// 9. A folder no file of git's list names (an empty folder a `file:`
//    dependency's path walks through) becomes a link, the placement of the
//    dependency changes, and the old index is loaded, because no listed
//    file changed.
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, rmdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { buildGraph, openStore } from "../src/index.js";
import type { Graph } from "../src/index.js";
import { callSites, commitAll, makeHome, makeRepo, symbol, writeFiles } from "./helpers.js";

const home = makeHome();
const repos: string[] = [home];
afterAll(() => {
  for (const r of repos) rmSync(r, { recursive: true, force: true });
});

async function storeOf(root: string) {
  const opened = await openStore(root, { home });
  if (!opened.ok) throw new Error(opened.reason);
  return opened.store;
}

const loadedIndex = (g: Graph): boolean => Object.keys(g.status.stages).includes("load-index");

const aliasFiles = {
  "lib/x.ts": "export function f() {\n  return 1;\n}\n",
  "other/x.ts": "export function f() {\n  return 2;\n}\n",
  "src/use.ts": 'import { f } from "@lib/x";\nexport function use() {\n  return f();\n}\n',
};

describe("the retained index", () => {
  it("is not loaded after a tsconfig paths alias changes (1)", async () => {
    const root = makeRepo({ ...aliasFiles, "tsconfig.json": '{ "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["lib/*"] } } }\n' });
    repos.push(root);
    commitAll(root);
    const st = await storeOf(root);
    const first = await buildGraph({ repoRoot: root, store: st, mode: "retained" });
    expect(callSites(first, symbol(first, "lib/x.ts", "f"))).toEqual(["src/use.ts:3"]);
    writeFiles(root, { "tsconfig.json": '{ "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["other/*"] } } }\n' });
    const second = await buildGraph({ repoRoot: root, store: st, mode: "retained" });
    expect(loadedIndex(second)).toBe(false);
    expect(callSites(second, symbol(second, "other/x.ts", "f"))).toEqual(["src/use.ts:3"]);
    expect(callSites(second, symbol(second, "lib/x.ts", "f"))).toEqual([]);
  });

  it("is not loaded after a config a tsconfig extends changes (2)", async () => {
    const root = makeRepo({
      ...aliasFiles,
      "tsconfig.json": '{ "extends": "./configs/base.json" }\n',
      "configs/base.json": '{ "compilerOptions": { "baseUrl": "..", "paths": { "@lib/*": ["lib/*"] } } }\n',
    });
    repos.push(root);
    const st = await storeOf(root);
    const first = await buildGraph({ repoRoot: root, store: st, mode: "retained" });
    expect(callSites(first, symbol(first, "lib/x.ts", "f"))).toEqual(["src/use.ts:3"]);
    writeFiles(root, { "configs/base.json": '{ "compilerOptions": { "baseUrl": "..", "paths": { "@lib/*": ["other/*"] } } }\n' });
    const second = await buildGraph({ repoRoot: root, store: st, mode: "retained" });
    expect(loadedIndex(second)).toBe(false);
    expect(callSites(second, symbol(second, "other/x.ts", "f"))).toEqual(["src/use.ts:3"]);
  });

  it("is not loaded after a workspace package's exports entry moves (3)", async () => {
    const pkg = (entry: string) => `{ "name": "a", "exports": "${entry}" }\n`;
    const root = makeRepo({
      "package.json": '{ "name": "root", "private": true, "workspaces": ["packages/*"] }\n',
      "packages/a/package.json": pkg("./src/one.ts"),
      "packages/a/src/one.ts": "export function f() {\n  return 1;\n}\n",
      "packages/a/src/two.ts": "export function f() {\n  return 2;\n}\n",
      "packages/b/package.json": '{ "name": "b", "dependencies": { "a": "workspace:*" } }\n',
      "packages/b/src/use.ts": 'import { f } from "a";\nexport function use() {\n  return f();\n}\n',
    });
    repos.push(root);
    const st = await storeOf(root);
    const first = await buildGraph({ repoRoot: root, store: st, mode: "retained" });
    expect(callSites(first, symbol(first, "packages/a/src/one.ts", "f"))).toEqual(["packages/b/src/use.ts:3"]);
    writeFiles(root, { "packages/a/package.json": pkg("./src/two.ts") });
    const second = await buildGraph({ repoRoot: root, store: st, mode: "retained" });
    expect(loadedIndex(second)).toBe(false);
    expect(callSites(second, symbol(second, "packages/a/src/two.ts", "f"))).toEqual(["packages/b/src/use.ts:3"]);
  });

  it("is not loaded after the lockfile changes (4)", async () => {
    const root = makeRepo({ ...aliasFiles, "package.json": '{ "name": "root" }\n', "package-lock.json": '{ "lockfileVersion": 3, "packages": {} }\n' });
    repos.push(root);
    const st = await storeOf(root);
    await buildGraph({ repoRoot: root, store: st, mode: "retained" });
    writeFiles(root, { "package-lock.json": '{ "lockfileVersion": 3, "packages": { "node_modules/left-pad": { "version": "1.3.0" } } }\n' });
    const second = await buildGraph({ repoRoot: root, store: st, mode: "retained" });
    expect(loadedIndex(second)).toBe(false);
  });

  it("is not loaded after a file over the size cap is added (5)", async () => {
    const root = makeRepo(aliasFiles);
    repos.push(root);
    const st = await storeOf(root);
    await buildGraph({ repoRoot: root, store: st, mode: "retained", maxFileBytes: 1024 });
    writeFiles(root, { "src/big.ts": `export const big = "${"x".repeat(4096)}";\n` });
    const second = await buildGraph({ repoRoot: root, store: st, mode: "retained", maxFileBytes: 1024 });
    expect(loadedIndex(second)).toBe(false);
    expect(second.status.notRead).toEqual([{ file: "src/big.ts", reason: "size" }]);
  });

  it("is loaded when nothing changed (6)", async () => {
    const root = makeRepo({ ...aliasFiles, "tsconfig.json": '{ "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["lib/*"] } } }\n' });
    repos.push(root);
    const st = await storeOf(root);
    const first = await buildGraph({ repoRoot: root, store: st, mode: "retained" });
    const second = await buildGraph({ repoRoot: root, store: st, mode: "retained" });
    expect(loadedIndex(second)).toBe(true);
    expect(callSites(second, symbol(second, "lib/x.ts", "f"))).toEqual(callSites(first, symbol(first, "lib/x.ts", "f")));
  });

  it("is not loaded after an extensionless config a tsconfig extends changes (7)", async () => {
    const base = (to: string) => `{ "compilerOptions": { "baseUrl": "..", "paths": { "@lib/*": ["${to}/*"] } } }\n`;
    const root = makeRepo({ ...aliasFiles, "tsconfig.json": '{ "extends": "./configs/base" }\n', "configs/base": base("lib") });
    repos.push(root);
    const st = await storeOf(root);
    const first = await buildGraph({ repoRoot: root, store: st, mode: "retained" });
    expect(callSites(first, symbol(first, "lib/x.ts", "f"))).toEqual(["src/use.ts:3"]);
    writeFiles(root, { "configs/base": base("other") });
    const second = await buildGraph({ repoRoot: root, store: st, mode: "retained" });
    expect(loadedIndex(second)).toBe(false);
    expect(callSites(second, symbol(second, "other/x.ts", "f"))).toEqual(["src/use.ts:3"]);
  });

  it("is not loaded after a config the model looked for and did not find appears (8)", async () => {
    const base = (to: string) => `{ "compilerOptions": { "baseUrl": "..", "paths": { "@lib/*": ["${to}/*"] } } }\n`;
    const root = makeRepo({ ...aliasFiles, "tsconfig.json": '{ "extends": "./configs/base" }\n', "configs/base.json": base("lib") });
    repos.push(root);
    const st = await storeOf(root);
    const first = await buildGraph({ repoRoot: root, store: st, mode: "retained" });
    expect(callSites(first, symbol(first, "lib/x.ts", "f"))).toEqual(["src/use.ts:3"]);
    // TypeScript reads `./configs/base` as written before it adds .json.
    writeFiles(root, { "configs/base": base("other") });
    const second = await buildGraph({ repoRoot: root, store: st, mode: "retained" });
    expect(loadedIndex(second)).toBe(false);
    expect(callSites(second, symbol(second, "other/x.ts", "f"))).toEqual(["src/use.ts:3"]);
  });

  it("is not loaded after a folder a file: path walks through becomes a link (9)", async () => {
    const root = makeRepo({
      "package.json": '{ "name": "root", "private": true, "workspaces": ["packages/*"] }\n',
      "packages/shared/package.json": '{ "name": "shared", "main": "./index.ts" }\n',
      "packages/shared/index.ts": "export function helper() {\n  return 1;\n}\n",
      "packages/b/package.json": '{ "name": "b", "dependencies": { "shared": "file:../pivot/../shared" } }\n',
      "packages/b/src/use.ts": 'import { helper } from "shared";\nexport function run() {\n  return helper();\n}\n',
    });
    repos.push(root);
    mkdirSync(join(root, "packages/pivot"));
    const st = await storeOf(root);
    const first = await buildGraph({ repoRoot: root, store: st, mode: "retained" });
    expect(callSites(first, symbol(first, "packages/shared/index.ts", "helper"))).toEqual(["packages/b/src/use.ts:3"]);
    rmdirSync(join(root, "packages/pivot"));
    symlinkSync(join(root, "packages/shared"), join(root, "packages/pivot"));
    const second = await buildGraph({ repoRoot: root, store: st, mode: "retained" });
    expect(loadedIndex(second)).toBe(false);
    expect(callSites(second, symbol(second, "packages/shared/index.ts", "helper"))).toEqual([]);
  });
});
