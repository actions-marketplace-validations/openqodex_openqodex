// The readers of the repository's own files: manifests, lockfiles,
// tsconfig, globs, and the text the extractor hashes. Every input comes from
// the repository (a branch, a pull request), so a crafted file must not hang
// the graph. Ways they could fail, one test each:
// 1. A pattern whose repetitions overlap backtracks on a long hostile line,
//    so one reader takes seconds or never ends: every reader must finish a
//    1 MiB hostile input in well under a second.
// 2. A manifest or a lockfile over its byte cap is read anyway.
// 3. A linear reader stops reading what it must (the positive controls).
// 4. Stripping a trailing comma or a comment from a tsconfig changes the
//    text of a string that holds one.
// 5. A glob with many stars against a long path backtracks.
// 6. Comment stripping in the extractor's body hash is quadratic on many
//    unclosed comments.
// 7. An edge id with many separators makes `explain` backtrack.
import { afterAll, describe, expect, it } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildGraph } from "../src/index.js";
import { discoverProjects } from "../src/discovery/projects.js";
import { globMatch } from "../src/discovery/glob.js";
import {
  LOCKFILE_BYTES,
  MANIFEST_BYTES,
  gemfileGems,
  goModRequires,
  goModule,
  parseJsonc,
  pnpmLinks,
  pnpmPackages,
  pyprojectDeps,
  requirementsDeps,
  setupCfgRequires,
  yarnLock,
} from "../src/discovery/manifests.js";
import { query } from "../src/query/engine.js";
import { RepoReader } from "../src/safe-fs.js";
import { makeRepo } from "./helpers.js";

const MiB = 1024 * 1024;
const repos: string[] = [];
afterAll(() => {
  for (const r of repos) rmSync(r, { recursive: true, force: true });
});

// Runs `read` on each input and returns the slowest time in milliseconds.
function slowest(inputs: string[], read: (text: string) => unknown): number {
  let worst = 0;
  for (const text of inputs) {
    expect(text.length).toBeGreaterThanOrEqual(MiB - 64);
    const t0 = performance.now();
    read(text);
    worst = Math.max(worst, performance.now() - t0);
  }
  return worst;
}

const pad = (head: string, unit: string, tail = "") => head + unit.repeat(Math.ceil((MiB - head.length - tail.length) / unit.length)) + tail;

describe("each reader of a repository file is linear (1)", () => {
  const LIMIT = 500;
  it("pnpm-workspace.yaml", () => {
    expect(slowest([pad("packages:\n  - a", " ", "x"), pad("packages: ", " ", "x"), pad("packages:\n", "  - a #\n")], pnpmPackages)).toBeLessThan(LIMIT);
  });
  it("pnpm-lock.yaml", () => {
    expect(slowest([pad("importers:\n  a", ": ", "x"), pad("importers:\n  .:\n    dependencies:\n      a", ":", " x"), pad("importers:\n", "\n")], pnpmLinks)).toBeLessThan(LIMIT);
  });
  it("yarn.lock", () => {
    expect(slowest([pad("a@1:\n  resolved ", ":", "x"), pad("", "a@1, ", ":\n"), pad("", "\n")], yarnLock)).toBeLessThan(LIMIT);
  });
  it("pyproject.toml", () => {
    expect(slowest([pad("[project]\n", "\n", "x"), pad("[project]\ndependencies = [", '"a", '), pad("[", "a.", "]"), pad("[tool.poetry.dependencies]\n", " ", "x")], pyprojectDeps)).toBeLessThan(LIMIT);
  });
  it("setup.cfg", () => {
    expect(slowest([pad("[options]\ninstall_requires =\n", " a", "!"), pad("[options]\ninstall_requires =", " ", "x")], setupCfgRequires)).toBeLessThan(LIMIT);
  });
  it("requirements.txt", () => {
    expect(slowest([pad("a", " ", "#"), pad("", "a ", "x"), pad("a[", "x")], requirementsDeps)).toBeLessThan(LIMIT);
  });
  it("go.mod", () => {
    expect(slowest([pad("require ", "a.", " "), pad("", "\n", "x"), pad("module ", " ", "x")], (t) => [goModRequires(t), goModule(t)])).toBeLessThan(LIMIT);
  });
  it("Gemfile", () => {
    expect(slowest([pad("", "\n", "x"), pad("gem ", " ", "x"), pad("gem(", "\n")], gemfileGems)).toBeLessThan(LIMIT);
  });
  it("tsconfig.json and jsconfig.json", () => {
    expect(slowest([pad("{", ", "), pad("{", " ", ","), pad('{"a": "', "/*,]", '"}'), pad("{", "/* x */,")], (t) => {
      try {
        parseJsonc(t);
      } catch {
        // a broken file is not read; it must still end quickly
      }
    })).toBeLessThan(LIMIT);
  });
});

describe("the byte caps (2)", () => {
  it("names the caps and reads no manifest or lockfile over them", () => {
    expect(MANIFEST_BYTES).toBe(MiB);
    expect(LOCKFILE_BYTES).toBe(16 * MiB);
    const root = makeRepo({ "pnpm-workspace.yaml": "packages:\n  - packages/*\n", "packages/a/package.json": '{ "name": "a" }\n' });
    repos.push(root);
    // A pnpm-workspace.yaml just over the cap is not read: no member is found.
    writeFileSync(join(root, "pnpm-workspace.yaml"), pad("packages:\n  - packages/*\n", "#", "\n") + "x".repeat(64));
    const model = discoverProjects(["pnpm-workspace.yaml", "packages/a/package.json"], new RepoReader(root));
    expect(model.members.size).toBe(0);
  });
});

describe("the readers still read their files (3)", () => {
  it("reads the workspace list in block and flow form", () => {
    expect(pnpmPackages("packages:\n  - 'packages/*' # all\n  - \"apps/*\"\n  - '!packages/old'\nother: 1\n")).toEqual(["packages/*", "apps/*", "!packages/old"]);
    expect(pnpmPackages("packages: [packages/*, 'tools/*']\n")).toEqual(["packages/*", "tools/*"]);
  });
  it("reads pnpm importers in the lockfile v6 and later form and the v5 form", () => {
    const v9 = "lockfileVersion: '9.0'\nimporters:\n\n  .:\n    devDependencies:\n      vitest:\n        specifier: ^5.0.3\n        version: 5.0.3\n\n  packages/cli:\n    dependencies:\n      '@x/core':\n        specifier: workspace:*\n        version: link:../core\npackages:\n  x: 1\n";
    expect(pnpmLinks(v9)).toEqual(new Map([["", new Map([["vitest", "published"]])], ["packages/cli", new Map([["@x/core", "workspace"]])]]));
    const v5 = "importers:\n  packages/app:\n    dependencies:\n      '@x/core': link:../core\n      left-pad: 1.3.0\n";
    expect(pnpmLinks(v5).get("packages/app")).toEqual(new Map([["@x/core", "workspace"], ["left-pad", "published"]]));
  });
  it("reads yarn.lock workspace and registry entries", () => {
    const y = yarnLock('"@x/core@workspace:packages/core":\n  version: 0.0.0-use.local\n\n"left-pad@^1.0.0", left-pad@1.3.0:\n  version "1.3.0"\n  resolved "https://registry.yarnpkg.com/left-pad/-/left-pad-1.3.0.tgz"\n');
    expect([...y.workspace]).toEqual(["@x/core"]);
    expect([...y.published]).toEqual(["left-pad"]);
  });
  it("reads pyproject, setup.cfg and requirements dependencies", () => {
    const py = '[project]\nname = "x"\ndependencies = [\n  "Django>=5.0", # web\n  "requests[socks]",\n]\n[tool.poetry.dependencies]\npython = "^3.11"\nPyYAML = "^6"\n[tool.isort]\nknown = ["notadep"]\n';
    expect(pyprojectDeps(py).sort()).toEqual(["django", "pyyaml", "requests"]);
    expect(setupCfgRequires("[metadata]\nname = x\n[options]\ninstall_requires =\n    click>=8\n    attrs\npython_requires = >=3.9\n").sort()).toEqual(["attrs", "click"]);
    expect(requirementsDeps("# top\nflask==3.0 # web\n-r other.txt\n\nNumPy\n").sort()).toEqual(["flask", "numpy"]);
  });
  it("reads go.mod's module and requirements", () => {
    const mod = "module example.com/app\n\ngo 1.22\n\nrequire (\n\tgithub.com/x/y v1.2.3\n\tgolang.org/x/net v0.1.0 // indirect\n)\nrequire github.com/z/w v0.0.1\n";
    expect(goModule(mod)).toBe("example.com/app");
    expect(goModRequires(mod)).toEqual(["github.com/x/y", "golang.org/x/net", "github.com/z/w"]);
  });
  it("reads Gemfile gems", () => {
    expect(gemfileGems("source 'https://rubygems.org'\ngem 'rails', '~> 7.1'\ngem(\"pg\")\n  gem 'puma' # web\n")).toEqual(["rails", "pg", "puma"]);
  });
});

describe("tsconfig text (4)", () => {
  it("drops comments and trailing commas outside strings and keeps them inside", () => {
    const text = '{\n  // a comment\n  "compilerOptions": { "paths": { "@a/*": ["src/*",], }, /* block */ "x": "a,]//b/*c*/", },\n}\n';
    expect(parseJsonc(text)).toEqual({ compilerOptions: { paths: { "@a/*": ["src/*"] }, x: "a,]//b/*c*/" } });
  });
});

describe("globs (5)", () => {
  it("matches as before and in linear time on a hostile pattern", () => {
    expect(globMatch("packages/core", "packages/*")).toBe(true);
    expect(globMatch("packages/core/x", "packages/*")).toBe(false);
    expect(globMatch("a/b/c/d.ts", "a/**")).toBe(true);
    expect(globMatch("a/b.ts", "a/?.ts")).toBe(true);
    expect(globMatch("a/(b).ts", "a/(b).ts")).toBe(true);
    const path = "a".repeat(4096);
    const glob = `${"*a".repeat(200)}b`;
    const t0 = performance.now();
    expect(globMatch(path, glob)).toBe(false);
    expect(globMatch(path, `${"**a".repeat(200)}b`)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe("the extractor's body hash (6)", () => {
  // The comment openers sit in a string, so the parser reads the file at
  // once and only the hash would be slow (an unclosed comment in code is the
  // parser's case: caps.test.ts, case 6).
  it("hashes a definition holding many comment openers quickly", async () => {
    const body = "/* x ".repeat(100_000);
    const root = makeRepo({ "a.ts": `export function f() {\n  return \`${body}\`;\n}\n`, "b.py": `def f():\n    return 1 ${"# x ".repeat(100_000)}\n` });
    repos.push(root);
    const t0 = performance.now();
    const g = await buildGraph({ repoRoot: root, store: null, maxFileBytes: 2 * MiB });
    expect(g.status.filesParsed).toBe(2);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe("edge ids (7)", () => {
  it("refuses a hostile edge id quickly", async () => {
    const root = makeRepo({ "a.ts": "export function f() {\n  return 1;\n}\n" });
    repos.push(root);
    const graph = await buildGraph({ repoRoot: root, store: null });
    const id = `calls:${"->@:1".repeat(200_000)}`;
    const t0 = performance.now();
    const a = query({ graph, generation: null, treeSha: null, builtAt: null, laterEditsKnown: false }, { apiVersion: 1, kind: "explain", target: { id } });
    expect(a.error).not.toBeNull();
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
