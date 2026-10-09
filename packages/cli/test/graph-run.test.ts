// The review's graph run. Way it could fail, written before the fix:
// 1. The lease that holds the build the review read cannot be taken (the
//    graph folder's lock stays busy, or the lease file cannot be written),
//    and the error ends the whole review instead of the review going on
//    without the lease.
// 2. A secret the scanners found that sits in a symbol id (a file named
//    after a key) is kept in the summary impact.json is written from, or
//    in a file of the review's packet, because a field named `id` is
//    exempt from the redaction.
// 3. A secret the scanners found that sits in a route path, which the
//    framework plugins keep because it is not shaped like a key, reaches
//    the brief's framework lines or the packet's frameworks.json, because
//    those lines are built outside the summary and packet redaction.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG, getChange } from "@openqodex/core";
import { renderImpactBlock, writePacket } from "@openqodex/graph";
import { buildGraphRun } from "../src/pipeline.js";

const dirs: string[] = [];
const savedHome = process.env.OPENQODEX_HOME;
beforeAll(() => {
  const home = mkdtempSync(join(tmpdir(), "oq-graph-run-home-"));
  dirs.push(home);
  process.env.OPENQODEX_HOME = home;
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.OPENQODEX_HOME;
  else process.env.OPENQODEX_HOME = savedHome;
  for (const d of dirs) {
    try {
      chmodSync(join(d, ".openqodex", "graph", "leases"), 0o700);
    } catch {
      // not a repo, or already open
    }
    rmSync(d, { recursive: true, force: true });
  }
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "oq-graph-run-"));
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  return root;
}

describe("the review's graph run", () => {
  it("goes on without a lease when the lease cannot be taken (1)", async () => {
    const root = repo({ "a.ts": "export function a() {\n  return 1;\n}\n", "b.ts": 'import { a } from "./a";\nexport function b() {\n  return a();\n}\n' });
    writeFileSync(join(root, "a.ts"), "export function a() {\n  return 2;\n}\n");
    const change = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
    const config = structuredClone(DEFAULT_CONFIG);
    const p = { repoRoot: root, workDir: root, config, change, scan: null, secrets: [] };
    // A first run makes the graph folder; then no lease file can be written in it.
    const first = await buildGraphRun(p, { quiet: true } as never, false);
    first.lease?.release();
    expect(first.impact.status).not.toBe("failed");
    chmodSync(join(root, ".openqodex", "graph", "leases"), 0o500);
    writeFileSync(join(root, "a.ts"), "export function a() {\n  return 3;\n}\n");
    const second = await buildGraphRun({ ...p, change: await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] }) }, { quiet: true } as never, false);
    expect(second.lease).toBeNull();
    expect(second.graph).not.toBeNull();
    expect(second.impact.callers.length).toBeGreaterThan(0);
  });

  it("keeps a secret in a symbol id out of the graph summary and every packet file (2)", async () => {
    const secret = ["sk", "live", "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2"].join("_");
    const keyFile = `keys/${secret}.ts`;
    const root = repo({ [keyFile]: "export function load() {\n  return 1;\n}\n", "use.ts": `import { load } from "./keys/${secret}";\nexport function run() {\n  return load();\n}\n` });
    writeFileSync(join(root, keyFile), "export function load() {\n  return 2;\n}\n");
    const change = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
    const p = { repoRoot: root, workDir: root, config: structuredClone(DEFAULT_CONFIG), change, scan: null, secrets: [secret] };
    const run = await buildGraphRun(p, { quiet: true } as never, false, false);
    expect(run.graph).not.toBeNull();
    expect(run.impact.touched.length).toBeGreaterThan(0);
    expect(JSON.stringify(run.impact)).not.toContain(secret);
    const snapshot = mkdtempSync(join(tmpdir(), "oq-graph-run-snapshot-"));
    dirs.push(snapshot);
    const packet = await writePacket({ root: snapshot, repoRoot: root, graph: run.graph as never, impact: run.impact, baseSha: change.baseSha, secrets: [secret] });
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else files.push(path);
      }
    };
    walk(join(snapshot, packet.dir));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(readFileSync(f, "utf8"), f).not.toContain(secret);
  });

  it("keeps a secret in a route path out of the summary, the brief's framework lines and every packet file (3)", async () => {
    // Not shaped like a key, so the plugin's facts keep it as the route's path; only the scanners know it.
    const secret = ["hunter2", "open", "sesame"].join("-");
    const root = repo({
      "package.json": '{ "name": "api", "private": true, "type": "module", "dependencies": { "express": "^5.1.0" } }\n',
      "src/server.js": `import express from "express";\nimport { listItems } from "./items.js";\n\nconst app = express();\napp.get("/${secret}/items", listItems);\napp.listen(3000);\n`,
      "src/items.js": "export function listItems(_req, res) {\n  res.json([]);\n}\n",
    });
    writeFileSync(join(root, "src/items.js"), "export function listItems(_req, res) {\n  res.json([1]);\n}\n");
    const change = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
    const p = { repoRoot: root, workDir: root, config: structuredClone(DEFAULT_CONFIG), change, scan: null, secrets: [secret] };
    const run = await buildGraphRun(p, { quiet: true } as never, false, false);
    // The plugin kept the route: the graph holds the path, and the summary lists the route, redacted.
    expect(JSON.stringify(run.graph?.frameworks?.entities ?? [])).toContain(secret);
    expect(run.impact.frameworks?.routes.length).toBeGreaterThan(0);
    expect(JSON.stringify(run.impact)).not.toContain(secret);
    const block = renderImpactBlock(run.impact);
    expect(block).toContain("/[redacted]/items");
    expect(block).not.toContain(secret);
    const snapshot = mkdtempSync(join(tmpdir(), "oq-graph-run-snapshot-"));
    dirs.push(snapshot);
    const packet = await writePacket({ root: snapshot, repoRoot: root, graph: run.graph as never, impact: run.impact, baseSha: change.baseSha, secrets: [secret] });
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else files.push(path);
      }
    };
    walk(join(snapshot, packet.dir));
    expect(files.some((f) => f.endsWith("frameworks.json"))).toBe(true);
    for (const f of files) expect(readFileSync(f, "utf8"), f).not.toContain(secret);
  });
});
