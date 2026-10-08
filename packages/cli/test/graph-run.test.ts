// The review's graph run. Way it could fail, written before the fix:
// 1. The lease that holds the build the review read cannot be taken (the
//    graph folder's lock stays busy, or the lease file cannot be written),
//    and the error ends the whole review instead of the review going on
//    without the lease.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG, getChange } from "@openqodex/core";
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
});
