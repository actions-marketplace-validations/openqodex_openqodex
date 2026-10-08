// Every file init changes, and every file the update worker, the home
// receipts and the repository's .openqodex files write, goes through one
// checked primitive, packages/core/src/guarded-fs.ts: it decides by
// filesystem identity and writes through checked handles. A direct write,
// rename or delete anywhere else in those files bypasses it.
//
// Ways it could fail, written before the code:
//  1. A writer in src/agents or commands/init.ts calls writeFileSync,
//     renameSync, rmSync, rmdirSync, unlinkSync, cpSync, writeSync or the old
//     writeAtomic directly, so a link on its path decides where it lands.
//  2. The cleanup init runs follows a link in ~/.openqodex for a delete:
//     runtime/ or receipts/ as a link to a folder outside, and an old entry
//     in there is deleted outside.
//  3. The update worker's unpacking, the home receipts or the repo's
//     .openqodex files (core's writeRepoFile) are written directly, so a
//     link put in place after a check decides where a release, a receipt or
//     a report lands.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pruneRuntimes } from "../src/launcher.js";
import { pruneHomeReceipts, writeHomeReceipt } from "../src/receipts.js";
import { unpackRelease } from "../src/update/worker.js";

(globalThis as Record<string, unknown>).__OPENQODEX_VERSION__ = "0.0.0-test";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const CORE = join(SRC, "..", "..", "core", "src");
const DIRECT = /\b(writeFileSync|renameSync|rmSync|rmdirSync|unlinkSync|cpSync|writeSync|writeAtomic|appendFileSync|copyFileSync|symlinkSync|linkSync)\s*\(/;

function scanned(): string[] {
  const inFolder = (dir: string): string[] =>
    readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => join(dir, f));
  return [
    ...inFolder(join(SRC, "agents")),
    join(SRC, "commands", "init.ts"),
    ...inFolder(join(SRC, "update")),
    join(SRC, "receipts.ts"),
    join(CORE, "repo-state.ts"),
  ];
}

describe("1 and 3. the checked primitive is the only writer", () => {
  it("no file in src/agents, commands/init.ts, src/update, receipts.ts or core's repo-state.ts writes, renames or deletes outside guarded-fs.ts", () => {
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

describe("3. the worker, the receipts and the repo files land only where they were checked", () => {
  function box(): { home: string; outside: string; root: string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "oq-guard-")));
    const home = join(root, "oq home");
    const outside = join(root, "outside");
    mkdirSync(home);
    mkdirSync(outside);
    return { root, home, outside };
  }

  it("receipts/ as a link to a folder outside: no receipt is written there", () => {
    const { home, outside, root } = box();
    symlinkSync(outside, join(home, "receipts"));
    const receipt = { version: 1, change_id: "a".repeat(64), kind: "complete", report: "r", base: { sha: "b", ref: "main" } };
    expect(() => writeHomeReceipt(home, root, receipt as never)).toThrow();
    expect(readdirSync(outside)).toEqual([]);
  });

  it("runtime/ as a link to a folder outside: the worker unpacks nothing there", async () => {
    const { home, outside, root } = box();
    symlinkSync(outside, join(home, "runtime"));
    // A real tarball of a folder that is not a release: the unpack must
    // fail at the guard before tar ever runs.
    mkdirSync(join(root, "pkg", "package"), { recursive: true });
    writeFileSync(join(root, "pkg", "package", "package.json"), "{}\n");
    const archive = join(root, "pkg.tgz");
    expect(spawnSync("tar", ["-czf", archive, "-C", join(root, "pkg"), "package"]).status).toBe(0);
    await expect(unpackRelease(home, "0.0.9", readFileSync(archive))).rejects.toThrow(/outside every folder openqodex writes to/);
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(outside, "0.0.9.tmp-" + process.pid))).toBe(false);
  });
});
