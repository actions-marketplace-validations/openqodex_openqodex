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

const hubRepo = () => {
  const files: Record<string, string> = { "src/core.ts": "export function core(): number {\n  return 1;\n}\n" };
  for (let i = 0; i < 45; i++) files[`src/c${i}.ts`] = `import { core } from "./core.js";\nexport function c${i}() {\n  return core();\n}\n`;
  return files;
};

describe("the review packet", () => {
  it("lives inside the snapshot and the brief names only paths in it (1)", async () => {
    const r = await reviewed(hubRepo(), { "src/core.ts": "export function core(): number {\n  return 2;\n}\n" });
    const packet = await writePacket({ root: r.root, repoRoot: r.root, graph: r.graph, impact: r.impact, baseSha: r.change.baseSha, redact: (t) => t });
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
    await expect(writePacket({ root: r.root, repoRoot: r.root, graph: r.graph, impact: r.impact, baseSha: r.change.baseSha, redact: (t) => t })).rejects.toThrow(/\.openqodex-review/);
    expect(readdirSync(join(r.root, ".openqodex-review"))).toEqual(["mine.txt"]);
  });

  it("puts every caller of a hub on a page, past the 20 the brief shows (3)", async () => {
    const r = await reviewed(hubRepo(), { "src/core.ts": "export function core(): number {\n  return 2;\n}\n" });
    expect(r.impact.hubs).toHaveLength(1);
    await writePacket({ root: r.root, repoRoot: r.root, graph: r.graph, impact: r.impact, baseSha: r.change.baseSha, redact: (t) => t });
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
    await writePacket({ root: r.root, repoRoot: r.root, graph: r.graph, impact: r.impact, baseSha: r.change.baseSha, redact: (t) => t.replaceAll(secret, "[REDACTED]") });
    const bases = readdirSync(join(r.root, PACKET_DIR, "base"));
    expect(bases).toHaveLength(1);
    const text = readFileSync(join(r.root, PACKET_DIR, "base", bases[0] as string), "utf8");
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain(secret);
  });

  it("lists in index.md exactly the files it wrote (5)", async () => {
    const r = await reviewed(hubRepo(), { "src/core.ts": "export function core(): number {\n  return 2;\n}\n" });
    const packet = await writePacket({ root: r.root, repoRoot: r.root, graph: r.graph, impact: r.impact, baseSha: r.change.baseSha, redact: (t) => t });
    const dir = join(r.root, PACKET_DIR);
    const listed = [...readFileSync(join(dir, "index.md"), "utf8").matchAll(/^- `([^`]+)`/gm)].map((m) => m[1]).sort();
    const written = packet.files.filter((f) => f !== "index.md").sort();
    expect(listed).toEqual(written);
    for (const f of written) expect(existsSync(join(dir, f as string)), f).toBe(true);
  });
});
