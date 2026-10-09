// The context items a host gives a review (reviewChange's `context`): each
// checked whole before anything runs, left out when its folders hold no file
// of the change, and hashed into the run manifest. The change is a real one,
// read by the change source from a real git repository.
//
// Ways it could fail, written before the code:
//  1. An item over 32 KB, or items over 128 KB together, are cut and the
//     review runs on part of them, or the refusal does not say which item
//     and which limit.
//  2. A malformed item (an unknown kind, no text, no source, folders that
//     are not repository folders) is dropped without a word or reaches the
//     brief.
//  3. An item whose folders hold no file of the change reaches the brief, or
//     is left out without the result saying so; or an item about a changed
//     folder (a rename's old folder included), or one with no folders, is
//     left out.
//  4. The manifest does not change when an item changes, does not list
//     every item given, or lists them out of order.
//  5. A secret the scanners found reaches the manifest or the omission
//     report through an item's source or folders.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTreeChange } from "@openqodex/core";
import type { Change, ContextItem } from "@openqodex/core";
import { CONTEXT_ITEM_MAX_BYTES, CONTEXT_MAX_BYTES, checkContext, useContext } from "../src/context.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const SECRET = ["sk", "live", "Zx9cV8bN7mQ6wE5rT4yU3iO2"].join("_");

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@openqodex.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function write(dir: string, path: string, text: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

// A change to services/api/handler.ts and a rename of legacy/util.ts to
// services/api/util.ts; web/ and docs/ are not touched.
let change: Change;
beforeAll(async () => {
  const dir = tempDir("oq-context-");
  git(dir, "init", "-q", "-b", "main");
  write(dir, "services/api/handler.ts", "export const a = 1;\n");
  write(dir, "legacy/util.ts", "export const u = 1;\nexport const v = 2;\nexport const w = 3;\n");
  write(dir, "web/page.ts", "export const p = 1;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "Base");
  const base = git(dir, "rev-parse", "HEAD");
  write(dir, "services/api/handler.ts", "export const a = 2;\n");
  git(dir, "mv", "legacy/util.ts", "services/api/util.ts");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "Change");
  const head = git(dir, "rev-parse", "HEAD");
  change = await getTreeChange({ repoRoot: dir, baseRef: "main", baseSha: base, headSha: head, exclude: [] });
  expect(change.files.map((f) => [f.path, f.oldPath])).toEqual(
    expect.arrayContaining([
      ["services/api/handler.ts", null],
      ["services/api/util.ts", "legacy/util.ts"],
    ]),
  );
});

const item = (over: Partial<ContextItem> = {}): ContextItem => ({ kind: "lesson", text: "Keep SQL in db/.", source: "lessons ledger", ...over });

describe("1. the size limits refuse, never cut", () => {
  it("an item over 32 KB is refused, naming the item and the limit; one at the limit is kept whole", () => {
    const at = "x".repeat(CONTEXT_ITEM_MAX_BYTES - Buffer.byteLength("lessons ledger"));
    expect(checkContext([item({ text: at })])[0]!.text).toBe(at);
    expect(() => checkContext([item(), item({ kind: "comment", text: `${at}y` })])).toThrow(/context item 2 \(comment\) is 32769 bytes, over the 32 KB limit for one item; it is refused, never cut/);
  });

  it("counts bytes, not characters, against the limit", () => {
    const wide = "é".repeat(CONTEXT_ITEM_MAX_BYTES / 2);
    expect(() => checkContext([item({ text: wide })])).toThrow(/context item 1 \(lesson\) is \d+ bytes, over the 32 KB limit/);
  });

  it("items over 128 KB together are refused, never cut, although each is under its own limit", () => {
    const quarter = "x".repeat(CONTEXT_ITEM_MAX_BYTES - 100);
    const items = Array.from({ length: 4 }, () => item({ text: quarter }));
    expect(checkContext(items)).toHaveLength(4);
    expect(CONTEXT_MAX_BYTES).toBe(128 * 1024);
    expect(() => checkContext([...items, item({ text: quarter })])).toThrow(/the context items are \d+ bytes together, over the 128 KB limit; they are refused, never cut/);
  });
});

describe("2. a malformed item is refused with the reason", () => {
  it.each([
    ["a list", { kind: "lesson" }, /context must be a list of items/],
    ["a kind", [{ ...item(), kind: "rule" }], /context item 1: kind must be one of lesson, comment, summary, note, prior_finding/],
    ["text", [item({ text: "   \n" })], /context item 1 \(lesson\): text must hold at least one character that is not a space/],
    ["a source", [item({ source: " " })], /context item 1 \(lesson\): source must name where the item came from/],
    ["folders", [item({ scopes: [] })], /context item 1 \(lesson\): scopes must list at least one folder; leave scopes out for an item about the whole repository/],
    ["a folder inside the repository", [item({ scopes: ["../outside"] })], /context item 1 \(lesson\): scope 1 is not a folder path inside the repository/],
    ["an absolute folder", [item({ scopes: ["/etc"] })], /context item 1 \(lesson\): scope 1 is not a folder path inside the repository/],
  ])("without %s", (_what, given, error) => {
    expect(() => checkContext(given)).toThrow(error);
  });

  it("names no item's text or source in a refusal, which may hold a secret", () => {
    let message = "";
    try {
      checkContext([item({ text: `${SECRET} `.repeat(3000), source: `from ${SECRET}` })]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/over the 32 KB limit/);
    expect(message).not.toContain(SECRET);
  });
});

describe("3. an item whose folders hold no file of the change is left out and reported", () => {
  it("keeps items with no folders and items about a changed folder, a rename's old folder included, and reports the rest", () => {
    const items = checkContext([
      item({ text: "whole repository" }),
      item({ kind: "note", text: "about the api", scopes: ["services/api/"] }),
      item({ kind: "comment", text: "about legacy", scopes: ["./legacy"] }),
      item({ kind: "prior_finding", text: "about the web", source: "review 40", scopes: ["web", "docs"] }),
      item({ kind: "summary", text: "about services", scopes: ["services"] }),
      item({ kind: "note", text: "a prefix is not a folder", source: "notes", scopes: ["services/ap"] }),
    ]);
    const used = useContext(items, change, []);
    expect(used.shown.map((i) => i.text)).toEqual(["whole repository", "about the api", "about legacy", "about services"]);
    expect(used.omitted).toEqual([
      { index: 3, kind: "prior_finding", source: "review 40", reason: "its folders (web, docs) hold no file of this change" },
      { index: 5, kind: "note", source: "notes", reason: "its folders (services/ap) hold no file of this change" },
    ]);
  });
});

describe("4. every item given is hashed into the manifest", () => {
  it("lists each item in order with its kind, source, hash and whether the brief carries it", () => {
    const items = checkContext([item(), item({ kind: "comment", source: "pull request comment 3", text: "Why?", scopes: ["web"] })]);
    const used = useContext(items, change, []);
    expect(used.manifest.map((m) => [m.kind, m.source, m.omitted])).toEqual([
      ["lesson", "lessons ledger", null],
      ["comment", "pull request comment 3", "its folders (web) hold no file of this change"],
    ]);
    for (const m of used.manifest) expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes an item's hash when its text, kind, source or folders change, and only then", () => {
    const hash = (i: ContextItem) => useContext(checkContext([i]), change, []).manifest[0]!.sha256;
    const first = hash(item());
    expect(hash(item())).toBe(first);
    for (const other of [item({ text: "Keep SQL in db/ only." }), item({ kind: "note" }), item({ source: "lessons ledger 2" }), item({ scopes: ["services"] })]) {
      expect(hash(other)).not.toBe(first);
    }
  });
});

describe("5. a secret the scanners found never reaches the manifest or the report", () => {
  it("redacts an item's source and folders wherever they are named", () => {
    const items = checkContext([item({ source: `comment by ${SECRET}`, scopes: [`web/${SECRET}`] })]);
    const used = useContext(items, change, [SECRET]);
    expect(used.omitted).toHaveLength(1);
    expect(JSON.stringify(used.omitted)).not.toContain(SECRET);
    expect(JSON.stringify(used.manifest)).not.toContain(SECRET);
    expect(used.manifest[0]!.source).toBe("comment by [redacted]");
  });
});
