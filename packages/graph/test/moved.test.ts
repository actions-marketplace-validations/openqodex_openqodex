// A symbol the change moved to another file, written down before the code
// (issue #26). Ways the blast radius could get a move wrong, each checked on
// a real git repo in a temp folder:
// 1. A function moved to a new file, with its import updated, is reported as
//    removed and still called, and raises the risk to high.
// 2. A move hides a caller that still imports the old file: that caller is
//    broken, so the symbol must stay "removed, still called".
// 3. A same-named definition in a file the change did not touch is taken for
//    the destination.
// 4. A name that two files of the change now define is called a move to one of them.
// 5. A function moved and renamed is called a move (the stated limit: it reads as removed).
// 6. A file git sees as renamed hides a caller that still imports the old
//    path, since its symbols were compared against the new path only.
// 7. A declaration replaced by `export { f } from "./new.js"` is reported as
//    removed instead of moved, or its callers are not bound to the new file.
// 8. The placeSettings case: a function moved to a file the caller loads
//    with `await import()` inside a function. The call fell back to the
//    caller's own file, where the old definition was, and read as a caller
//    of the removed symbol.
import { afterAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { getChange } from "@openqodex/core";
import type { ImpactSummary, ImpactSymbol } from "@openqodex/core";
import { buildGraph, detectImpact, renderImpactBlock } from "../src/index.js";
import type { Graph } from "../src/index.js";
import { at, callSites, commitAll, git, makeRepo, symbol, writeFiles } from "./helpers.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// The repo with `base` committed, then `change` written (null deletes a file)
// and `steps` run, reviewed as an uncommitted change.
async function review(
  base: Record<string, string>,
  change: Record<string, string | null>,
  steps: (root: string) => void = () => {},
): Promise<{ root: string; g: Graph; impact: ImpactSummary; block: string }> {
  const root = makeRepo(base);
  dirs.push(root);
  commitAll(root);
  steps(root);
  for (const [path, text] of Object.entries(change)) {
    if (text === null) rmSync(join(root, path));
    else writeFiles(root, { [path]: text });
  }
  const c = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
  const g = await buildGraph({ repoRoot: root, cacheDir: join(root, ".openqodex", "graph"), files: c.changedPaths, base: { sha: c.baseSha, files: c.files } });
  const impact = detectImpact(g, c);
  return { root, g, impact, block: renderImpactBlock(impact) };
}

function removedNamed(impact: ImpactSummary, name: string): ImpactSymbol {
  const hits = impact.symbols.filter((s) => impact.removed.includes(s.id) && s.name === name);
  if (hits.length !== 1) throw new Error(`${hits.length} removed symbols named ${name}`);
  return hits[0] as ImpactSymbol;
}

// Call sites that still reach a removed symbol, as "path:line".
function stillCalled(impact: ImpactSummary, id: string): string[] {
  return impact.callers.filter((p) => p.seed === id && p.edges.length === 1).flatMap((p) => p.edges[0].sites.map((s) => `${s.file}:${s.line}`));
}

describe("moved symbols", () => {
  it("reports a function moved to a new file, with its import updated, as moved and not as removed and still called (1)", async () => {
    const base = {
      "src/hook.ts": "export function place(): number {\n  return 1;\n}\n\nexport function scan(): number {\n  return place();\n}\n",
    };
    const change = {
      "src/checkout.ts": "export function place(): number {\n  return 1;\n}\n",
      "src/hook.ts": 'import { place } from "./checkout.js";\n\nexport function scan(): number {\n  return place(); // CALL\n}\n',
    };
    const { g, impact, block } = await review(base, change);
    const moved = removedNamed(impact, "place");
    expect(moved.movedTo).toEqual({ id: symbol(g, "src/checkout.ts", "place"), file: "src/checkout.ts", line: 1 });
    expect(stillCalled(impact, moved.id)).toEqual([]);
    // The caller is listed under the definition it now calls.
    expect(callSites(g, symbol(g, "src/checkout.ts", "place"))).toEqual([at(change, "src/hook.ts", "CALL")]);
    expect(impact.risk).toBe("medium");
    expect(block).toContain("- src/hook.ts:1 `place` (function), moved to src/checkout.ts:1");
    expect(block).toContain("1 moved");
    expect(block).not.toContain("still called");
    expect(block).not.toContain("Removed by this change");
  });

  it("keeps a moved function removed and still called while one caller imports the old file (2)", async () => {
    const base = {
      "src/a.ts": "export function f(): number {\n  return 1;\n}\n\nexport function keep(): number {\n  return 2;\n}\n",
      "src/b.ts": 'import { f } from "./a.js";\n\nexport function b(): number {\n  return f();\n}\n',
      "src/c.ts": 'import { f } from "./a.js";\n\nexport function c(): number {\n  return f(); // OLD\n}\n',
    };
    const change = {
      "src/a.ts": "export function keep(): number {\n  return 2;\n}\n",
      "src/new.ts": "export function f(): number {\n  return 1;\n}\n",
      "src/b.ts": 'import { f } from "./new.js";\n\nexport function b(): number {\n  return f();\n}\n',
    };
    const { impact, block } = await review(base, change);
    const f = removedNamed(impact, "f");
    expect(f.movedTo).toBeUndefined();
    expect(stillCalled(impact, f.id)).toEqual([at(base, "src/c.ts", "OLD")]);
    expect(impact.risk).toBe("high");
    expect(block).toContain("- src/a.ts:1 `f` (function), still called from 1 site");
  });

  it("never takes a same-named function in a file the change did not touch for the destination (3)", async () => {
    const base = {
      "src/a.ts": "export function f(): number {\n  return 1;\n}\n\nexport function keep(): number {\n  return 2;\n}\n",
      "src/other.ts": "export function f(): string {\n  return 'unrelated';\n}\n",
    };
    const { impact, block } = await review(base, { "src/a.ts": "export function keep(): number {\n  return 2;\n}\n" });
    expect(removedNamed(impact, "f").movedTo).toBeUndefined();
    expect(block).toContain("- src/a.ts:1 `f` (function)\n");
    expect(block).not.toContain("moved to");
  });

  it("never calls it a move when two files of the change now define the name (4)", async () => {
    const base = { "src/a.ts": "export function f(): number {\n  return 1;\n}\n\nexport function keep(): number {\n  return 2;\n}\n" };
    const change = {
      "src/a.ts": "export function keep(): number {\n  return 2;\n}\n",
      "src/x.ts": "export function f(): number {\n  return 1;\n}\n",
      "src/y.ts": "export function f(): number {\n  return 3;\n}\n",
    };
    const { impact } = await review(base, change);
    expect(removedNamed(impact, "f").movedTo).toBeUndefined();
  });

  it("reads a function moved and renamed as removed, the stated limit (5)", async () => {
    const base = {
      "src/a.ts": "export function f(): number {\n  return 1;\n}\n\nexport function keep(): number {\n  return 2;\n}\n",
      "src/b.ts": 'import { f } from "./a.js";\n\nexport function b(): number {\n  return f();\n}\n',
    };
    const change = {
      "src/a.ts": "export function keep(): number {\n  return 2;\n}\n",
      "src/new.ts": "export function g(): number {\n  return 1;\n}\n",
      "src/b.ts": 'import { g } from "./new.js";\n\nexport function b(): number {\n  return g();\n}\n',
    };
    const { impact } = await review(base, change);
    const f = removedNamed(impact, "f");
    expect(f.movedTo).toBeUndefined();
    expect(stillCalled(impact, f.id)).toEqual([]);
  });

  it("checks the symbols of a file git sees as renamed: moved with the file, or still called through the old path (6)", async () => {
    const a = "export function f(): number {\n  return 1;\n}\n\nexport function g(): number {\n  return 2;\n}\n";
    const base = {
      "src/a.ts": a,
      "src/b.ts": 'import { f } from "./a.js";\n\nexport function b(): number {\n  return f();\n}\n',
      "src/c.ts": 'import { g } from "./a.js";\n\nexport function c(): number {\n  return g(); // OLD\n}\n',
    };
    const change = { "src/b.ts": 'import { f } from "./renamed.js";\n\nexport function b(): number {\n  return f();\n}\n' };
    const { g, impact } = await review(base, change, (root) => git(root, "mv", "src/a.ts", "src/renamed.ts"));
    const f = removedNamed(impact, "f");
    expect(f.file).toBe("src/a.ts");
    expect(f.movedTo).toEqual({ id: symbol(g, "src/renamed.ts", "f"), file: "src/renamed.ts", line: 1 });
    const gone = removedNamed(impact, "g");
    expect(gone.movedTo).toBeUndefined();
    expect(stillCalled(impact, gone.id)).toEqual([at(base, "src/c.ts", "OLD")]);
    expect(impact.risk).toBe("high");
  });

  it("reports a declaration replaced by a re-export of a new file as moved there, with its callers bound to it (7)", async () => {
    const base = {
      "src/a.ts": "export function f(): number {\n  return 1;\n}\n\nexport function keep(): number {\n  return 2;\n}\n",
      "src/b.ts": 'import { f } from "./a.js";\n\nexport function b(): number {\n  return f(); // CALL\n}\n',
    };
    const change = {
      "src/a.ts": 'export { f } from "./new.js";\n\nexport function keep(): number {\n  return 2;\n}\n',
      "src/new.ts": "export function f(): number {\n  return 1;\n}\n",
    };
    const { g, impact } = await review(base, change);
    const f = removedNamed(impact, "f");
    expect(f.movedTo?.file).toBe("src/new.ts");
    expect(stillCalled(impact, f.id)).toEqual([]);
    expect(callSites(g, symbol(g, "src/new.ts", "f"))).toEqual([at(base, "src/b.ts", "CALL")]);
    expect(impact.risk).not.toBe("high");
  });

  it("binds a call to a function loaded with await import() inside the caller, so its move is not read as still called (8)", async () => {
    const base = {
      "src/hook.ts":
        "function place(root: string): string {\n  return root;\n}\n\nexport async function scanCommit(root: string): Promise<string> {\n  return place(root);\n}\n",
    };
    const change = {
      "src/checkout.ts": "export function place(root: string): string {\n  return root;\n}\n",
      "src/hook.ts":
        'export async function scanCommit(root: string): Promise<string> {\n  const { place } = await import("./checkout.js");\n  return place(root); // NAMED\n}\n\nexport async function viaModule(root: string): Promise<string> {\n  const checkout = await import("./checkout.js");\n  return checkout.place(root); // MODULE\n}\n',
    };
    const { g, impact, block } = await review(base, change);
    expect(g.misses.filter((m) => m.name === "place")).toEqual([]);
    expect(callSites(g, symbol(g, "src/checkout.ts", "place"))).toEqual([at(change, "src/hook.ts", "NAMED"), at(change, "src/hook.ts", "MODULE")]);
    expect(removedNamed(impact, "place").movedTo?.file).toBe("src/checkout.ts");
    expect(block).not.toContain("still called");
  });
});
