// One walk of a parse tree that serves the Express, React and Next.js fact
// readers at once (src/walk.ts). Ways it could fail,
// written before the code:
// 1. A reader sees other nodes, or the same nodes in another order, than
//    its own walk showed it, so its facts change.
// 2. A reader that skips a node's children hides them from the others.
// 3. A reader that throws loses the facts of the others, or keeps being
//    called and throws again on every node.
// 4. A reader is told it left a node at another point than its own walk
//    told it, so a scope or a frame it keeps closes at the wrong node.
// 5. A reader riding on the core extractor's walk sees other nodes than
//    its own walk showed it, or the extractor's facts change when readers
//    ride along: the extractor skips the children of a node the readers
//    still read (an import, a type alias, an interface member) and walks
//    into a region the parser could not read, which the readers never enter.
// 6. A reader that names its types is entered for another node, or not for
//    one of its types, is told it left a node it was not entered for, or
//    reads an ancestor the walk did not make as null or as another node.
// The first test proves 1, 2 and 4 by the facts each plugin reads.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Node } from "web-tree-sitter";
import { langOf } from "../src/capture/inventory.js";
import { extract } from "../src/extract.js";
import { frameworkFacts, frameworkReaders } from "../src/frameworks/facts.js";
import type { FrameworkFactBase, FrameworkPlugin } from "../src/frameworks/plugin.js";
import { PLUGINS } from "../src/frameworks/registry.js";
import { walkTree } from "../src/walk.js";
import type { TreeVisitor } from "../src/walk.js";
import { parserFor } from "../src/parser.js";
import type { Lang } from "../src/types.js";

const corpus = join(dirname(fileURLToPath(import.meta.url)), "..", "corpus", "frameworks");

// Every JavaScript and TypeScript file of the Express, React and Next.js corpus cases.
function sources(): { path: string; lang: Lang; text: string }[] {
  const out: { path: string; lang: Lang; text: string }[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) visit(path);
      else {
        const lang = langOf(name);
        if (lang === "javascript" || lang === "typescript" || lang === "tsx") out.push({ path, lang, text: readFileSync(path, "utf8") });
      }
    }
  };
  for (const plugin of ["express", "react", "nextjs"]) visit(join(corpus, plugin));
  return out;
}

// A region the parser cannot read, a skipped subtree and nested functions in one file.
const BROKEN = 'export function a() {\n  const f = () => { return <div>{g(1}</div>; };\n  return f;\n}\nfunction b(x) {\n  if (x) { return x.y.z(); }\n}\nexport const c = { d: [1, 2, (3 + ] };\n';

// Nodes the core extractor skips the children of, which the readers still read.
const SKIPPED = 'import express, { Router } from "express";\ntype Mount = (app: Express, prefix: string) => void;\ninterface Setup { run(app: express.Express): void; }\nexport const setup = (app: Express) => { app.get("/x", (req, res) => res.send(<b>{f(1}</b>)); };\n';

async function tree(lang: Lang, text: string) {
  const t = (await parserFor(lang)).parse(text);
  if (!t) throw new Error("no tree");
  return t;
}

describe("one walk for every JavaScript fact reader", () => {
  it("gives each plugin through one walk exactly the facts it reads alone", async () => {
    for (const f of [...sources(), { path: "broken.tsx", lang: "tsx" as Lang, text: BROKEN }]) {
      const t = await tree(f.lang, f.text);
      try {
        const shared = frameworkFacts(t.rootNode, f.lang, f.text) ?? {};
        for (const p of PLUGINS) {
          if (!p.languages.includes(f.lang) || !p.reader) continue;
          const alone = p.facts(t.rootNode, f.lang);
          expect(shared[p.id] ?? [], `${p.id} on ${f.path}`).toEqual(alone);
        }
      } finally {
        t.delete();
      }
    }
  });

  it("gives the readers riding on the core extractor's walk the facts they read alone, and the extractor its own (5)", async () => {
    for (const f of [...sources(), { path: "broken.tsx", lang: "tsx" as Lang, text: BROKEN }, { path: "skipped.tsx", lang: "tsx" as Lang, text: SKIPPED }]) {
      const t = await tree(f.lang, f.text);
      try {
        const reading = frameworkReaders(t.rootNode, f.lang, f.text);
        expect(reading.visitors.length, f.path).toBeGreaterThan(0);
        const together = extract(t, f.lang, reading.visitors);
        expect(together, f.path).toEqual(extract(t, f.lang));
        expect(reading.finish(), f.path).toEqual(frameworkFacts(t.rootNode, f.lang, f.text));
      } finally {
        t.delete();
      }
    }
  });

  it("enters a reader that names its types for those alone, leaves it where it entered, and gives it every ancestor (6)", async () => {
    const types = new Set(["call_expression", "jsx_self_closing_element", "required_parameter", "string"]);
    const keep = new Set(["lexical_declaration"]);
    // What a reader is told at a node: the node, and its three nearest ancestors as nodes and as types.
    const seen = (node: Node, type: string, depth: number, up: (k: number) => Node | null, upType: (k: number) => string | null) =>
      `enter ${type} ${depth} ${node.startIndex} ${node.type} ${[1, 2, 3].map((k) => `${up(k)?.id ?? "-"}:${up(k)?.type ?? "-"}:${upType(k) ?? "-"}`).join(" ")}`;
    let entered = 0;
    for (const f of [...sources(), { path: "broken.tsx", lang: "tsx" as Lang, text: BROKEN }, { path: "skipped.tsx", lang: "tsx" as Lang, text: SKIPPED }]) {
      const t = await tree(f.lang, f.text);
      try {
        const all: string[] = [];
        const some: string[] = [];
        const every: TreeVisitor = { enter: (node, type, _field, depth, up, upType) => void all.push(seen(node, type, depth, up, upType)), leave: (depth) => void all.push(`leave ${depth}`) };
        const named: TreeVisitor = { types, keep, enter: (node, type, _field, depth, up, upType) => void some.push(seen(node, type, depth, up, upType)), leave: (depth) => void some.push(`leave ${depth}`) };
        // The core makes nodes of its own types; the reader must not see them as its own.
        walkTree(t.rootNode, [named], { interesting: new Set(["arrow_function", "statement_block"]), visit: () => undefined });
        walkTree(t.rootNode, [every]);
        // The untyped reader's log, cut to the nodes of `types` and the leaves of those nodes.
        const open: number[] = [];
        const expected = all.filter((line) => {
          const [what, type, depth] = line.split(" ");
          if (what === "enter" && types.has(type as string)) return open.push(Number(depth)) > 0;
          if (what === "leave" && open[open.length - 1] === Number(type)) return open.pop() !== undefined;
          return false;
        });
        expect(some, f.path).toEqual(expected);
        entered += some.length;
      } finally {
        t.delete();
      }
    }
    expect(entered).toBeGreaterThan(100);
  });

  it("keeps the other readers' facts when one reader throws, and shows the thrower no more nodes (3)", async () => {
    let thrown = false;
    let late = 0;
    const thrower: FrameworkPlugin = {
      ...(PLUGINS.find((p) => p.id === "react") as FrameworkPlugin),
      id: "thrower",
      reader: () => ({
        visitor: {
          enter(_node: Node, type: string) {
            if (thrown) late++;
            if (type === "call_expression") {
              thrown = true;
              throw new Error("the reader broke");
            }
          },
          leave() {
            if (thrown) late++;
          },
        },
        finish: () => [],
      }),
    };
    const t = await tree("tsx", BROKEN);
    try {
      const facts = frameworkFacts(t.rootNode, "tsx", BROKEN, [thrower, ...PLUGINS]) ?? {};
      expect(thrown).toBe(true);
      expect(late).toBe(0);
      expect(facts.thrower).toEqual([{ kind: "error", line: 1, column: 0, note: "the reader broke" } as FrameworkFactBase]);
      for (const p of PLUGINS) {
        if (!p.languages.includes("tsx") || !p.reader) continue;
        expect(facts[p.id] ?? [], p.id).toEqual(p.facts(t.rootNode, "tsx"));
      }
    } finally {
      t.delete();
    }
  });
});
