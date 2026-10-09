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
// 5. A function moved and renamed with the same body reads as removed (it
//    is a move under another name), or one renamed with a changed body is
//    called a move.
// 6. A file git sees as renamed hides a caller that still imports the old
//    path, since its symbols were compared against the new path only.
// 7. A declaration replaced by `export { f } from "./new.js"` is reported as
//    removed instead of moved, or its callers are not bound to the new file.
// 8. The placeSettings case: a function moved to a file the caller loads
//    with `await import()` inside a function. The call fell back to the
//    caller's own file, where the old definition was, and read as a caller
//    of the removed symbol.
// 9. A name loaded with `await import()` inside one function binds the same
//    name in another function of the file, which hides that function's
//    broken call to the removed symbol.
// 10. A `let` or `const` inside a block (or a for or catch binding) hides a
//     call after the block, which still reaches the removed symbol.
// 11. A call in a default value of a destructured `await import()` is never
//     read, so its call to the removed symbol is lost.
// 12. The Python form of 9: `from .b import f` inside one function binds `f`
//     for the whole module.
// 13. A receiver whose type a scoped import gives (`new Svc()`, a factory's
//     declared result, a qualified annotation `b.Svc`) loses its type, so a
//     call to a removed method is lost.
// 14. A receiver named before its scope declares it (`const run = () =>
//     m.f(); const m = require("./b")`) is not bound to that declaration, so
//     a call to a removed function is lost.
// 15. A receiver typed by an outer local wins over the inner declaration the
//     scope makes later, so a call to the inner object's removed method links
//     to the outer object's method instead.
// 16. Assigning a new value to an imported class after an object was built
//     from it erases where the object came from, so a call to its removed
//     method is lost.
import { afterAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { getChange } from "@openqodex/core";
import type { ImpactSummary, ImpactSymbol } from "@openqodex/core";
import { buildGraph, detectImpact, renderImpactBlock } from "../src/index.js";
import type { Graph } from "../src/index.js";
import { at, callSites, commitAll, git, makeRepo, symbol, writeFiles } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

// The repo with `base` committed, then `change` written (null deletes a file)
// and `steps` run, reviewed as an uncommitted change.
async function review(
  base: Record<string, string>,
  change: Record<string, string | null>,
  steps: (root: string) => void = () => {},
): Promise<{ root: string; g: Graph; impact: ImpactSummary; block: string }> {
  const root = makeRepo(base);
  commitAll(root);
  steps(root);
  for (const [path, text] of Object.entries(change)) {
    if (text === null) rmSync(join(root, path));
    else writeFiles(root, { [path]: text });
  }
  const c = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
  const g = await buildGraph({ repoRoot: root, store: null, files: c.changedPaths, base: { sha: c.baseSha, files: c.files } });
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

  it("reports a function moved and renamed with the same body as moved and renamed, and one with a changed body as removed (5)", async () => {
    const base = {
      "src/a.ts": "export function f(): number {\n  return 1;\n}\n\nexport function keep(): number {\n  return 2;\n}\n",
      "src/b.ts": 'import { f } from "./a.js";\n\nexport function b(): number {\n  return f();\n}\n',
    };
    const same = {
      "src/a.ts": "export function keep(): number {\n  return 2;\n}\n",
      "src/new.ts": "export function g(): number {\n  return 1;\n}\n",
      "src/b.ts": 'import { g } from "./new.js";\n\nexport function b(): number {\n  return g();\n}\n',
    };
    const moved = await review(base, same);
    const f = removedNamed(moved.impact, "f");
    expect(f.movedTo).toEqual({ id: symbol(moved.g, "src/new.ts", "g"), file: "src/new.ts", line: 1, renamed: true });
    expect(stillCalled(moved.impact, f.id)).toEqual([]);
    expect(moved.block).toContain("moved and renamed to `g` at src/new.ts:1 (the same body)");

    const changed = await review(base, { ...same, "src/new.ts": "export function g(): number {\n  return 7;\n}\n" });
    expect(removedNamed(changed.impact, "f").movedTo).toBeUndefined();
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

  it("keeps a name loaded with await import() inside one function out of the other functions of the file (9)", async () => {
    const base = {
      "src/a.ts": "export function f(): number {\n  return 1;\n}\n\nexport function oldCaller(): number {\n  return f(); // BROKEN\n}\n",
    };
    const change = {
      "src/a.ts":
        'export function oldCaller(): number {\n  return f(); // BROKEN\n}\n\nexport async function loader(): Promise<number> {\n  const { f } = await import("./b.js");\n  return f(); // LOADED\n}\n',
      "src/b.ts": "export function f(): number {\n  return 1;\n}\n",
    };
    const { g, impact } = await review(base, change);
    const f = removedNamed(impact, "f");
    expect(f.movedTo).toBeUndefined();
    expect(stillCalled(impact, f.id)).toEqual([at(change, "src/a.ts", "BROKEN")]);
    expect(callSites(g, symbol(g, "src/b.ts", "f"))).toEqual([at(change, "src/a.ts", "LOADED")]);
    expect(impact.risk).toBe("high");
  });

  it("lets a let, a const, a for binding or a catch binding hide a name only inside its block, and a var in its whole function (10)", async () => {
    const run = [
      "export function run(deps: { f: () => number }, list: (() => number)[]): number {",
      "  {",
      "    const { f } = deps;",
      "    f();",
      "  }",
      "  for (const f of list) f();",
      "  try {",
      "    f(); // TRY",
      "  } catch (f) {",
      "    if (typeof f === 'function') f();",
      "  }",
      "  return f(); // OUTER",
      "}",
      "",
      "export function viaVar(deps: { f: () => number }): number {",
      "  {",
      "    var f = deps.f;",
      "  }",
      "  return f(); // VAR",
      "}",
      "",
    ].join("\n");
    const base = { "src/a.ts": `export function f(): number {\n  return 1;\n}\n\n${run}` };
    const change = { "src/a.ts": run };
    const { impact } = await review(base, change);
    const f = removedNamed(impact, "f");
    expect(stillCalled(impact, f.id).sort()).toEqual([at(change, "src/a.ts", "TRY"), at(change, "src/a.ts", "OUTER")].sort());
    expect(impact.risk).toBe("high");
  });

  it("reads a call in a default value of a destructured await import() (11)", async () => {
    const load = 'export async function load(): Promise<number> {\n  const { a = fallback() } = await import("./m.js"); // DEFAULT\n  return a();\n}\n';
    const base = {
      "src/a.ts": `export function fallback(): () => number {\n  return () => 1;\n}\n\n${load}`,
      "src/m.ts": "export function a(): number {\n  return 2;\n}\n",
    };
    const { impact } = await review(base, { "src/a.ts": load });
    const fallback = removedNamed(impact, "fallback");
    expect(stillCalled(impact, fallback.id)).toEqual([at({ "src/a.ts": load }, "src/a.ts", "DEFAULT")]);
    expect(impact.risk).toBe("high");
  });

  it("keeps a Python import inside one function out of the other functions of the module (12)", async () => {
    const base = { "pkg/a.py": "def f():\n    return 1\n\n\ndef old_caller():\n    return f()  # BROKEN\n" };
    const change = {
      "pkg/a.py": "def old_caller():\n    return f()  # BROKEN\n\n\ndef loader():\n    from .b import f\n    return f()  # LOADED\n",
      "pkg/b.py": "def f():\n    return 1\n",
    };
    const { g, impact } = await review(base, change);
    const f = removedNamed(impact, "f");
    expect(f.movedTo).toBeUndefined();
    expect(stillCalled(impact, f.id)).toEqual([at(change, "pkg/a.py", "BROKEN")]);
    expect(callSites(g, symbol(g, "pkg/b.py", "f"))).toEqual([at(change, "pkg/a.py", "LOADED")]);
  });

  it("types a receiver through a scoped import: a constructor, a factory result and a qualified annotation (13)", async () => {
    const svcJs = (withF: boolean) => `class Svc {\n${withF ? "  f() {\n    return 1;\n  }\n\n" : ""}  g() {\n    return 2;\n  }\n}\n\nmodule.exports = { Svc };\n`;
    const madeTs = (withF: boolean) =>
      `export class Made {\n${withF ? "  f(): number {\n    return 1;\n  }\n\n" : ""}  g(): number {\n    return 2;\n  }\n}\n\nexport function make(): Made {\n  return new Made();\n}\n`;
    const svcPy = (withF: boolean) => `class Svc:\n${withF ? "    def f(self):\n        return 1\n\n" : ""}    def g(self):\n        return 2\n`;
    const user = {
      "src/a.js": 'function run() {\n  const { Svc } = require("./svc");\n  const s = new Svc();\n  return s.f(); // CTOR\n}\n\nmodule.exports = { run };\n',
      "src/b.ts": 'export async function viaFactory(): Promise<number> {\n  const { make } = await import("./made.js");\n  const s = make();\n  return s.f(); // FACTORY\n}\n',
      "pkg/__init__.py": "",
      "pkg/a.py": "def run():\n    from . import b\n    s: b.Svc = b.Svc()\n    return s.f()  # QUALIFIED\n",
    };
    const base = { ...user, "src/svc.js": svcJs(true), "src/made.ts": madeTs(true), "pkg/b.py": svcPy(true) };
    const { impact } = await review(base, { "src/svc.js": svcJs(false), "src/made.ts": madeTs(false), "pkg/b.py": svcPy(false) });
    const sites = (file: string) => {
      const s = impact.symbols.find((x) => impact.removed.includes(x.id) && x.file === file && x.name === "f") as ImpactSymbol;
      return stillCalled(impact, s.id);
    };
    expect(sites("src/svc.js")).toEqual([at(user, "src/a.js", "CTOR")]);
    expect(sites("src/made.ts")).toEqual([at(user, "src/b.ts", "FACTORY")]);
    expect(sites("pkg/b.py")).toEqual([at(user, "pkg/a.py", "QUALIFIED")]);
  });

  it("binds a receiver named before its scope declares it to that declaration (14)", async () => {
    const lib = (withF: boolean) => `${withF ? "function f() {\n  return 1;\n}\n\n" : ""}function g() {\n  return 2;\n}\n\nmodule.exports = { ${withF ? "f, " : ""}g };\n`;
    const user = { "src/a.js": 'function run() {\n  const invoke = () => m.f(); // EARLY\n  const m = require("./b");\n  return invoke();\n}\n\nmodule.exports = { run };\n' };
    const { impact } = await review({ ...user, "src/b.js": lib(true) }, { "src/b.js": lib(false) });
    const f = removedNamed(impact, "f");
    expect(stillCalled(impact, f.id)).toEqual([at(user, "src/a.js", "EARLY")]);
  });

  it("types a receiver by the declaration its own scope makes later, not by an outer local of the same name (15)", async () => {
    const file = (withBf: boolean) =>
      `class A {\n  f(): number {\n    return 1;\n  }\n}\n\nclass B {\n${withBf ? "  f(): number {\n    return 2;\n  }\n\n" : ""}  g(): number {\n    return 3;\n  }\n}\n\nconst s = new A();\n\nexport function run(): number {\n  const invoke = () => s.f(); // LATER\n  const s = new B();\n  return invoke();\n}\n`;
    const { g, impact } = await review({ "src/a.ts": file(true) }, { "src/a.ts": file(false) });
    const bf = impact.symbols.find((s) => impact.removed.includes(s.id) && s.name === "f") as ImpactSymbol;
    expect(bf.id).toContain("#B.f@");
    expect(stillCalled(impact, bf.id)).toEqual([at({ "src/a.ts": file(false) }, "src/a.ts", "LATER")]);
    expect(callSites(g, symbol(g, "src/a.ts", "f", "A"))).toEqual([]);
  });

  it("keeps where an object came from when the class it was built from is assigned a new value later (16)", async () => {
    const lib = (withF: boolean) => `class Svc {\n${withF ? "  f() {\n    return 1;\n  }\n\n" : ""}  g() {\n    return 2;\n  }\n}\n\nmodule.exports = { Svc };\n`;
    const user = {
      "src/a.js": 'function run(replacement) {\n  let { Svc } = require("./b");\n  const s = new Svc();\n  Svc = replacement;\n  return s.f(); // BUILT\n}\n\nmodule.exports = { run };\n',
    };
    const { impact } = await review({ ...user, "src/b.js": lib(true) }, { "src/b.js": lib(false) });
    expect(stillCalled(impact, removedNamed(impact, "f").id)).toEqual([at(user, "src/a.js", "BUILT")]);
  });
});
