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
// 5. A tsconfig.json that is not valid JSON drops its `paths` with nothing
//    said: no unknown, no floor, and the build counts as complete. Its
//    files must still never fall to the tsconfig above it, whose `paths`
//    would bind them certainly to the wrong code.
// 6. A package.json over the 1 MB cap drops its package with nothing said,
//    so the calls into it read as external.
// 7. A tsconfig whose relative `extends` names a file that is not there
//    drops what it inherits with nothing said.
// 8. A lockfile that cannot be read is said nowhere; it cannot hide a
//    caller (without it a binding is only less sure), so it gives no floor,
//    and it never stops the build from being complete: a repository whose
//    lockfile is over its cap would otherwise keep no index at all.
// 9. A tsconfig TypeScript reads without complaint (comments, trailing
//    commas, a byte order mark, an empty file, an `extends` that names a
//    package) or one git lists but the work tree no longer holds is
//    reported as a failure (the negative control).
// 10. A manifest over the 1 MB cap is read in the base version (up to the
//    16 MB lockfile cap) but not in the changed one, so a change to it
//    reports every consumer of the package as broken.
// 11. A `file:` path is placed differently from npm and pnpm, which take
//    `..` by its spelling (path.resolve): with `pivot` a link to a folder
//    outside the repository, `file:../pivot/../shared` links the workspace
//    package `shared`, and a graph that follows the link instead loses the
//    calls into it.
// 12. A `file:` path whose last folder is itself a link to the workspace
//    package's folder is said to lead to a folder that is not the
//    package's: the note is false, and the link is never named.
// 13. A `file:` path spelled otherwise than the workspace package's folder
//    (another letter case) is compared by spelling, so on a filesystem
//    that finds that very folder by it the binding is lost.
// 14. Where a `file:` path leads is lost when the model is kept, so a build
//    reopened from its kept model no longer binds what the fresh build
//    bound.
// 15. A manifest whose folder became a link (a developer linking a local
//    checkout in) is explained by the file of that name outside the
//    repository: missing there, the manifest is dropped with nothing said;
//    over the cap there, the report gives that outside file's size.
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getChange } from "@openqodex/core";
import { buildGraph, detectImpact, floorReasons, openStore } from "../src/index.js";
import type { Graph } from "../src/index.js";
import { graphOf } from "../src/session.js";
import { discoverProjects, linkageOf, pathLinkOff } from "../src/discovery/projects.js";
import { RepoReader } from "../src/safe-fs.js";
import { deserializeModel, serializeModel } from "../src/store/graph-files.js";
import { at, callSites, commitAll, makeHome, makeRepo, symbol, writeFiles } from "./helpers.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const home = makeHome();
const repos: string[] = [home];
afterAll(() => {
  for (const r of repos) rmSync(r, { recursive: true, force: true });
});
function repo(files: Record<string, string>): string {
  const root = makeRepo(files);
  repos.push(root);
  return root;
}

const MiB = 1024 * 1024;
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const workspaceRoot = json({ name: "root", private: true, workspaces: ["packages/*"] });
const helperCall = 'import { helper } from "shared";\nexport function run() {\n  return helper(); // CALL\n}\n';

const metadata = (g: Graph) => g.unknowns.filter((u) => u.cause === "metadata-unreadable").map((u) => ({ file: u.file, scope: u.scope, note: u.note }));
const floorOf = (g: Graph, file: string, name: string) => floorReasons(g, { id: symbol(g, file, name), name, file }, new Set());
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

  it("takes .. in a file: path by its spelling, as npm and pnpm do, so a link that .. climbs back out of changes nothing (11)", async () => {
    const outside = tempDir("oq-outside-");
    repos.push(outside);
    // Through the link, packages/pivot/.. is `outside`, which holds a package of the same name.
    writeFiles(outside, { "deep/.keep": "", "shared/package.json": json({ name: "shared", main: "index.ts" }), "shared/index.ts": "export function helper() {\n  return 2;\n}\n" });
    const files = {
      "package.json": workspaceRoot,
      "packages/shared/package.json": json({ name: "shared", main: "src/index.ts" }),
      "packages/shared/src/index.ts": "export function helper() {\n  return 1;\n}\n",
      "packages/web/package.json": json({ name: "web", dependencies: { shared: "file:../pivot/../shared" } }),
      "packages/web/src/main.ts": helperCall,
    };
    const root = repo(files);
    symlinkSync(join(outside, "deep"), join(root, "packages/pivot"));
    const g = await buildGraph({ repoRoot: root, store: null });
    expect(callSites(g, symbol(g, "packages/shared/src/index.ts", "helper"))).toEqual([at(files, "packages/web/src/main.ts", "CALL")]);
    expect(unknownAt(g, at(files, "packages/web/src/main.ts", "CALL"))).toEqual([]);
  });

  it("names the link when a file: dependency's folder is itself a link to the workspace package's folder, and binds nothing certainly through it (12)", async () => {
    const files = {
      "package.json": json({ name: "root", private: true, workspaces: ["packages/*", "libs/*"] }),
      "libs/shared/package.json": json({ name: "shared", main: "src/index.ts" }),
      "libs/shared/src/index.ts": "export function helper() {\n  return 1;\n}\n",
      "packages/web/package.json": json({ name: "web", dependencies: { shared: "file:../shared" } }),
      "packages/web/src/main.ts": helperCall,
    };
    const root = repo(files);
    symlinkSync("../libs/shared", join(root, "packages/shared"));
    const g = await buildGraph({ repoRoot: root, store: null });
    expect(callSites(g, symbol(g, "libs/shared/src/index.ts", "helper"))).toEqual([]);
    expect(unknownAt(g, at(files, "packages/web/src/main.ts", "CALL"))).toEqual([
      { cause: "unsupported-rule", note: "packages/web/package.json declares shared as file:../shared, whose path passes through packages/shared, a symbolic link, which the graph does not follow" },
    ]);
  });

  it("binds a file: dependency spelled otherwise than the workspace package's folder when the filesystem finds that very folder by it (13)", async () => {
    const files = {
      "package.json": workspaceRoot,
      "packages/shared/package.json": json({ name: "shared", main: "src/index.ts" }),
      "packages/shared/src/index.ts": "export function helper() {\n  return 1;\n}\n",
      "packages/web/package.json": json({ name: "web", dependencies: { shared: "file:../Shared" } }),
      "packages/web/src/main.ts": helperCall,
    };
    const root = repo(files);
    const g = await buildGraph({ repoRoot: root, store: null });
    const member = symbol(g, "packages/shared/src/index.ts", "helper");
    const site = at(files, "packages/web/src/main.ts", "CALL");
    // The filesystem decides: one that ignores letter case (macOS by default) finds packages/shared by that name.
    if (existsSync(join(root, "packages/Shared"))) {
      expect(callSites(g, member)).toEqual([site]);
      expect(g.in.get(member)?.[0]?.tier).toBe("certain");
    } else {
      expect(callSites(g, member)).toEqual([]);
      expect(unknownAt(g, site)).toEqual([
        { cause: "unsupported-rule", note: "packages/web/package.json declares shared as file:../Shared, whose path passes through packages/Shared, which is not a folder in the work tree" },
      ]);
    }
  });

  it("keeps where each file: dependency leads with the kept model, so a reopened build binds what the fresh one bound (14)", () => {
    const files = {
      "package.json": workspaceRoot,
      "packages/shared/package.json": json({ name: "shared", main: "src/index.ts" }),
      "packages/web/package.json": json({ name: "web", dependencies: { shared: "file:../shared" } }),
    };
    const model = discoverProjects(Object.keys(files), new RepoReader(repo(files)));
    const kept = deserializeModel(JSON.parse(JSON.stringify(serializeModel(model))) as Record<string, unknown>);
    const link = linkageOf(kept, "packages/web/src/main.ts", "shared");
    expect(link).toEqual(linkageOf(model, "packages/web/src/main.ts", "shared"));
    expect(pathLinkOff(link!, "shared", "packages/shared")).toBeNull();
  });
});

describe("a manifest or tsconfig the graph cannot read is said, never dropped", () => {
  it("names a tsconfig.json that is not valid JSON, floors its project's callers and keeps the build from counting as complete (5)", async () => {
    const files = {
      "tsconfig.json": json({ compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/*"] } } }),
      "src/util.ts": "export function util() {\n  return 2;\n}\n",
      "packages/app/package.json": json({ name: "app" }),
      "packages/app/tsconfig.json": '{\n  "compilerOptions": {\n    "baseUrl": ".",\n    "paths": { "@app/*": ["src/*"] }\n',
      "packages/app/src/util.ts": "export function util() {\n  return 1;\n}\n",
      "packages/app/src/main.ts": 'import { util } from "@app/util";\nexport function run() {\n  return util();\n}\n',
    };
    const root = repo(files);
    const opened = await openStore(root, { home });
    if (!opened.ok) throw new Error(opened.reason);
    const st = opened.store;
    const g = await buildGraph({ repoRoot: root, store: st, mode: "retained" });
    const note = "packages/app/tsconfig.json is not valid JSON, so imports through its paths and baseUrl may be missing";
    expect(metadata(g)).toEqual([{ file: "packages/app/tsconfig.json", scope: "project", note }]);
    expect(floorOf(g, "packages/app/src/util.ts", "util")).toContain(note);
    expect(callSites(g, symbol(g, "src/util.ts", "util"))).toEqual([]);
    expect(g.status.status).toBe("partial");
    expect(g.status.reasons).toContain(note);
    // Not kept as a complete index: a later build of the same files does not load it.
    const kept = st.open({ id: g.status.generation as string });
    expect(kept?.manifest).toMatchObject({ complete: false, hasIndex: false });
    const again = await buildGraph({ repoRoot: root, store: st, mode: "retained" });
    expect(Object.keys(again.status.stages)).not.toContain("load-index");
    // Reopened from its facts, the build says the same.
    const reopened = graphOf(st, kept!) as Graph;
    expect(metadata(reopened)).toEqual(metadata(g));
    expect(floorOf(reopened, "packages/app/src/util.ts", "util")).toEqual(floorOf(g, "packages/app/src/util.ts", "util"));
  });

  it("names a package.json over 1 MB and floors the callers of its package, whose calls would otherwise read as external (6)", async () => {
    const files = {
      "package.json": workspaceRoot,
      "packages/core/package.json": json({ name: "@x/core", main: "src/index.ts", description: "x".repeat(MiB) }),
      "packages/core/src/index.ts": "export function helper() {\n  return 1;\n}\n",
      "packages/app/package.json": json({ name: "app", dependencies: { "@x/core": "workspace:*" } }),
      "packages/app/src/main.ts": 'import { helper } from "@x/core";\nexport function run() {\n  return helper();\n}\n',
    };
    const g = await buildGraph({ repoRoot: repo(files), store: null });
    const note = "packages/core/package.json is over 1 MB, so its package's name, dependencies and workspaces are not known";
    expect(metadata(g)).toEqual([{ file: "packages/core/package.json", scope: "project", note }]);
    expect(floorOf(g, "packages/core/src/index.ts", "helper")).toEqual([note]);
    expect(g.status.status).toBe("partial");
  });

  it("names a tsconfig whose relative extends names a file that is not there, and floors its project's callers (7)", async () => {
    const files = {
      "packages/app/package.json": json({ name: "app" }),
      "packages/app/tsconfig.json": json({ extends: "./tsconfig.base.json", include: ["src"] }),
      "packages/app/src/util.ts": "export function util() {\n  return 1;\n}\n",
      "packages/app/src/main.ts": 'import { util } from "@app/util";\nexport function run() {\n  return util();\n}\n',
    };
    const g = await buildGraph({ repoRoot: repo(files), store: null });
    const note = "packages/app/tsconfig.json extends ./tsconfig.base.json, which is not in the repository, so imports through its paths and baseUrl may be missing";
    expect(metadata(g)).toEqual([{ file: "packages/app/tsconfig.json", scope: "project", note }]);
    expect(floorOf(g, "packages/app/src/util.ts", "util")).toContain(note);
    expect(g.status.status).toBe("partial");
  });

  it("names a package-lock.json that is not valid JSON, with no floor, and keeps the build complete with its index: without it a binding is only less sure (8)", async () => {
    const files = {
      "package.json": json({ name: "app", dependencies: { left: "^1.0.0" } }),
      "package-lock.json": '{ "packages": { "node_modules/left": { "version": "1.0.0" }',
      "src/util.ts": "export function util() {\n  return 1;\n}\n",
      "src/main.ts": 'import { util } from "./util";\nexport function run() {\n  return util();\n}\n',
    };
    const root = repo(files);
    const opened = await openStore(root, { home });
    if (!opened.ok) throw new Error(opened.reason);
    const g = await buildGraph({ repoRoot: root, store: opened.store, mode: "retained" });
    const note = "package-lock.json is not valid JSON, so which dependencies link workspace packages is not known";
    expect(metadata(g)).toEqual([{ file: "package-lock.json", scope: "project", note }]);
    expect(floorOf(g, "src/util.ts", "util")).toEqual([]);
    expect(g.status.status).toBe("ok");
    expect(g.status.reasons).toContain(note);
    expect(opened.store.open({ id: g.status.generation as string })?.manifest).toMatchObject({ complete: true, hasIndex: true });
    // The next build loads that index and still names the gap.
    const again = await buildGraph({ repoRoot: root, store: opened.store, mode: "retained" });
    expect(Object.keys(again.status.stages)).toContain("load-index");
    expect(metadata(again)).toEqual([{ file: "package-lock.json", scope: "project", note }]);
  });

  it("reads every tsconfig TypeScript reads without complaint, and a file git lists but the work tree no longer holds, as no failure (9)", async () => {
    const files = {
      "a/tsconfig.json": '// settings\n{\n  "compilerOptions": {\n    "baseUrl": ".", /* the folder */\n    "paths": { "@a/*": ["src/*"], },\n  },\n}\n',
      "b/tsconfig.json": `﻿${json({ compilerOptions: { strict: true } })}`,
      "c/jsconfig.json": "",
      "d/tsconfig.json": json({ extends: "@tsconfig/node22/tsconfig.json" }),
      "e/tsconfig.json": json({ compilerOptions: {} }),
      "e/package.json": json({ name: "e" }),
      "a/src/util.ts": "export function util() {\n  return 1;\n}\n",
      "a/src/main.ts": 'import { util } from "@a/util";\nexport function run() {\n  return util();\n}\n',
    };
    const root = repo(files);
    commitAll(root);
    unlinkSync(join(root, "e/tsconfig.json"));
    unlinkSync(join(root, "e/package.json"));
    const g = await buildGraph({ repoRoot: root, store: null });
    expect(metadata(g)).toEqual([]);
    expect(g.status.status).toBe("ok");
    expect(callSites(g, symbol(g, "a/src/util.ts", "util"))).toEqual(["a/src/main.ts:3"]);
  });

  it("names a manifest whose folder became a link by that link, whatever the folder outside holds (15)", async () => {
    const files = {
      "package.json": workspaceRoot,
      "packages/core/package.json": json({ name: "@x/core", main: "src/index.ts" }),
      "packages/core/src/index.ts": "export function helper() {\n  return 1;\n}\n",
    };
    const note = "packages/core/package.json is under packages/core, a link, which the graph does not follow, so its package's name, dependencies and workspaces are not known";
    // Outside: nothing of that name, then a package.json over the 1 MB cap.
    for (const there of [{}, { "package.json": json({ name: "@x/core", description: "x".repeat(MiB) }) }]) {
      const root = repo(files);
      commitAll(root);
      const outside = tempDir("oq-outside-");
      repos.push(outside);
      writeFiles(outside, there);
      rmSync(join(root, "packages/core"), { recursive: true });
      symlinkSync(outside, join(root, "packages/core"));
      const g = await buildGraph({ repoRoot: root, store: null });
      expect(metadata(g)).toEqual([{ file: "packages/core/package.json", scope: "project", note }]);
    }
  });

  it("reads a manifest over 1 MB as over its cap in the base version too, so changing it breaks no consumer (10)", async () => {
    const core = (word: string) => json({ name: "@x/core", main: "src/index.ts", description: word.repeat(MiB) });
    const files = {
      "package.json": workspaceRoot,
      "packages/core/package.json": core("x"),
      "packages/core/src/index.ts": "export function helper() {\n  return 1;\n}\n",
      "packages/app/package.json": json({ name: "app", dependencies: { "@x/core": "workspace:*" } }),
      "packages/app/src/main.ts": 'import { helper } from "@x/core";\nexport function run() {\n  return helper();\n}\n',
    };
    const root = repo(files);
    commitAll(root);
    writeFileSync(join(root, "packages/core/package.json"), core("y"));
    const change = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
    const g = await buildGraph({ repoRoot: root, store: null, files: change.changedPaths, base: { sha: change.baseSha, files: change.files } });
    const impact = detectImpact(g, change);
    expect(impact.exports.flatMap((e) => e.consumers.filter((c) => c.now === "broken").map((c) => `${e.name} ${c.file}:${c.line}`))).toEqual([]);
  });
});
