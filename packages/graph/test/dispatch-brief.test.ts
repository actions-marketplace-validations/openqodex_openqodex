// What the reviewer reads about calls through interfaces, base types and
// function values (phase 2). Ways it could mislead, each on a real repo:
// 1. A possible caller (a call through an interface that an implementation
//    may answer) is counted among the certain and likely callers: in the
//    summary's callers, in the risk line's caller count, or in the list of
//    call sites the reviewer is told are proved.
// 2. A touched implementation reached only through an interface reads as
//    having no caller at all, with no floor.
// 3. A widely implemented interface floods the brief: every possible site
//    is printed inline, or the ones left out are on no packet page.
// 4. The packet's caller pages carry no tier, so a reader of the packet
//    cannot tell a possible caller from a proved one, and the calls that fan
//    out past the cap are on no page with their omitted count.
import { afterAll, describe, expect, it } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getChange } from "@openqodex/core";
import { buildGraph, detectImpact, renderImpactBlock, symbolKey } from "../src/index.js";
import { PACKET_DIR, writePacket } from "../src/review/packet.js";
import { commitAll, makeRepo, writeFiles } from "./helpers.js";

const repos: string[] = [];
afterAll(() => {
  for (const r of repos) rmSync(r, { recursive: true, force: true });
});

async function reviewed(before: Record<string, string>, after: Record<string, string>) {
  const root = makeRepo(before);
  repos.push(root);
  commitAll(root);
  writeFiles(root, after);
  const change = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
  const graph = await buildGraph({ repoRoot: root, store: null, files: change.changedPaths, base: { sha: change.baseSha, files: change.files } });
  return { root, change, graph, impact: detectImpact(graph, change) };
}

const sql = (body: string) => `import type { Repo } from "./repo";\nexport class SqlRepo implements Repo {\n  find(id: string): string {\n    return ${body};\n  }\n}\n`;

// `users` calls find through the interface, `direct` on a SqlRepo it made.
const small = {
  "src/repo.ts": "export interface Repo {\n  find(id: string): string;\n}\n",
  "src/sql.ts": sql('"sql " + id'),
  "src/mem.ts": 'import type { Repo } from "./repo";\nexport class MemRepo implements Repo {\n  find(id: string): string {\n    return "mem " + id;\n  }\n}\n',
  "src/users.ts": 'import type { Repo } from "./repo";\nexport function users(repo: Repo): string {\n  return repo.find("u");\n}\n',
  "src/direct.ts": 'import { SqlRepo } from "./sql";\nexport function direct(): string {\n  const r = new SqlRepo();\n  return r.find("d");\n}\n',
};

describe("possible callers in the brief and the packet", () => {
  it("lists a call through an interface as a possible caller, apart from the proved ones and never counted with them (1, 2)", async () => {
    const r = await reviewed(small, { "src/sql.ts": sql("null as unknown as string") });
    const touched = r.impact.touched.find((id) => id.includes("#SqlRepo.find@")) as string;
    expect(touched).toBeDefined();
    const sureFrom = r.impact.callers.map((p) => p.edges[p.edges.length - 1]?.from);
    const possibleFrom = (r.impact.possible ?? []).map((p) => p.edges[p.edges.length - 1]?.from);
    expect(sureFrom.some((id) => id?.includes("#direct@"))).toBe(true);
    expect(sureFrom.some((id) => id?.includes("#users@"))).toBe(false);
    expect(possibleFrom.some((id) => id?.includes("#users@"))).toBe(true);
    const seed = r.impact.unknown.seeds.find((s) => s.seed === touched);
    expect(seed?.floor).toBe(true);
    expect(seed?.reasons.join(" ")).toContain("may reach it through an interface");
    const block = renderImpactBlock(r.impact);
    expect(block).toContain("1 caller in 1 file and 1 possible caller");
    const proved = block.split("Possible call sites")[0] as string;
    expect(proved).toContain("- src/direct.ts:4 in `direct` calls `find`");
    expect(proved).not.toContain("src/users.ts:3");
    expect(block).toMatch(/^- src\/users\.ts:3 in `users` may call `SqlRepo\.find` \(1 hop, possible: A call to Repo\.find may run this implementation, one of 2/m);
  });

  it("shows 20 possible sites of a widely implemented interface and puts every one on the packet page, with its tier (3, 4)", async () => {
    const files: Record<string, string> = { ...small };
    for (let i = 0; i < 26; i++) files[`src/use${i}.ts`] = `import type { Repo } from "./repo";\nexport function use${i}(repo: Repo): string {\n  return repo.find("${i}");\n}\n`;
    const r = await reviewed(files, { "src/sql.ts": sql("id") });
    const touched = r.impact.touched.find((id) => id.includes("#SqlRepo.find@")) as string;
    const block = renderImpactBlock(r.impact);
    const possibleRows = (block.split("Possible call sites")[1] ?? "").split("\n").filter((l) => / may call `SqlRepo\.find`/.test(l));
    expect(possibleRows).toHaveLength(20);
    expect(block).toContain("- and 7 more possible call sites");
    expect(r.impact.cuts.some((c) => c.by === "inline" && c.omitted === 7)).toBe(true);
    const packet = await writePacket({ root: r.root, repoRoot: r.root, graph: r.graph, impact: r.impact, baseSha: r.change.baseSha, secrets: [] });
    const dir = join(r.root, PACKET_DIR);
    expect(packet.files).toContain(`callers/${symbolKey(touched)}.json`);
    const page = JSON.parse(readFileSync(join(dir, `callers/${symbolKey(touched)}.json`), "utf8")) as { counts: Record<string, number>; items: { tier: string; kind: string; site: { file: string } }[] };
    expect(page.counts).toEqual({ certain: 1, likely: 0, possible: 27 });
    expect(page.items[0]?.tier).toBe("certain");
    expect(page.items.filter((i) => i.tier === "possible" && i.kind === "dispatches_to")).toHaveLength(27);
    const below = JSON.parse(readFileSync(join(dir, `implementers/${symbolKey(touched)}.json`), "utf8")) as { dispatch: { total: number; omitted: number; candidates: string[] }[] };
    expect(below.dispatch).toHaveLength(27);
    expect(below.dispatch.every((d) => d.total === 2 && d.omitted === 0 && d.candidates.length === 2)).toBe(true);
  });
});
