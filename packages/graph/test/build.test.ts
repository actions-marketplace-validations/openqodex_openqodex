// Ways the build, the cache and the impact walk could fail, each checked
// below on a real repo in a temp folder:
// 1. A name defined in many files binds a call that has no evidence (the hub
//    rule), or a name defined in few files never binds as a lead.
// 2. A symbol with hundreds of callers floods the brief instead of listing
//    the 20 nearest, production code first, with the total.
// 3. The time budget does not stop the build, the result does not say it is
//    partial, or a pending timer keeps the process alive after the build.
// 4. A second build parses files that did not change.
// 5. A corrupt cache entry crashes the build or is never rewritten.
// 6. Facts of a deleted file stay in the cache and the graph.
// 8. A cache folder that cannot be written fails the build.
// 7. A function the change removes is not reported, or its surviving
//    callers are lost because the old side is not parsed.
import { afterAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getChange } from "@openqodex/core";
import { buildGraph, detectImpact, renderImpactBlock } from "../src/index.js";
import { at, callSites, commitAll, makeRepo, symbol, writeFiles } from "./helpers.js";

const repos: string[] = [];
afterAll(() => {
  for (const r of repos) rmSync(r, { recursive: true, force: true });
});
function repo(files: Record<string, string>): string {
  const root = makeRepo(files);
  repos.push(root);
  return root;
}
const cacheOf = (root: string) => join(root, ".openqodex", "graph");

describe("hub names", () => {
  // Ruby is the one family where a call with no evidence may bind, as a lead.
  function rubyRepo(definers: number): Record<string, string> {
    const files: Record<string, string> = {
      "lib/helper.rb": "def helper\n  1\nend\n",
      "bin/run.rb": "helper() # CALL\n",
    };
    for (let i = 1; i < definers; i++) files[`lib/c${i}.rb`] = `class C${i}\n  def helper\n    ${i}\n  end\nend\n`;
    return files;
  }

  // The first build also writes to a cache path that cannot exist (failure 8).
  it("binds a bare Ruby call as likely when its name is defined in few files, and never when it is defined in more than 8", async () => {
    const few = rubyRepo(2);
    const g1 = await buildGraph({ repoRoot: repo(few), cacheDir: "/dev/null/not-a-folder" });
    const edge = g1.in.get(symbol(g1, "lib/helper.rb", "helper"))?.[0];
    expect(callSites(g1, symbol(g1, "lib/helper.rb", "helper"))).toEqual([at(few, "bin/run.rb", "CALL")]);
    expect(edge?.confidence).toBe("low");

    const many = rubyRepo(9);
    const g2 = await buildGraph({ repoRoot: repo(many), cacheDir: "/dev/null/none" });
    expect(callSites(g2, symbol(g2, "lib/helper.rb", "helper"))).toEqual([]);
  });

  it("lists the 20 nearest production callers of a symbol with more than 40, and the total", async () => {
    const files: Record<string, string> = { "src/core.ts": "export function core(): number {\n  return 1;\n}\n" };
    for (let i = 0; i < 30; i++) files[`src/deep/p${i}.ts`] = `import { core } from "../core.js";\nexport function p${i}() {\n  return core();\n}\n`;
    for (let i = 0; i < 10; i++) files[`src/n${i}.ts`] = `import { core } from "./core.js";\nexport function n${i}() {\n  return core();\n}\n`;
    for (let i = 0; i < 5; i++) files[`src/n${i}.test.ts`] = `import { core } from "./core.js";\nexport function t${i}() {\n  return core();\n}\n`;
    const root = repo(files);
    commitAll(root);
    writeFiles(root, { "src/core.ts": "export function core(): number {\n  return 2;\n}\n" });
    const change = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
    const g = await buildGraph({ repoRoot: root, cacheDir: cacheOf(root), files: change.changedPaths });
    const impact = detectImpact(g, change);
    expect(impact.hubs).toEqual([{ symbol: symbol(g, "src/core.ts", "core"), callers: 45, sites: 45, files: 45 }]);
    const shown = impact.callers.map((p) => p.edges[0].sites[0]?.file);
    expect(shown).toHaveLength(20);
    // The ten in the same folder first, then the deeper ones; no test file.
    expect(shown.slice(0, 10).every((f) => /^src\/n\d\.ts$/.test(f ?? ""))).toBe(true);
    expect(shown.some((f) => f?.includes(".test."))).toBe(false);
    expect(impact.risk).toBe("high");
  });
});

describe("budget", () => {
  it("stops parsing past the budget, says the graph is partial with the counts, and leaves no timer behind", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 400; i++) files[`src/f${i}.ts`] = `export function f${i}() {\n  return ${i};\n}\n`;
    const root = repo(files);
    const timersBefore = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    const g = await buildGraph({ repoRoot: root, cacheDir: cacheOf(root), budgetMs: 1 });
    const timersAfter = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    expect(g.status.status).toBe("partial");
    expect(g.status.filesParsed).toBeLessThan(400);
    expect(g.status.filesParsed + g.status.filesSkipped).toBe(400);
    expect(g.status.reasons[0]).toMatch(/budget ran out with [\d,]+ files not parsed/);
    expect(timersAfter).toBeLessThanOrEqual(timersBefore);

    const block = renderImpactBlock(detectImpact(g, { files: [], coverage: new Map() }));
    expect(block.split("\n")[2]).toMatch(/^The graph is partial: the 0\.001 s budget ran out/);
  });

  it("caps the number of files and parses the changed files first", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i++) files[`src/f${String(i).padStart(2, "0")}.ts`] = `export function f${i}() {}\n`;
    const root = repo(files);
    const g = await buildGraph({ repoRoot: root, cacheDir: cacheOf(root), maxFiles: 5, files: ["src/f19.ts"] });
    expect(g.status.filesParsed).toBe(5);
    expect(g.status.reasons[0]).toBe("the 5 files cap left out 15 files");
    expect(g.defsByFile.has("src/f19.ts")).toBe(true);
  });
});

describe("cache", () => {
  const files: Record<string, string> = {
    "a.py": "def a():\n    return b()\n\ndef b():\n    return 1\n",
    "c.py": "from a import a\n\ndef c():\n    return a()\n",
    "d.go": "package main\n\nfunc main() { helper() }\n\nfunc helper() {}\n",
  };

  it("parses nothing that did not change, rewrites a corrupt entry, and drops the facts of a deleted file", async () => {
    const root = repo(files);
    const cacheDir = cacheOf(root);
    const first = await buildGraph({ repoRoot: root, cacheDir });
    expect(first.status.parses).toBe(3);

    const warm = await buildGraph({ repoRoot: root, cacheDir });
    expect(warm.status.parses).toBe(0);
    expect(warm.status.cacheHits).toBe(3);
    expect(callSites(warm, symbol(warm, "a.py", "a"))).toEqual(["c.py:4"]);

    writeFiles(root, { "c.py": "from a import a\n\ndef c():\n    x = 1\n    return a()\n" });
    const edited = await buildGraph({ repoRoot: root, cacheDir });
    expect(edited.status.parses).toBe(1);
    expect(callSites(edited, symbol(edited, "a.py", "a"))).toEqual(["c.py:5"]);

    const entries = readdirSync(cacheDir).filter((f) => f.endsWith(".json"));
    expect(entries).toHaveLength(3);
    const victim = join(cacheDir, entries[0] as string);
    writeFileSync(victim, "{not json");
    const repaired = await buildGraph({ repoRoot: root, cacheDir });
    expect(repaired.status.parses).toBe(1);
    expect(() => JSON.parse(readFileSync(victim, "utf8"))).not.toThrow();

    unlinkSync(join(root, "d.go"));
    const after = await buildGraph({ repoRoot: root, cacheDir });
    expect(readdirSync(cacheDir).filter((f) => f.endsWith(".json"))).toHaveLength(2);
    expect(after.nodes.has("d.go")).toBe(false);
  });
});

describe("removed symbols", () => {
  const files: Record<string, string> = {
    "src/a.ts": "export function gone(): number {\n  return 1;\n}\n\nexport function kept(): number {\n  return 2;\n}\n",
    "src/b.ts": 'import { gone, kept } from "./a.js";\n\nexport function user() {\n  gone(); // GONE\n  return kept(); // KEPT\n}\n',
  };

  it("lists a function the change removed with the call sites that still call it", async () => {
    const root = repo(files);
    commitAll(root);
    writeFiles(root, { "src/a.ts": "export function kept(): number {\n  return 3;\n}\n" });
    const change = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
    const g = await buildGraph({ repoRoot: root, cacheDir: cacheOf(root), files: change.changedPaths, base: { sha: change.baseSha, files: change.files } });
    const impact = detectImpact(g, change);
    const removed = impact.symbols.filter((s) => impact.removed.includes(s.id));
    expect(removed.map((s) => [s.name, s.snapshot, s.startLine])).toEqual([["gone", "base", 1]]);
    const sites = impact.callers.filter((p) => p.seed === removed[0]?.id).flatMap((p) => p.edges[0].sites.map((s) => `${s.file}:${s.line}`));
    expect(sites).toEqual([at(files, "src/b.ts", "GONE")]);
    expect(impact.risk).toBe("high");
    expect(renderImpactBlock(impact)).toContain("`gone` (function), still called from 1 site");
  });

  it("lists every symbol of a deleted file with its surviving callers, without the file on disk", async () => {
    const root = repo(files);
    commitAll(root);
    unlinkSync(join(root, "src/a.ts"));
    const change = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
    const g = await buildGraph({ repoRoot: root, cacheDir: cacheOf(root), files: change.changedPaths, base: { sha: change.baseSha, files: change.files } });
    const impact = detectImpact(g, change);
    const names = impact.symbols.filter((s) => impact.removed.includes(s.id)).map((s) => s.name);
    expect(names.sort()).toEqual(["gone", "kept"]);
    const sites = impact.callers.flatMap((p) => p.edges[0].sites.map((s) => `${s.file}:${s.line}`)).sort();
    expect(sites).toEqual([at(files, "src/b.ts", "GONE"), at(files, "src/b.ts", "KEPT")].sort());
  });
});
