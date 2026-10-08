// What counts as a gap. Ways the unknown records could mislead, each on a
// real repo:
// 1. A method called on a value of a built-in type (`d: Date`, a string, an
//    array) counts as an in-repo gap, so every repository function named
//    `trim` or `reduce` gets a false floor.
// 2. A method called on a value whose type the repository defines but no
//    rule can see into stays a gap (never turned into an external call). A
//    TypeScript interface's member now binds as declared, and the call
//    keeps a gap for the values of its shape that declare nothing.
// 3. A method called on what a call returns is named in the brief as if the
//    call were a type ("the type Buffer.concat"), which misleads the reader.
import { afterAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { buildGraph, floorReasons } from "../src/index.js";
import { makeRepo } from "./helpers.js";

const repos: string[] = [];
afterAll(() => {
  for (const r of repos) rmSync(r, { recursive: true, force: true });
});

describe("unknown records", () => {
  it("counts calls on values of built-in types as external, never as gaps (1)", async () => {
    const root = makeRepo({
      "src/text.ts": "export function trim(x: number) {\n  return x;\n}\nexport function reduce() {\n  return 0;\n}\n",
      "src/use.ts": "export function use(d: Date, s: string, items: number[]) {\n  return d.toISOString() + s.trim() + items.reduce((a, b) => a + b, 0);\n}\n",
      "py/m.py": "def strip():\n    return 1\n\ndef use(s: str, xs: list):\n    return s.strip() + xs.count(1)\n",
    });
    repos.push(root);
    const g = await buildGraph({ repoRoot: root, store: null });
    const gaps = g.unknowns.map((u) => `${u.file}:${u.line} ${u.name}`);
    expect(gaps).toEqual([]);
    expect(g.status.externalSites).toBeGreaterThanOrEqual(5);
    const trim = g.defsByFile.get("src/text.ts")?.find((n) => n.name === "trim");
    expect(floorReasons(g, { id: trim!.id, name: "trim", file: "src/text.ts" }, new Set())).toEqual([]);
  });

  it("keeps a call on a repository interface a gap (2)", async () => {
    const root = makeRepo({
      "src/repo.ts": "export interface Repo {\n  find(): number;\n}\n",
      "src/use.ts": 'import type { Repo } from "./repo";\nexport function use(r: Repo) {\n  return r.find();\n}\n',
    });
    repos.push(root);
    const g = await buildGraph({ repoRoot: root, store: null });
    expect(g.unknowns.map((u) => `${u.file}:${u.line} ${u.name} ${u.cause}`)).toEqual(["src/use.ts:3 find unsupported-rule"]);
    expect(g.status.externalSites).toBe(0);
  });

  it("names a call's result as what the call returns, never as a type (3)", async () => {
    const root = makeRepo({
      "src/use.ts": "export function use(parts: Uint8Array[]) {\n  return Buffer.concat(parts).toString();\n}\n",
    });
    repos.push(root);
    const g = await buildGraph({ repoRoot: root, store: null });
    expect(g.unknowns.map((u) => `${u.name}: ${u.note}`)).toEqual(["toString: what Buffer.concat returns is not known to the graph"]);
  });
});
