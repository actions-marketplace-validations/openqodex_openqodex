// What each language's lookup order and the value rules may claim. Ways
// they could claim more than the code proves, or less, each on a real repo:
// 4. A Python class whose first base is outside the graph (`UserDict`)
//    binds a member to a later base in the repository as certain, though
//    Python looks in the outside base first.
// 5. Two embedded types that both embed one that defines a method make
//    the Go selector ambiguous, yet one path is kept and the call is certain.
// 6. `include A, B` in Ruby puts A before B, yet the lookup picks B.
// 7. A candidate implementing `Repo<B>` is dropped for a call on `Repo<A>`
//    although TypeScript compares A and B by their shape, not their names.
//    (Proved by the corpus case typescript/dispatch/generic-mismatch.)
// 8. A table whose entries are changed after it is written (`handlers.a =
//    g`), passed on, or exported narrows a computed call to the entries it
//    was written with, so a function put in later reads as never called.
// 9. A function that returns a known function in one branch and a value it
//    was given in another hides the second branch: the call of its result
//    keeps no gap.
// 10. A parameter given another function before it is called still reads
//     as calling what the caller passed.
// 11. A Python override whose body only raises NotImplementedError, or is
//     `...`, is taken for abstract and left out of the implementations a
//     call may run, though it runs and raises.
// 12. An annotation naming more than sixteen types records only sixteen
//     type uses, so changing the seventeenth hides the function that names
//     it; and an annotation too large to read whole drops names unsaid.
// 13. A function written as `const apply = (cb) => cb()` records no
//     parameters and no returns, so a function passed to it, or returned
//     by it by name, gets no possible caller (most TypeScript is written so).
// 14. `const h = pick(k)()` reads as holding what `pick(k)` returns, since
//     both calls start at one place, so `h()` reads as calling a function
//     pick returns, which never runs there.
import { afterAll, describe, expect, it } from "vitest";
import { buildGraph } from "../src/index.js";
import type { Graph } from "../src/index.js";
import { makeRepo } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

// Every folder the shared helpers made for this file goes when it ends (tests/temp-guard.ts).
afterAll(removeTempDirs);

async function graphOf(files: Record<string, string>): Promise<Graph> {
  const root = makeRepo(files);
  return buildGraph({ repoRoot: root, store: null });
}

const idOf = (g: Graph, file: string, qualified: string): string => {
  const hit = (g.defsByFile.get(file) ?? []).find((n) => n.id.includes(`#${qualified}@`));
  if (!hit) throw new Error(`no ${qualified} in ${file}`);
  return hit.id;
};

// "file:line kind tier" of every edge site into `id`, in the callers profile.
const into = (g: Graph, id: string): string[] =>
  (g.in.get(id) ?? []).flatMap((e) => e.sites.map((s) => `${s.file}:${s.line} ${e.kind} ${s.tier}`)).sort();

describe("lookup orders and value rules", () => {
  it("never binds a Python member as certain past a base outside the graph that Python looks in first (4)", async () => {
    const g = await graphOf({
      "known.py": "class Known:\n    def keys(self):\n        return []\n",
      "use.py": "from collections import UserDict\nfrom known import Known\n\n\nclass C(UserDict, Known):\n    pass\n\n\nclass D(Known, UserDict):\n    pass\n\n\ndef run():\n    return C().keys() + D().keys()\n",
    });
    const keys = idOf(g, "known.py", "Known.keys");
    expect(into(g, keys)).toEqual(["use.py:14 calls likely", "use.py:14 calls certain"].sort());
    const site = (g.in.get(keys) ?? []).flatMap((e) => e.sites).find((s) => s.tier === "likely");
    expect(site?.note).toContain("UserDict");
  });

  it("finds a Go selector ambiguous when two embedded types both embed the type that defines it (5)", async () => {
    const g = await graphOf({
      "go.mod": "module example.com/p\n\ngo 1.22\n",
      "p.go": "package p\n\ntype A struct{}\n\nfunc (A) M() {}\n\ntype L struct{ A }\n\ntype R struct{ A }\n\ntype Both struct {\n\tL\n\tR\n}\n\nfunc use() {\n\tb := Both{}\n\tb.M()\n}\n",
    });
    expect(into(g, idOf(g, "p.go", "A.M"))).toEqual([]);
    expect(g.unknowns.filter((u) => u.file === "p.go" && u.line === 18).map((u) => u.cause)).toEqual(["ambiguous"]);
  });

  it("puts the first module of `include A, B` before the second, and a later include before an earlier one (6)", async () => {
    const g = await graphOf({
      "m.rb": "module A\n  def m\n    1\n  end\nend\n\nmodule B\n  def m\n    2\n  end\nend\n\nclass One\n  include A, B\nend\n\nclass Two\n  include A\n  include B\nend\n\ndef run\n  One.new.m + Two.new.m\nend\n",
    });
    expect(into(g, idOf(g, "m.rb", "A.m"))).toEqual(["m.rb:23 calls certain"]);
    expect(into(g, idOf(g, "m.rb", "B.m"))).toEqual(["m.rb:23 calls certain"]);
    const sites = (id: string) => (g.in.get(id) ?? []).flatMap((e) => e.sites.map((s) => s.column));
    expect(sites(idOf(g, "m.rb", "A.m"))).toHaveLength(1);
    expect(sites(idOf(g, "m.rb", "A.m"))[0]).toBeLessThan(sites(idOf(g, "m.rb", "B.m"))[0] as number);
  });

  it("keeps the gap of a computed call on a table project-wide when the table is changed, passed on or exported (8)", async () => {
    const g = await graphOf({
      "src/other.ts": "export function g(): number {\n  return 2;\n}\n",
      "src/written.ts": 'import { g } from "./other";\nfunction f(): number {\n  return 1;\n}\nconst handlers: Record<string, () => number> = { a: f };\nhandlers.b = g;\nexport function run(k: string): number {\n  return handlers[k]();\n}\n',
      "src/passed.ts": 'function f(): number {\n  return 1;\n}\nconst handlers: Record<string, () => number> = { a: f };\nexport function setup(fill: (t: Record<string, () => number>) => void): void {\n  fill(handlers);\n}\nexport function run(k: string): number {\n  return handlers[k]();\n}\n',
      "src/exported.ts": "function f(): number {\n  return 1;\n}\nexport const handlers: Record<string, () => number> = { a: f };\nexport function run(k: string): number {\n  return handlers[k]();\n}\n",
      "src/closed.ts": "function f(): number {\n  return 1;\n}\nconst handlers: Record<string, () => number> = { a: f };\nexport function run(k: string): number {\n  return handlers[k]();\n}\n",
    });
    const gap = (file: string, line: number) => g.unknowns.find((u) => u.file === file && u.line === line && u.cause === "dynamic");
    expect(gap("src/written.ts", 8)?.scope).toBe("project");
    expect(gap("src/passed.ts", 9)?.scope).toBe("project");
    expect(gap("src/exported.ts", 6)?.scope).toBe("project");
    expect(gap("src/closed.ts", 6)?.scope).toBe("file");
    expect(into(g, idOf(g, "src/written.ts", "f"))).toEqual(["src/written.ts:8 may_invoke possible"]);
  });

  it("keeps a gap at a call of a returned value when one branch returns something other than a named function (9)", async () => {
    const g = await graphOf({
      "src/pick.ts": "function known(): number {\n  return 1;\n}\nfunction pick(flag: boolean, other: () => number): () => number {\n  if (flag) return known;\n  return other;\n}\nexport function run(h: () => number): number {\n  return pick(false, h)();\n}\n",
    });
    expect(into(g, idOf(g, "src/pick.ts", "known"))).toEqual(["src/pick.ts:9 may_invoke possible"]);
    expect(g.unknowns.filter((u) => u.file === "src/pick.ts" && u.line === 9 && u.cause === "dynamic")).toHaveLength(1);
  });

  it("never reads a parameter given another function in the body as calling what the caller passed (10)", async () => {
    const g = await graphOf({
      "src/apply.ts": "function handler(): number {\n  return 1;\n}\nfunction apply(cb: () => number): number {\n  cb = () => 0;\n  return cb();\n}\nexport function run(): number {\n  return apply(handler);\n}\n",
    });
    const handler = idOf(g, "src/apply.ts", "handler");
    expect(into(g, handler)).toEqual([]);
    expect((g.refsIn.get(handler) ?? []).map((e) => e.kind)).toEqual(["uses_value"]);
  });

  it("keeps a Python override that only raises NotImplementedError, or is `...`, among the implementations a call may run (11)", async () => {
    const g = await graphOf({
      "m.py": "class Base:\n    def find(self):\n        return 1\n\n\nclass Raises(Base):\n    def find(self):\n        raise NotImplementedError\n\n\nclass Dots(Base):\n    def find(self):\n        ...\n\n\ndef use(x: Base):\n    return x.find()\n",
    });
    expect(into(g, idOf(g, "m.py", "Raises.find"))).toEqual(["m.py:17 dispatches_to possible"]);
    expect(into(g, idOf(g, "m.py", "Dots.find"))).toEqual(["m.py:17 dispatches_to possible"]);
  });

  it("records a type use for every type an annotation names, past sixteen, and a gap for one too large to read (12)", async () => {
    const names = Array.from({ length: 17 }, (_, i) => `T${String(i + 1).padStart(2, "0")}`);
    const many = Array.from({ length: 3000 }, (_, i) => `U${i}`);
    const g = await graphOf({
      "src/types.ts": names.map((t) => `export interface ${t} {\n  k: string;\n}\n`).join(""),
      "src/use.ts": `import type { ${names.join(", ")} } from "./types";\nexport function f(x: ${names.join(" | ")}): string {\n  return x.k;\n}\n`,
      "src/huge.ts": `export function h(x: ${many.join(" | ")}): number {\n  return 1;\n}\n`,
    });
    const f = idOf(g, "src/use.ts", "f");
    const used = (g.refsOut.get(f) ?? []).filter((e) => e.kind === "uses_type").map((e) => g.nodes.get(e.to)?.name);
    expect(used.sort()).toEqual(names);
    expect(g.unknowns.filter((u) => u.file === "src/huge.ts").map((u) => u.cause)).toEqual(["unsupported-rule"]);
  });

  it("reads the parameters and the returns of a function written as a const arrow or function expression (13)", async () => {
    const g = await graphOf({
      "src/apply.ts":
        "function handler(): number {\n  return 1;\n}\nfunction known(): number {\n  return 2;\n}\nexport const apply = (cb: () => number): number => cb();\nexport const each = function (f: () => number): number {\n  return f();\n};\nexport const pick = (k: string) => known;\nexport const run = (k: string): number => apply(handler) + each(handler) + pick(k)();\n",
    });
    expect(into(g, idOf(g, "src/apply.ts", "handler"))).toEqual(["src/apply.ts:12 may_invoke possible", "src/apply.ts:12 may_invoke possible"]);
    expect(into(g, idOf(g, "src/apply.ts", "known"))).toEqual(["src/apply.ts:12 may_invoke possible"]);
  });

  it("never reads a const given the result of a call of a returned function as holding that function (14)", async () => {
    const g = await graphOf({
      "src/chain.ts":
        "function known(): () => number {\n  return () => 1;\n}\nfunction pick(k: string): () => () => number {\n  return known;\n}\nexport function run(k: string): number {\n  const h = pick(k)();\n  return h();\n}\n",
    });
    expect(into(g, idOf(g, "src/chain.ts", "known"))).toEqual(["src/chain.ts:8 may_invoke possible"]);
  });
});
