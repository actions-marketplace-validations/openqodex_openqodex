// One walk of a parse tree that serves the Express, React and Next.js fact
// readers at once (src/frameworks/shared/walk.ts). Ways it could fail,
// written before the code:
// 1. A reader sees other nodes, or the same nodes in another order, than
//    its own walk showed it, so its facts change.
// 2. A reader that skips a node's children hides them from the others.
// 3. A reader that throws loses the facts of the others, or keeps being
//    called and throws again on every node.
// 4. A reader is told it left a node at another point than its own walk
//    told it, so a scope or a frame it keeps closes at the wrong node.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Node } from "web-tree-sitter";
import { langOf } from "../src/capture/inventory.js";
import { frameworkFacts } from "../src/frameworks/facts.js";
import type { FrameworkFactBase, FrameworkPlugin } from "../src/frameworks/plugin.js";
import { PLUGINS } from "../src/frameworks/registry.js";
import { walkTree } from "../src/frameworks/shared/walk.js";
import type { TreeVisitor } from "../src/frameworks/shared/walk.js";
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

// Writes down what the walk tells it; skips the children of every node of `skip`.
function recorder(skip: ReadonlySet<string> = new Set()): { visitor: TreeVisitor; log: string[] } {
  const log: string[] = [];
  return {
    log,
    visitor: {
      enter(node, type, field, depth, up, upType) {
        log.push(`enter ${type} ${field() ?? "-"} ${depth} ${node.startIndex} ${node.type} ${up(1)?.type ?? "-"} ${upType(2) ?? "-"}`);
        return skip.has(type) ? false : undefined;
      },
      leave(depth) {
        log.push(`leave ${depth}`);
      },
      broken(line) {
        log.push(`broken ${line}`);
      },
    },
  };
}

async function tree(lang: Lang, text: string) {
  const t = (await parserFor(lang)).parse(text);
  if (!t) throw new Error("no tree");
  return t;
}

describe("one walk for every JavaScript fact reader", () => {
  it("tells each reader the same nodes, in the same order, as a walk of its own, and the same leaves (1, 4)", async () => {
    const files = [...sources(), { path: "broken.tsx", lang: "tsx" as Lang, text: BROKEN }];
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const t = await tree(f.lang, f.text);
      try {
        const kinds = [new Set<string>(), new Set(["statement_block"]), new Set(["arrow_function", "call_expression"])];
        const alone = kinds.map((skip) => {
          const r = recorder(skip);
          walkTree(t.rootNode, [r.visitor]);
          return r.log;
        });
        const together = kinds.map((skip) => recorder(skip));
        walkTree(t.rootNode, together.map((r) => r.visitor));
        for (const [i, r] of together.entries()) expect(r.log, `${f.path}, reader ${i}`).toEqual(alone[i]);
      } finally {
        t.delete();
      }
    }
  });

  it("never hides from one reader the children another reader skips (2)", async () => {
    const t = await tree("tsx", BROKEN);
    try {
      const all = recorder();
      const skipper = recorder(new Set(["function_declaration", "lexical_declaration"]));
      walkTree(t.rootNode, [skipper.visitor, all.visitor]);
      const alone = recorder();
      walkTree(t.rootNode, [alone.visitor]);
      expect(all.log).toEqual(alone.log);
      expect(skipper.log.filter((l) => l.startsWith("enter")).length).toBeLessThan(alone.log.filter((l) => l.startsWith("enter")).length);
      expect(alone.log.some((l) => l.startsWith("broken"))).toBe(true);
    } finally {
      t.delete();
    }
  });

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
