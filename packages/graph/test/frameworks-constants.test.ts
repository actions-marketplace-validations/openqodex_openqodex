// The constants a plugin's fact reader looks up while it keeps the strings
// of a file are found from one index per file. Way it could fail, written
// before the code: each concatenation's constant scans every fact of the
// file again, so a file under the size cap that repeats `P + "/" + S`
// thousands of times after thousands of other assignments costs the square
// of its facts before any cap applies. The check: a file twice as large
// takes about twice as long to read, never about four times.
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { readFacts as expressFacts } from "../src/frameworks/express/facts.js";
import { readFacts as fastapiFacts } from "../src/frameworks/fastapi/facts.js";
import { readFacts as goFacts } from "../src/frameworks/go-http/facts.js";
import { parserFor } from "../src/parser.js";
import type { Lang } from "../src/types.js";

// `n` other module-level assignments, the two constants, then n / 2
// concatenations of them, each file under the plugins' 256 KiB read cap.
const sources: Record<string, { lang: Lang; read: (root: never) => unknown; source: (n: number) => string; n: number }> = {
  express: {
    lang: "javascript",
    read: expressFacts as (root: never) => unknown,
    n: 3000,
    source: (n) => ['import express from "express";', "const app = express();", ...Array.from({ length: n }, (_, i) => `const a${i} = "1";`), 'const P = "/api";', 'const S = "/users";', ...Array.from({ length: n / 2 }, () => 'app.get(P + "/" + S + "/" + P, h);')].join("\n"),
  },
  fastapi: {
    lang: "python",
    read: fastapiFacts as (root: never) => unknown,
    n: 7000,
    source: (n) => ["from fastapi import FastAPI", "app = FastAPI()", ...Array.from({ length: n }, (_, i) => `a${i}=1`), 'P = "/api"', 'S = "/users"', ...Array.from({ length: n / 2 }, () => 'c.get(P+"/"+S)')].join("\n"),
  },
  go: {
    lang: "go",
    read: goFacts as (root: never) => unknown,
    n: 2600,
    source: (n) => ["package main", 'import "net/http"', ...Array.from({ length: n }, (_, i) => `const a${i} = "1"`), 'const P = "/api"', 'const S = "/users"', "func main() {", "\tmux := http.NewServeMux()", ...Array.from({ length: n / 2 }, () => '\tmux.HandleFunc(P+"/"+S+"/"+P+"/"+S+"/"+P+"/"+S, h)'), "}"].join("\n"),
  },
};

// The fastest of three reads, after one to warm up.
async function fastest(lang: Lang, source: string, read: (root: never) => unknown): Promise<number> {
  expect(source.length).toBeLessThan(256 * 1024);
  const tree = (await parserFor(lang)).parse(source);
  if (!tree) throw new Error("no tree");
  read(tree.rootNode as never);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    read(tree.rootNode as never);
    best = Math.min(best, performance.now() - t0);
  }
  tree.delete();
  return best;
}

describe("the constants a fact reader looks up", () => {
  for (const [plugin, s] of Object.entries(sources)) {
    it(`${plugin}: reads a file twice as large in about twice the time, never the square`, async () => {
      const small = await fastest(s.lang, s.source(s.n), s.read);
      const large = await fastest(s.lang, s.source(s.n * 2), s.read);
      expect(large / small, `${Math.round(small)} ms, then ${Math.round(large)} ms`).toBeLessThan(2.8);
    }, 120_000);
  }
});
