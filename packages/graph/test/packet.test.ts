// The review packet: the graph files the reviewer opens inside its snapshot
// (issue #58). Ways it could fail, each checked on a real repo:
// 1. The brief points at a file outside the folder the reviewer may read
//    (impact.json beside the brief), so following it ends the review.
// 2. A repository that holds a `.openqodex-review` path of its own has it
//    overwritten or merged with the tool's files, instead of the review
//    failing.
// 3. A caller the brief's display leaves out (a hub's 21st caller, the
//    second hop's 21st) is on no page, so nobody can read it.
// 4. A secret in a removed symbol's base body reaches the packet.
// 5. The packet's index lists a file that was not written, or misses one.
// 6. A secret the scanners found on a changed line reaches a packet file:
//    through a name, a note or a path the graph carries, spelled with JSON
//    escapes (a quote or a backslash in it), or in a packet file's name.
// 7. A removed symbol with more callers than the hub cut keeps gets a page
//    rebuilt from the summary's cut list: short, and marked as complete.
// 8. A symbol the graph handed to the packet does not hold gets a page
//    that claims to be complete, with the brief's cut list or with zero.
// 9. A public name with more consumers than the summary keeps (200) loses
//    the rest from changes.json, which claims to hold every one.
import { afterAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  const sha = commitAll(root);
  writeFiles(root, after);
  const change = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
  const graph = await buildGraph({ repoRoot: root, store: null, files: change.changedPaths, base: { sha: change.baseSha, files: change.files } });
  return { root, sha, change, graph, impact: detectImpact(graph, change) };
}

// Every page of a paged packet file, from its first page on.
function readPages<T>(dir: string, first: string): T[] {
  const out: T[] = [];
  for (let at: string | null = first; at !== null; ) {
    const page = JSON.parse(readFileSync(join(dir, at), "utf8")) as T & { next: string | null };
    out.push(page);
    at = page.next;
  }
  return out;
}

type Page<I> = { total: number; totalExact: boolean; cut: { omitted: number | null; note: string } | null; pages: number; items: I[] };

// `core` called from 45 files, then removed by the change.
const removedHubRepo = () => {
  const files: Record<string, string> = { "src/core.ts": "export function core(): number {\n  return 1;\n}\nexport function keep(): number {\n  return 2;\n}\n" };
  for (let i = 0; i < 45; i++) files[`src/c${i}.ts`] = `import { core } from "./core.js";\nexport function c${i}() {\n  return core();\n}\n`;
  return files;
};
const coreRemoved = { "src/core.ts": "export function keep(): number {\n  return 2;\n}\n" };

const hubRepo = () => {
  const files: Record<string, string> = { "src/core.ts": "export function core(): number {\n  return 1;\n}\n" };
  for (let i = 0; i < 45; i++) files[`src/c${i}.ts`] = `import { core } from "./core.js";\nexport function c${i}() {\n  return core();\n}\n`;
  return files;
};

describe("the review packet", () => {
  it("lives inside the snapshot and the brief names only paths in it (1)", async () => {
    const r = await reviewed(hubRepo(), { "src/core.ts": "export function core(): number {\n  return 2;\n}\n" });
    const packet = await writePacket({ root: r.root, repoRoot: r.root, graph: r.graph, impact: r.impact, baseSha: r.change.baseSha, secrets: [] });
    expect(packet.dir).toBe(`${PACKET_DIR}/`);
    const block = renderImpactBlock({ ...r.impact, packet: packet.dir });
    expect(block).not.toContain("beside this brief");
    for (const m of block.matchAll(/`(\.openqodex-review\/[^`]+)`/g)) {
      const path = (m[1] as string).replace(/<key>.*$/, "");
      expect(existsSync(join(r.root, path)), path).toBe(true);
    }
  });

  it("refuses a repository path that collides with the packet folder (2)", async () => {
    const r = await reviewed({ "a.ts": "export function a() {\n  return 1;\n}\n" }, { "a.ts": "export function a() {\n  return 2;\n}\n" });
    mkdirSync(join(r.root, ".openqodex-review"));
    writeFileSync(join(r.root, ".openqodex-review", "mine.txt"), "the repository's own file\n");
    await expect(writePacket({ root: r.root, repoRoot: r.root, graph: r.graph, impact: r.impact, baseSha: r.change.baseSha, secrets: [] })).rejects.toThrow(/\.openqodex-review/);
    expect(readdirSync(join(r.root, ".openqodex-review"))).toEqual(["mine.txt"]);
  });

  it("puts every caller of a hub on a page, past the 20 the brief shows (3)", async () => {
    const r = await reviewed(hubRepo(), { "src/core.ts": "export function core(): number {\n  return 2;\n}\n" });
    expect(r.impact.hubs).toHaveLength(1);
    await writePacket({ root: r.root, repoRoot: r.root, graph: r.graph, impact: r.impact, baseSha: r.change.baseSha, secrets: [] });
    const seed = r.impact.touched[0] as string;
    const page = JSON.parse(readFileSync(join(r.root, PACKET_DIR, "callers", `${symbolKey(seed)}.json`), "utf8")) as { total: number; items: { site: { file: string } }[] };
    expect(page.total).toBe(45);
    expect(page.items).toHaveLength(45);
  });

  it("redacts a secret in the base body of a removed symbol (4)", async () => {
    const secret = `sk_live_${randomBytes(12).toString("hex")}`;
    const r = await reviewed(
      { "a.ts": `export function gone() {\n  return "${secret}";\n}\nexport function kept() {\n  return 1;\n}\n` },
      { "a.ts": "export function kept() {\n  return 1;\n}\n" },
    );
    await writePacket({ root: r.root, repoRoot: r.root, graph: r.graph, impact: r.impact, baseSha: r.change.baseSha, secrets: [secret] });
    const bases = readdirSync(join(r.root, PACKET_DIR, "base"));
    expect(bases).toHaveLength(1);
    const text = readFileSync(join(r.root, PACKET_DIR, "base", bases[0] as string), "utf8");
    expect(text).toContain("[redacted]");
    expect(text).not.toContain(secret);
  });

  it("lists in index.md exactly the files it wrote (5)", async () => {
    const r = await reviewed(hubRepo(), { "src/core.ts": "export function core(): number {\n  return 2;\n}\n" });
    const packet = await writePacket({ root: r.root, repoRoot: r.root, graph: r.graph, impact: r.impact, baseSha: r.change.baseSha, secrets: [] });
    const dir = join(r.root, PACKET_DIR);
    const listed = [...readFileSync(join(dir, "index.md"), "utf8").matchAll(/^- `([^`]+)`/gm)].map((m) => m[1]).sort();
    const written = packet.files.filter((f) => f !== "index.md").sort();
    expect(listed).toEqual(written);
    for (const f of written) expect(existsSync(join(dir, f as string)), f).toBe(true);
  });

  it("carries no secret found on a changed line, in any file or file name (6)", async () => {
    const named = `sk_live_${randomBytes(9).toString("hex")}`;
    const escaped = "tok\\en_quoted_9876543";
    const r = await reviewed(
      { "a.ts": "export function plain() {\n  return 1;\n}\n" },
      {
        "a.ts": `import { x } from "${escaped}";\nexport function ${named}() {\n  return x();\n}\nexport function plain() {\n  return ${named}();\n}\n`,
      },
    );
    const secrets = [named, escaped];
    await writePacket({ root: r.root, repoRoot: r.root, graph: r.graph, impact: r.impact, baseSha: r.change.baseSha, secrets });
    const dir = join(r.root, PACKET_DIR);
    const all = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? all(join(d, e.name)) : [join(d, e.name)]));
    const files = all(dir);
    expect(files.length).toBeGreaterThan(3);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const secret of secrets) {
        for (const spelling of [secret, JSON.stringify(secret).slice(1, -1)]) {
          expect(f.includes(spelling), f).toBe(false);
          expect(text.includes(spelling), `${f} holds ${spelling}`).toBe(false);
        }
      }
    }
  });

  it("puts every caller of a removed hub on its pages, past the 20 the summary keeps (7)", async () => {
    const r = await reviewed(removedHubRepo(), coreRemoved);
    const seed = r.impact.removed[0] as string;
    expect(r.impact.hubs.map((h) => h.symbol)).toEqual([seed]);
    expect(r.impact.callers.filter((p) => p.seed === seed)).toHaveLength(20);
    const packet = await writePacket({ root: r.root, repoRoot: r.root, graph: r.graph, impact: r.impact, baseSha: r.change.baseSha, secrets: [] });
    const pages = readPages<Page<{ site: { file: string } }>>(join(r.root, PACKET_DIR), `callers/${symbolKey(seed)}.json`);
    expect(pages[0]).toMatchObject({ total: 45, totalExact: true, cut: null });
    const items = pages.flatMap((p) => p.items);
    expect(items).toHaveLength(45);
    expect(new Set(items.map((i) => i.site.file)).size).toBe(45);
    expect(renderImpactBlock({ ...r.impact, packet: packet.dir })).toContain("`core` (function), still called from 45 sites");
  });

  it("says a page is short, and by how many, for a removed symbol the graph it is given does not hold (8)", async () => {
    const r = await reviewed(removedHubRepo(), coreRemoved);
    const seed = r.impact.removed[0] as string;
    // The same tree built with no base: it holds no removed symbol.
    const plain = await buildGraph({ repoRoot: r.root, store: null });
    expect(plain.removed.size).toBe(0);
    await writePacket({ root: r.root, repoRoot: r.root, graph: plain, impact: r.impact, baseSha: r.change.baseSha, secrets: [] });
    const pages = readPages<Page<unknown>>(join(r.root, PACKET_DIR), `callers/${symbolKey(seed)}.json`);
    expect(pages[0]).toMatchObject({ total: 20, totalExact: false, cut: { omitted: 25 } });
    expect(pages.flatMap((p) => p.items)).toHaveLength(20);
  });

  it("keeps every consumer of a public name in changes.json, past the 200 the summary keeps (9)", async () => {
    const before: Record<string, string> = { "lib.ts": "function target() {\n  return 1;\n}\nexport { target as publicApi };\n" };
    for (let i = 0; i < 260; i++) before[`use/u${i}.ts`] = `import { publicApi } from "../lib";\nexport function u${i}() {\n  return publicApi();\n}\n`;
    const r = await reviewed(before, { "lib.ts": "function target() {\n  return 1;\n}\nexport { target };\n" });
    const e = r.impact.exports.find((x) => x.name === "publicApi");
    expect(e?.consumersTotal).toBeGreaterThanOrEqual(260);
    expect(e?.consumers).toHaveLength(200);
    const total = e?.consumersTotal as number;
    const packet = await writePacket({ root: r.root, repoRoot: r.root, graph: r.graph, impact: r.impact, baseSha: r.change.baseSha, secrets: [] });
    const pages = readPages<Page<{ name: string; file: string; now: string }> & { exports: { name: string; consumersTotal: number }[] }>(join(r.root, PACKET_DIR), "changes.json");
    expect(pages).toHaveLength(2);
    expect(pages[0]).toMatchObject({ total, totalExact: true, cut: null });
    expect(pages[0]?.exports.map((x) => [x.name, x.consumersTotal])).toEqual([["publicApi", total]]);
    const items = pages.flatMap((p) => p.items).filter((i) => i.name === "publicApi");
    expect(items).toHaveLength(total);
    expect(new Set(items.map((i) => i.file)).size).toBe(260);
    expect(items.every((i) => i.now === "broken")).toBe(true);
    // The brief shows 8 and says how many more, and where they are.
    expect(renderImpactBlock({ ...r.impact, packet: packet.dir })).toContain(`- and ${total - 8} more, in \`${PACKET_DIR}/changes.json\``);
    // With no packet, impact.json beside the brief holds only the summary's 200.
    expect(renderImpactBlock(r.impact, { overflow: "impact.json beside this brief" })).toContain(`- and ${total - 8} more; impact.json beside this brief lists 192 of them`);
  });
});
