// The time budget of a question, its resumption, and the floors of a walk.
// Ways it could fail, written before the code:
//  1. The budget is not seen while a name is looked up, while a hub's edges
//     are expanded, while the points past the depth are checked, while a
//     list is aggregated (packages, cycles) or sorted, so a question runs
//     on past its budget.
//  2. Work the budget stopped is presented as whole: no floor, no frontier.
//  3. A cursor redoes the walk: the next page computes the list again, and
//     a walk the budget stopped starts again from nothing instead of from
//     where it stopped.
//  4. A resumed walk gives a different answer from one that ran whole.
//  5. What a walk two hops out calls is a floor only for gaps at its first
//     point: an unbound call at the second hop is not said.
//  6. The work tree changed in a file the graph reads besides source (a
//     package.json exports map, a tsconfig paths alias), and the answer
//     says no edit is known.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildGraph, laterEdits, pinWorkTree } from "../src/index.js";
import { query } from "../src/query/engine.js";
import type { Answer, Item, Request, Session } from "../src/query/engine.js";
import { checksBudget } from "../src/query/traverse.js";
import { commitAll, makeRepo } from "./helpers.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// A hub with 300 callers, each called by two more, and a project of two packages.
function hubRepo(): Record<string, string> {
  const files: Record<string, string> = { "src/hub.ts": "export function hub(): number {\n  return 1;\n}\n" };
  for (let i = 0; i < 300; i++) {
    files[`src/c${i}.ts`] = `import { hub } from "./hub";\nexport function c${i}(): number {\n  return hub();\n}\nexport function d${i}(): number {\n  return c${i}() + c${i}();\n}\n`;
  }
  return files;
}

let s: Session;
beforeAll(async () => {
  const root = makeRepo(hubRepo());
  dirs.push(root);
  const graph = await buildGraph({ repoRoot: root, store: null });
  s = { graph, generation: "budget-build", treeSha: null, builtAt: null, laterEditsKnown: false };
}, 120_000);

const ask = (req: Omit<Request, "apiVersion">, checks?: number): Answer => query(s, { apiVersion: 1, ...req } as Request, checks === undefined ? {} : { budget: checksBudget(checks) });
const where = (i: Item) => `${i.site.file}:${i.site.line}:${i.from}`;

// How many budget checks a question makes when it runs whole.
function checksOf(req: Omit<Request, "apiVersion">): number {
  const b = checksBudget(Number.MAX_SAFE_INTEGER);
  query(s, { apiVersion: 1, ...req } as Request, { budget: b });
  return b.checks;
}

describe("the budget of a question", () => {
  it("is seen inside the name lookup, the hub's edges, the frontier check and the sort, and stops there (1, 2)", () => {
    const req = { kind: "callers" as const, target: { name: "hub" }, depth: 2, limit: 500 };
    const whole = checksOf(req);
    expect(whole).toBeGreaterThan(600);
    // Stopped while the name is looked up: no target yet, a floor and a resume.
    const early = ask(req, 1);
    expect(early.error).toBeNull();
    expect(early.truncated).toMatchObject({ by: "budget", omitted: null, omittedExact: false });
    expect(early.truncated.cursor).not.toBeNull();
    expect(early.unknown.floor).toBe(true);
    // Stopped in the middle of the hub's 300 callers: past the name lookup
    // (what a question about the symbol alone costs) and 150 edges on.
    const lookup = checksOf({ kind: "symbol", target: { name: "hub" } });
    expect(lookup).toBeLessThan(whole / 2);
    const mid = ask(req, lookup + 150);
    expect(mid.truncated.by).toBe("budget");
    expect(mid.items.length).toBeLessThan(900);
    expect(mid.truncated.frontierTotal ?? 0).toBeGreaterThan(0);
    expect(mid.unknown.floor).toBe(true);
    expect(mid.unknown.reasons.join(" ")).toMatch(/time budget/);
    // Every stop point up to the whole run is a stop, never a silent short answer.
    for (const n of [2, 10, Math.floor(whole / 2), whole - 2]) {
      const a = ask(req, n);
      expect(a.truncated.by, `stopped after ${n} checks`).toBe("budget");
      expect(a.unknown.floor, `stopped after ${n} checks`).toBe(true);
    }
  });

  it("stops the package aggregation and the cycle search at the budget, as a floor (1, 2)", () => {
    // All asked first with a small budget: a whole run keeps what it
    // gathered for the graph, and a later question no longer needs the work.
    const reqs = [{ kind: "packages" as const }, { kind: "cycles" as const }, { kind: "cycles" as const, level: "projects" as const }];
    for (const req of reqs) {
      const name = JSON.stringify(req);
      const a = ask(req, 50);
      expect(a.truncated.by, name).toBe("budget");
      expect(a.unknown.floor, name).toBe(true);
      expect(a.counts, name).toEqual({ certain: null, likely: null, possible: null });
    }
    for (const req of reqs) {
      const name = JSON.stringify(req);
      const done = ask(req);
      expect(done.truncated.by, name).toBeNull();
    }
  });

  it("resumes a stopped walk from where it stopped, and gives the whole walk's answer (3, 4)", () => {
    const req = { kind: "callers" as const, target: { name: "hub" }, depth: 2, limit: 500 };
    const whole = checksOf(req);
    // 900 items: the first page of 500 is cut by the limit, not the budget.
    const full = ask(req);
    expect(full.truncated.by).toBe("limit");
    const half = Math.ceil(whole / 2);
    const first = ask(req, half);
    expect(first.truncated.by).toBe("budget");
    // The rest of the walk fits in what is left; a walk from nothing would not.
    const rest = ask({ ...req, cursor: first.truncated.cursor as string }, whole - half + 20);
    expect(rest.truncated.by).toBe("limit");
    expect(rest.items.map((i) => where(i as Item))).toEqual(full.items.map((i) => where(i as Item)));
    expect(rest.counts).toEqual(full.counts);
    expect(ask(req, whole - half + 20).truncated.by).toBe("budget");
  });

  it("reads the next page from the list it saved, without walking again (3)", () => {
    const req = { kind: "callers" as const, target: { name: "hub" }, depth: 2, limit: 100 };
    const p1 = ask(req);
    expect(p1.truncated).toMatchObject({ by: "limit", omittedExact: true });
    // One budget check is not enough to walk again; the saved list needs none.
    const p2 = ask({ ...req, cursor: p1.truncated.cursor as string }, 1);
    expect(p2.truncated.by).toBe("limit");
    expect(p2.items).toHaveLength(100);
    expect(p2.items.map((i) => where(i as Item))).not.toEqual(p1.items.map((i) => where(i as Item)));
  });
});

describe("the floor of a walk", () => {
  it("says a floor when a call two hops out could not be bound, and not at one hop (5)", async () => {
    const root = makeRepo({
      "src/a.ts": 'import { b } from "./b";\nexport function a(): number {\n  return b();\n}\n',
      "src/b.ts": "const table: Record<string, () => number> = {};\nexport function b(): number {\n  return table.x ? 1 : table[String(Date.now())]();\n}\n",
    });
    dirs.push(root);
    const graph = await buildGraph({ repoRoot: root, store: null });
    const t: Session = { graph, generation: null, treeSha: null, builtAt: null, laterEditsKnown: false };
    const one = query(t, { apiVersion: 1, kind: "callees", target: { name: "a" }, depth: 1 });
    expect(one.unknown.floor).toBe(false);
    const two = query(t, { apiVersion: 1, kind: "callees", target: { name: "a" }, depth: 2 });
    expect(two.unknown.floor).toBe(true);
    expect(two.unknown.causes.dynamic).toBe(1);
    expect(two.unknown.reasons.join(" ")).toMatch(/could not be bound/);
  });
});

describe("edits since the held build", () => {
  const settings = { budgetMs: 10_000, maxFiles: 4000, maxFileBytes: 512 * 1024, maxHeapMb: 1536 };
  const files = {
    "package.json": '{ "name": "root", "private": true }\n',
    "tsconfig.json": '{ "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["src/lib/*"] } } }\n',
    "src/lib/x.ts": "export function x(): number {\n  return 1;\n}\n",
    "src/use.ts": 'import { x } from "@lib/x";\nexport function use(): number {\n  return x();\n}\n',
    "README.md": "# readme\n",
  };

  it("are known for a changed tsconfig alias and a changed manifest, and not for a file the graph never reads (6)", async () => {
    const root = makeRepo(files);
    dirs.push(root);
    commitAll(root);
    const pinned = await pinWorkTree({ repoRoot: root, store: null, settings, purpose: "cli" });
    try {
      expect(pinned.reference).not.toBeNull();
      const ref = pinned.reference as NonNullable<typeof pinned.reference>;
      expect(await laterEdits(root, ref, settings.maxFileBytes)).toBe(false);
      writeFileSync(join(root, "README.md"), "# readme, edited\n");
      expect(await laterEdits(root, ref, settings.maxFileBytes)).toBe(false);
      writeFileSync(join(root, "tsconfig.json"), '{ "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["src/other/*"] } } }\n');
      expect(await laterEdits(root, ref, settings.maxFileBytes)).toBe(true);
      writeFileSync(join(root, "tsconfig.json"), files["tsconfig.json"]);
      expect(await laterEdits(root, ref, settings.maxFileBytes)).toBe(false);
      writeFileSync(join(root, "package.json"), '{ "name": "root", "private": true, "exports": { ".": "./src/use.ts" } }\n');
      expect(await laterEdits(root, ref, settings.maxFileBytes)).toBe(true);
    } finally {
      pinned.release();
    }
  });
});
