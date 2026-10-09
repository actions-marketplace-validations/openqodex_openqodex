// The five tools the brain gives a model reviewer, run on a real snapshot
// folder (a git repository with one change), a real diff and a real code
// graph. Nothing is a stand-in here: the tools are plain functions over the
// folder.
//
// Ways it could fail, written before the code:
//  1. read_file hands out lines numbered differently from the snapshot, or
//     records a range other than the lines it carried.
//  2. A path outside the snapshot (a `..` step, an absolute path, `~`) is
//     read, or is refused without being marked outside.
//  3. A link is followed: to a file outside, or to one inside.
//  4. The `.git` entry of the snapshot (it names the clone's folder) is read.
//  5. A reply passes the 32 KB bound, or a cut reply does not say which lines
//     it carried.
//  6. A single line longer than the bound is cut in the middle instead of
//     refused.
//  7. A secret the scanners found reaches a reply: through read_file,
//     search_code, list_files or read_diff_for_file (the diff comes from git,
//     unredacted).
//  8. search_code runs a program, or a pattern that backtracks without end
//     hangs the review instead of being stopped and refused.
//  9. search_code or list_files with a glob rooted outside the snapshot runs.
// 10. list_files lists `.git` or a link.
// 11. read_diff_for_file serves a file outside the change, or the diff of a
//     file in the change is missing.
// 12. find_callers answers from anything but the graph's query layer, or
//     pretends to answer when there is no graph.
// 13. A tool name the brain did not define is run or is logged as inside.
// 14. Bad arguments are run, or are logged as an attempt outside.
import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTreeChange } from "@openqodex/core";
import type { Change } from "@openqodex/core";
import { buildGraph } from "@openqodex/graph";
import { TOOL_DEFINITIONS, TOOL_REPLY_BYTES, runTool } from "../src/tools/index.js";
import type { ToolBox } from "../src/tools/index.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@openqodex.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

const SECRET = ["sk", "live", "51ExampleSyntheticNotAKey0000"].join("_");

let box: ToolBox;
let outside: string;
let change: Change;

beforeAll(async () => {
  const dir = tempDir("oq-tools-");
  outside = tempDir("oq-tools-outside-");
  writeFileSync(join(outside, "secret.txt"), "outside the snapshot\n");
  git(dir, "init", "-q", "-b", "main");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/math.ts"), "export function add(a: number, b: number): number {\n  return a + b;\n}\n");
  writeFileSync(join(dir, "src/use.ts"), 'import { add } from "./math";\n\nexport function total(xs: number[]): number {\n  return xs.reduce((s, x) => add(s, x), 0);\n}\n');
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "Base");
  const base = git(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "src/math.ts"), "export function add(a: number, b: number): number {\n  return a - b;\n}\n");
  writeFileSync(join(dir, "src/config.ts"), `export const key = "${SECRET}";\n`);
  // 3000 numbered lines of 20 characters: about 60 KB, so one reply cannot carry them all.
  writeFileSync(join(dir, "src/long.txt"), Array.from({ length: 3000 }, (_, i) => `line ${String(i + 1).padStart(14, "0")}`).join("\n") + "\n");
  writeFileSync(join(dir, "src/wide.txt"), `${"x".repeat(TOOL_REPLY_BYTES + 10)}\nshort\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "Change");
  const head = git(dir, "rev-parse", "HEAD");
  // Links are made after the commit: a snapshot written by openqodex never
  // holds one, so these test the tools' own refusal.
  symlinkSync(join(outside, "secret.txt"), join(dir, "src/out-link.txt"));
  symlinkSync(join(dir, "src/math.ts"), join(dir, "src/in-link.ts"));
  change = await getTreeChange({ repoRoot: dir, baseRef: base, baseSha: base, headSha: head, exclude: [] });
  const graph = await buildGraph({ repoRoot: dir, store: null, capture: null });
  box = { snapshotDir: dir, change, secrets: [SECRET], graph, graphNote: null };
});

describe("the tool definitions", () => {
  it("define exactly the five tools, each with a plain description and a closed schema", () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name)).toEqual(["read_file", "search_code", "list_files", "read_diff_for_file", "find_callers"]);
    for (const t of TOOL_DEFINITIONS) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.description).not.toMatch(/\u2014/);
      expect(t.parameters).toMatchObject({ type: "object", additionalProperties: false });
      for (const r of t.parameters.required) expect(Object.keys(t.parameters.properties)).toContain(r);
    }
  });
});

describe("read_file", () => {
  it("1. carries the lines numbered as the snapshot holds them and records that range", async () => {
    const r = await runTool(box, "read_file", { path: "src/use.ts", start: 3, lines: 2 });
    expect(r).toMatchObject({ ok: true, inside: true, path: "src/use.ts", range: [3, 4], reason: null });
    expect(r.text).toBe("src/use.ts lines 3 to 4 of 5\n3\texport function total(xs: number[]): number {\n4\t  return xs.reduce((s, x) => add(s, x), 0);");
  });

  it("2. refuses a path outside the snapshot and marks the attempt outside", async () => {
    for (const path of ["../x.ts", join(outside, "secret.txt"), "~/.ssh/id_rsa", "src/../../x"]) {
      const r = await runTool(box, "read_file", { path });
      expect(r, path).toMatchObject({ ok: false, inside: false, range: null });
      expect(r.reason, path).toMatch(/outside/);
      expect(r.text).not.toContain("outside the snapshot\n");
    }
  });

  it("3. never follows a link: one that leads outside is outside, one that stays inside is refused", async () => {
    const out = await runTool(box, "read_file", { path: "src/out-link.txt" });
    expect(out).toMatchObject({ ok: false, inside: false });
    expect(out.text).not.toContain("outside the snapshot\n");
    const inner = await runTool(box, "read_file", { path: "src/in-link.ts" });
    expect(inner).toMatchObject({ ok: false, inside: true, range: null });
    expect(inner.reason).toMatch(/link/);
    expect(inner.text).not.toContain("return");
  });

  it("4. never reads the .git entry", async () => {
    for (const path of [".git", ".git/config", ".git/HEAD"]) {
      const r = await runTool(box, "read_file", { path });
      expect(r, path).toMatchObject({ ok: false, inside: true });
      expect(r.reason, path).toMatch(/\.git/);
    }
  });

  it("5. cuts a reply over 32 KB at a whole line and records the lines it carried", async () => {
    const r = await runTool(box, "read_file", { path: "src/long.txt" });
    expect(Buffer.byteLength(r.text, "utf8")).toBeLessThanOrEqual(TOOL_REPLY_BYTES);
    expect(r.ok).toBe(true);
    const [first, last] = r.range!;
    expect(first).toBe(1);
    expect(last).toBeGreaterThan(1000);
    expect(last).toBeLessThan(3000);
    expect(r.reason).toBe(`cut at 32 KB: lines 1 to ${last} of 3000 sent; ask for line ${last + 1} onward`);
    expect(r.text.split("\n").at(-1)).toBe(`${last}\tline ${String(last).padStart(14, "0")}`);
    const next = await runTool(box, "read_file", { path: "src/long.txt", start: last + 1 });
    expect(next.range![0]).toBe(last + 1);
  });

  it("6. refuses a line longer than the bound instead of cutting it", async () => {
    const r = await runTool(box, "read_file", { path: "src/wide.txt" });
    expect(r).toMatchObject({ ok: false, inside: true, range: null });
    expect(r.reason).toMatch(/line 1 is longer than the 32 KB/);
    const second = await runTool(box, "read_file", { path: "src/wide.txt", start: 2 });
    expect(second).toMatchObject({ ok: true, range: [2, 2] });
  });

  it("7. never hands out a secret the scanners found", async () => {
    const r = await runTool(box, "read_file", { path: "src/config.ts" });
    expect(r.ok).toBe(true);
    expect(r.text).not.toContain(SECRET);
    expect(r.text).toContain("[redacted]");
  });
});

describe("search_code", () => {
  it("finds matching lines by path and line, from text files only", async () => {
    const r = await runTool(box, "search_code", { pattern: "add\\(", glob: "src/**" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("src/use.ts:4:");
    expect(r.text).not.toContain(".git");
  });

  it("7. never hands out a secret the scanners found", async () => {
    const r = await runTool(box, "search_code", { pattern: "sk_live" });
    expect(r.text).not.toContain(SECRET);
  });

  it("8. stops a pattern that backtracks without end and refuses it", async () => {
    const started = Date.now();
    const r = await runTool(box, "search_code", { pattern: "^(x+x+)+y$", glob: "src/wide.txt" });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(r).toMatchObject({ ok: false, inside: true });
    expect(r.reason).toMatch(/stopped/);
  });

  it("9. refuses a glob rooted outside the snapshot", async () => {
    for (const glob of ["/etc/*", "../**", "~/**"]) {
      const r = await runTool(box, "search_code", { pattern: "x", glob });
      expect(r, glob).toMatchObject({ ok: false, inside: false });
    }
  });

  it("refuses a pattern that is not a regular expression", async () => {
    const r = await runTool(box, "search_code", { pattern: "(" });
    expect(r).toMatchObject({ ok: false, inside: true });
    expect(r.reason).toMatch(/regular expression/);
  });
});

describe("list_files", () => {
  it("10. lists the snapshot's regular files only: no .git, no link", async () => {
    const r = await runTool(box, "list_files", {});
    expect(r.ok).toBe(true);
    const listed = r.text.split("\n").slice(1);
    expect(listed).toEqual(["src/config.ts", "src/long.txt", "src/math.ts", "src/use.ts", "src/wide.txt"]);
    const ts = await runTool(box, "list_files", { glob: "src/*.ts" });
    expect(ts.text.split("\n").slice(1)).toEqual(["src/config.ts", "src/math.ts", "src/use.ts"]);
  });

  it("9. refuses a glob rooted outside the snapshot", async () => {
    const r = await runTool(box, "list_files", { glob: "/**" });
    expect(r).toMatchObject({ ok: false, inside: false });
  });
});

describe("read_diff_for_file", () => {
  it("11. serves the diff of a changed file, redacted, and refuses any other file", async () => {
    const r = await runTool(box, "read_diff_for_file", { path: "src/math.ts" });
    expect(r).toMatchObject({ ok: true, inside: true, path: "src/math.ts" });
    expect(r.text).toContain("-  return a + b;");
    expect(r.text).toContain("+  return a - b;");
    const secret = await runTool(box, "read_diff_for_file", { path: "src/config.ts" });
    expect(secret.ok).toBe(true);
    expect(secret.text).not.toContain(SECRET);
    const other = await runTool(box, "read_diff_for_file", { path: "src/use.ts" });
    expect(other).toMatchObject({ ok: false, inside: true });
    expect(other.reason).toMatch(/not a changed file/);
    const out = await runTool(box, "read_diff_for_file", { path: "../x.ts" });
    expect(out).toMatchObject({ ok: false, inside: false });
  });
});

describe("find_callers", () => {
  it("12. answers from the code graph's query layer", async () => {
    const r = await runTool(box, "find_callers", { symbol: "add", file: "src/math.ts" });
    expect(r).toMatchObject({ ok: true, inside: true, path: "src/math.ts" });
    expect(r.text).toMatch(/src\/use\.ts:4/);
    expect(r.text).toMatch(/total/);
  });

  it("12. says so when the symbol is not in the graph, and when there is no graph", async () => {
    const missing = await runTool(box, "find_callers", { symbol: "nothing", file: "src/math.ts" });
    expect(missing).toMatchObject({ ok: false, inside: true });
    const none = await runTool({ ...box, graph: null, graphNote: "the code graph was skipped: no changed file is code" }, "find_callers", { symbol: "add", file: "src/math.ts" });
    expect(none).toMatchObject({ ok: false, inside: true });
    expect(none.reason).toMatch(/no code graph/);
  });
});

describe("calls the brain cannot run", () => {
  it("13. a tool name the brain did not define is refused and has no place", async () => {
    const r = await runTool(box, "run_shell", { command: "cat /etc/passwd" });
    expect(r).toMatchObject({ ok: false, inside: null, path: null, tool: "run_shell" });
    expect(r.reason).toMatch(/not a tool/);
  });

  it("14. bad arguments are refused without being taken for an attempt outside", async () => {
    for (const [name, args] of [
      ["read_file", { path: 7 }],
      ["read_file", {}],
      ["read_file", { path: "src/math.ts", start: 0 }],
      ["read_file", "not an object"],
      ["search_code", { glob: "src/**" }],
      ["find_callers", { symbol: "add" }],
    ] as const) {
      const r = await runTool(box, name, args);
      expect(r, JSON.stringify(args)).toMatchObject({ ok: false, inside: true, path: null });
      expect(r.reason, JSON.stringify(args)).toMatch(/^bad arguments/);
    }
  });

  it("reads a JSON text holding one object as that object", async () => {
    const r = await runTool(box, "read_file", JSON.stringify({ path: "src/math.ts", lines: 1 }));
    expect(r).toMatchObject({ ok: true, range: [1, 1] });
  });
});
