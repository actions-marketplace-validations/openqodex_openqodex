// What each language's lookup order and the value rules may claim. Ways
// they could claim more than the code proves, each on a real repo:
// 4. A Python class whose first base is outside the graph (`UserDict`)
//    binds a member to a later base in the repository as certain, though
//    Python looks in the outside base first.
// 5. Two embedded types that both embed one that defines a method make
//    the Go selector ambiguous, yet one path is kept and the call is certain.
// 6. `include A, B` in Ruby puts A before B, yet the lookup picks B.
// 7. A candidate implementing `Repo<B>` is dropped for a call on `Repo<A>`
//    although TypeScript compares A and B by their shape, not their names.
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
//     type uses, so changing the seventeenth hides the function that names it.
import { afterAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { buildGraph } from "../src/index.js";
import type { Graph } from "../src/index.js";
import { makeRepo } from "./helpers.js";

const repos: string[] = [];
afterAll(() => {
  for (const r of repos) rmSync(r, { recursive: true, force: true });
});

async function graphOf(files: Record<string, string>): Promise<Graph> {
  const root = makeRepo(files);
  repos.push(root);
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

  it("keeps an implementation of Repo<B> as a candidate of a call on Repo<A>, since TypeScript compares types by shape (7)", async () => {
    const g = await graphOf({
      "src/types.ts": "export interface A {\n  id: string;\n}\nexport interface B {\n  id: string;\n}\nexport interface Repo<T> {\n  find(): T;\n}\n",
      "src/b-repo.ts": 'import type { B, Repo } from "./types";\nexport class BRepo implements Repo<B> {\n  find(): B {\n    return { id: "b" };\n  }\n}\n',
      "src/use.ts": 'import type { A, Repo } from "./types";\nexport function use(r: Repo<A>): A {\n  return r.find();\n}\n',
    });
    expect(into(g, idOf(g, "src/b-repo.ts", "BRepo.find"))).toEqual(["src/use.ts:3 dispatches_to possible"]);
  });

  it.skip("keeps the gap of a computed call on a table project-wide when the table is changed, passed on or exported (8)", async () => {
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

  it.skip("keeps a gap at a call of a returned value when one branch returns something other than a named function (9)", async () => {
    const g = await graphOf({
      "src/pick.ts": "function known(): number {\n  return 1;\n}\nfunction pick(flag: boolean, other: () => number): () => number {\n  if (flag) return known;\n  return other;\n}\nexport function run(h: () => number): number {\n  return pick(false, h)();\n}\n",
    });
    expect(into(g, idOf(g, "src/pick.ts", "known"))).toEqual(["src/pick.ts:9 may_invoke possible"]);
    expect(g.unknowns.filter((u) => u.file === "src/pick.ts" && u.line === 9 && u.cause === "dynamic")).toHaveLength(1);
  });

  it.skip("never reads a parameter given another function in the body as calling what the caller passed (10)", async () => {
    const g = await graphOf({
      "src/apply.ts": "function handler(): number {\n  return 1;\n}\nfunction apply(cb: () => number): number {\n  cb = () => 0;\n  return cb();\n}\nexport function run(): number {\n  return apply(handler);\n}\n",
    });
    const handler = idOf(g, "src/apply.ts", "handler");
    expect(into(g, handler)).toEqual([]);
    expect((g.refsIn.get(handler) ?? []).map((e) => e.kind)).toEqual(["uses_value"]);
  });

  it.skip("keeps a Python override that only raises NotImplementedError, or is `...`, among the implementations a call may run (11)", async () => {
    const g = await graphOf({
      "m.py": "class Base:\n    def find(self):\n        return 1\n\n\nclass Raises(Base):\n    def find(self):\n        raise NotImplementedError\n\n\nclass Dots(Base):\n    def find(self):\n        ...\n\n\ndef use(x: Base):\n    return x.find()\n",
    });
    expect(into(g, idOf(g, "m.py", "Raises.find"))).toEqual(["m.py:18 dispatches_to possible"]);
    expect(into(g, idOf(g, "m.py", "Dots.find"))).toEqual(["m.py:18 dispatches_to possible"]);
  });

  it.skip("records a type use for every type an annotation names, past sixteen (12)", async () => {
    const names = Array.from({ length: 17 }, (_, i) => `T${String(i + 1).padStart(2, "0")}`);
    const g = await graphOf({
      "src/types.ts": names.map((t) => `export interface ${t} {\n  k: string;\n}\n`).join(""),
      "src/use.ts": `import type { ${names.join(", ")} } from "./types";\nexport function f(x: ${names.join(" | ")}): string {\n  return x.k;\n}\n`,
    });
    const f = idOf(g, "src/use.ts", "f");
    const used = (g.refsOut.get(f) ?? []).filter((e) => e.kind === "uses_type").map((e) => g.nodes.get(e.to)?.name);
    expect(used.sort()).toEqual(names);
  });
});
