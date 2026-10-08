// Every file init changes goes through one checked primitive,
// src/agents/guarded-fs.ts: it decides by filesystem identity and writes
// through checked handles. A direct write, rename or delete anywhere else in
// src/agents or in commands/init.ts bypasses it.
//
// Ways it could fail, written before the code:
//  1. A writer in src/agents or commands/init.ts calls writeFileSync,
//     renameSync, rmSync, rmdirSync, unlinkSync, cpSync, writeSync or the old
//     writeAtomic directly, so a link on its path decides where it lands.
//  2. The cleanup init runs follows a link in ~/.openqodex for a delete:
//     runtime/ or receipts/ as a link to a folder outside, and an old entry
//     in there is deleted outside.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pruneRuntimes } from "../src/launcher.js";
import { pruneHomeReceipts } from "../src/receipts.js";

(globalThis as Record<string, unknown>).__OPENQODEX_VERSION__ = "0.0.0-test";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const PRIMITIVE = join(SRC, "agents", "guarded-fs.ts");
const DIRECT = /\b(writeFileSync|renameSync|rmSync|rmdirSync|unlinkSync|cpSync|writeSync|writeAtomic|appendFileSync|copyFileSync|symlinkSync|linkSync)\s*\(/;

function scanned(): string[] {
  const agents = readdirSync(join(SRC, "agents"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(SRC, "agents", f));
  return [...agents, join(SRC, "commands", "init.ts")].filter((f) => f !== PRIMITIVE);
}

describe("1. the checked primitive is the only writer", () => {
  it("no file in src/agents or commands/init.ts writes, renames or deletes outside guarded-fs.ts", () => {
    const found: string[] = [];
    for (const file of scanned()) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (!line.trim().startsWith("//") && DIRECT.test(line)) found.push(`${relative(SRC, file)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(found).toEqual([]);
  });
});

describe("2. cleanup never follows a link for a delete", () => {
  const longAgo = new Date(Date.now() - 90 * 24 * 3600_000);
  function box(): { home: string; outside: string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "oq-guard-")));
    const home = join(root, "oq home");
    const outside = join(root, "outside");
    mkdirSync(home);
    mkdirSync(outside);
    return { home, outside };
  }

  it("runtime/ as a link to a folder outside: a stale version in there is not deleted", () => {
    const { home, outside } = box();
    const stale = join(outside, "0.0.1");
    mkdirSync(stale);
    writeFileSync(join(stale, "package.json"), JSON.stringify({ name: "openqodex", version: "0.0.1" }));
    utimesSync(stale, longAgo, longAgo);
    symlinkSync(outside, join(home, "runtime"));
    pruneRuntimes(home);
    expect(readdirSync(outside)).toEqual(["0.0.1"]);
    expect(readdirSync(stale)).toEqual(["package.json"]);
  });

  it("receipts/ as a link to a folder outside: an old file in there is not deleted", () => {
    const { home, outside } = box();
    mkdirSync(join(outside, "repo"));
    writeFileSync(join(outside, "repo", "old.json"), "{}\n");
    utimesSync(join(outside, "repo", "old.json"), longAgo, longAgo);
    symlinkSync(outside, join(home, "receipts"));
    pruneHomeReceipts(home);
    expect(readdirSync(join(outside, "repo"))).toEqual(["old.json"]);
  });
});
