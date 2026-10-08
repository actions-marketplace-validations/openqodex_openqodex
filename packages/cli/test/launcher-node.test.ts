// The node the launcher runs, through the real built CLI started by a real
// node binary laid out the way Homebrew installs it, in a temp folder.
//
// Ways it could fail, written before the code:
//  1. The launcher bakes Homebrew's versioned Cellar path of node, which the
//     next `brew upgrade` removes; then a hook started with no node on PATH
//     (a git client) cannot start, and the push goes through unchecked.
//  2. With the baked node gone, the launcher runs whatever node PATH names
//     without a word, so the developer never learns it.
//  3. A node outside Homebrew's Cellar, or one whose opt link leads to
//     another node, is baked as a path that was never there.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { stableNodePath } from "../src/launcher.js";
import { BIN, env, sandbox, type Sandbox } from "./init-helpers.js";

(globalThis as Record<string, unknown>).__OPENQODEX_VERSION__ = "0.0.0-test";
const version = (JSON.parse(readFileSync(join(BIN, "..", "..", "package.json"), "utf8")) as { version: string }).version;

// This machine's real node, put where Homebrew keeps a keg, with the opt
// link Homebrew keeps beside it. A hard link where the file system allows
// one, else a copy: the same binary either way. Its keg's lib folder goes
// beside it, where a Homebrew node finds its libnode.
function brew(root: string): { cellarNode: string; opt: string; upgrade: () => void } {
  const keg = (v: string): string => join(root, "brew", "Cellar", "node@22", v);
  mkdirSync(join(keg("22.1.0"), "bin"), { recursive: true });
  mkdirSync(join(root, "brew", "opt"), { recursive: true });
  const real = realpathSync(process.execPath);
  const cellarNode = join(keg("22.1.0"), "bin", "node");
  try {
    linkSync(real, cellarNode);
  } catch {
    copyFileSync(real, cellarNode);
    chmodSync(cellarNode, 0o755);
  }
  const lib = join(dirname(dirname(real)), "lib");
  if (existsSync(lib)) symlinkSync(lib, join(keg("22.1.0"), "lib"));
  const optLink = join(root, "brew", "opt", "node@22");
  symlinkSync(join("..", "Cellar", "node@22", "22.1.0"), optLink);
  return {
    cellarNode,
    opt: join(optLink, "bin", "node"),
    // What `brew upgrade node@22` does: a new keg, the old one gone, opt moved.
    upgrade: () => {
      renameSync(keg("22.1.0"), keg("22.2.0"));
      unlinkSync(optLink);
      symlinkSync(join("..", "Cellar", "node@22", "22.2.0"), optLink);
    },
  };
}

function initWith(node: string, s: Sandbox): void {
  const r = spawnSync(node, [BIN, "init", "--yes", "--hook", "none", "--no-repo", "--no-review", "--agent", "claude-code"], { cwd: s.repo, env: env(s), encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
}

function launch(s: Sandbox, path: string) {
  return spawnSync("sh", [join(s.oqHome, "bin/openqodex"), "--version"], { cwd: s.repo, env: { ...env(s), PATH: path }, encoding: "utf8" });
}

describe("the node the launcher runs", () => {
  it("bakes Homebrew's opt path for a node in the Cellar, and still runs after an upgrade with no node on PATH (failure 1)", () => {
    const s = sandbox();
    const b = brew(s.root);
    initWith(b.cellarNode, s);
    expect(readFileSync(join(s.oqHome, "bin/openqodex"), "utf8")).toContain(`node='${b.opt}'`);
    b.upgrade();
    const r = launch(s, "/usr/bin:/bin");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(version);
    expect(r.stderr).toBe("");
  }, 60_000);

  it("with the baked node gone, runs the node on PATH and says so in one line (failure 2)", () => {
    const s = sandbox();
    const b = brew(s.root);
    initWith(b.cellarNode, s);
    unlinkSync(join(s.root, "brew", "opt", "node@22"));
    const r = launch(s, env(s).PATH!);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(version);
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
    expect(r.stderr).toMatch(new RegExp(`the node this launcher was set up with \\(${b.opt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\) is gone; using .*node from PATH`));
  }, 60_000);

  it("keeps a node outside the Cellar, and one whose opt link leads elsewhere, as it is (failure 3)", () => {
    const s = sandbox();
    const b = brew(s.root);
    expect(stableNodePath("/usr/local/bin/node")).toBe("/usr/local/bin/node");
    expect(stableNodePath(b.cellarNode)).toBe(b.opt);
    b.upgrade();
    const old = b.cellarNode;
    expect(stableNodePath(old)).toBe(old);
  });
});
