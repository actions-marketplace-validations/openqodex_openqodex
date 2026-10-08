// How the project model reads the repository's own manifests, tsconfig
// files and lockfiles, and what it says when it cannot. Ways it could
// mislead, each on a real repo:
// 1. A `file:` dependency named like a workspace package but leading to
//    another folder binds certainly to the workspace package: the graph
//    shows callers of code they never reach.
// 2. A `file:` dependency that leads to the workspace package's own folder
//    stops binding (the positive control of 1).
// 3. A `file:` dependency whose path leaves the repository is bound to the
//    workspace package of that name instead of staying external.
// 4. A `file:` dependency into a folder of the repository that is no
//    workspace package is called external, so its callers vanish.
import { afterAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { buildGraph } from "../src/index.js";
import type { Graph } from "../src/index.js";
import { at, callSites, makeRepo, symbol } from "./helpers.js";

const repos: string[] = [];
afterAll(() => {
  for (const r of repos) rmSync(r, { recursive: true, force: true });
});
function repo(files: Record<string, string>): string {
  const root = makeRepo(files);
  repos.push(root);
  return root;
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const workspaceRoot = json({ name: "root", private: true, workspaces: ["packages/*"] });
const helperCall = 'import { helper } from "shared";\nexport function run() {\n  return helper(); // CALL\n}\n';

const unknownAt = (g: Graph, site: string) => g.unknowns.filter((u) => `${u.file}:${u.line}` === site).map((u) => ({ cause: u.cause, note: u.note }));

describe("file: dependencies bind by where their path leads", () => {
  it("binds a file: dependency named like a workspace package only when its path leads to that package's folder (1, 2)", async () => {
    const files = {
      "package.json": workspaceRoot,
      "packages/shared/package.json": json({ name: "shared", main: "src/index.ts" }),
      "packages/shared/src/index.ts": "export function helper() {\n  return 1;\n}\n",
      "third_party/shared/package.json": json({ name: "shared", main: "index.ts" }),
      "third_party/shared/index.ts": "export function helper() {\n  return 2;\n}\n",
      "packages/app/package.json": json({ name: "app", dependencies: { shared: "file:../../third_party/shared" } }),
      "packages/app/src/main.ts": helperCall,
      "packages/web/package.json": json({ name: "web", dependencies: { shared: "file:../shared" } }),
      "packages/web/src/main.ts": helperCall,
    };
    const g = await buildGraph({ repoRoot: repo(files), store: null });
    const member = symbol(g, "packages/shared/src/index.ts", "helper");
    expect(callSites(g, member)).toEqual([at(files, "packages/web/src/main.ts", "CALL")]);
    expect(g.in.get(member)?.[0]?.tier).toBe("certain");
    expect(unknownAt(g, at(files, "packages/app/src/main.ts", "CALL"))).toEqual([
      { cause: "unsupported-rule", note: "packages/app/package.json declares shared as file:../../third_party/shared, which leads to third_party/shared, not to the workspace package packages/shared" },
    ]);
  });

  it("keeps a file: dependency whose path leaves the repository external, never bound to the workspace package of that name (3)", async () => {
    const files = {
      "package.json": workspaceRoot,
      "packages/shared/package.json": json({ name: "shared", main: "src/index.ts" }),
      "packages/shared/src/index.ts": "export function helper() {\n  return 1;\n}\n",
      "packages/app/package.json": json({ name: "app", dependencies: { shared: "file:../../../elsewhere/shared" } }),
      "packages/app/src/main.ts": helperCall,
    };
    const g = await buildGraph({ repoRoot: repo(files), store: null });
    expect(callSites(g, symbol(g, "packages/shared/src/index.ts", "helper"))).toEqual([]);
    expect(unknownAt(g, at(files, "packages/app/src/main.ts", "CALL"))).toEqual([]);
    expect(g.status.externalSites).toBe(1);
  });

  it("keeps a file: dependency into a folder of the repository that is no workspace package an unknown, never external (4)", async () => {
    const files = {
      "tools/local/package.json": json({ name: "local", main: "index.ts" }),
      "tools/local/index.ts": "export function helper() {\n  return 2;\n}\n",
      "app/package.json": json({ name: "app", dependencies: { local: "file:../tools/local" } }),
      "app/main.ts": 'import { helper } from "local";\nexport function run() {\n  return helper(); // CALL\n}\n',
    };
    const g = await buildGraph({ repoRoot: repo(files), store: null });
    expect(g.status.externalSites).toBe(0);
    expect(unknownAt(g, at(files, "app/main.ts", "CALL"))).toEqual([
      { cause: "unsupported-rule", note: "app/package.json declares local as file:../tools/local, which leads to tools/local, a folder of this repository that is no workspace package" },
    ]);
  });
});
