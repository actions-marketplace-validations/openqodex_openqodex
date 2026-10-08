// Every fact reader of the Express, React, Next.js, FastAPI and Go net/http
// plugins on code nested tens of thousands of levels deep. A reader that
// asks a node for its parent pays for a walk from the root each time
// (tree-sitter keeps no parent pointers), so it turns quadratic on such a
// file: the React reader once took forty seconds on 20,000 nested blocks.
// The readers keep their ancestors on stacks instead; this test holds them
// to that.
import { describe, expect, it } from "vitest";
import { parserFor } from "../../parser.js";
import type { Lang } from "../../types.js";
import { express } from "../express/index.js";
import { fastapi } from "../fastapi/index.js";
import { goHttp } from "../go-http/index.js";
import { nextjs } from "../nextjs/index.js";
import type { FrameworkFactBase, FrameworkPlugin } from "../plugin.js";
import { react } from "./index.js";

const N = 20_000;
const SOURCES: Record<"typescript" | "tsx" | "python" | "go", string> = {
  typescript: `export function f() {}\n${"{ f(); ".repeat(N)}${"}".repeat(N)}\n`,
  tsx: `export function App() {\n  return ${"<div>".repeat(N / 4)}x${"</div>".repeat(N / 4)};\n}\n${"(() => ".repeat(N / 4)}0${")".repeat(N / 4)};\n`,
  python: `def f(x):\n    return x\n\ny = ${"f(".repeat(N / 4)}0${")".repeat(N / 4)}\nz = ${"[".repeat(N / 4)}${"]".repeat(N / 4)}\n`,
  go: `package main\n\nfunc f() {}\n\nfunc g() {\n${"{ f(); ".repeat(N)}${"}".repeat(N)}\n}\n`,
};

const plugins = [express, react, nextjs, fastapi, goHttp] as FrameworkPlugin<FrameworkFactBase>[];

describe("the fact readers on deeply nested code", () => {
  for (const plugin of plugins) {
    for (const lang of Object.keys(SOURCES) as (keyof typeof SOURCES)[]) {
      if (!plugin.languages.includes(lang as Lang)) continue;
      it(`the ${plugin.id} reader reads ${lang} nested thousands of levels deep in under a second, so nesting cannot make it quadratic`, async () => {
        const parser = await parserFor(lang as Lang);
        const tree = parser.parse(SOURCES[lang]);
        if (!tree) throw new Error(`no tree for ${lang}`);
        try {
          const t0 = performance.now();
          plugin.facts(tree.rootNode, lang as Lang);
          expect(performance.now() - t0).toBeLessThan(1000);
        } finally {
          tree.delete();
        }
      });
    }
  }
});
