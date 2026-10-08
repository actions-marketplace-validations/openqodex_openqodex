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
//  5. A link inside ~/.openqodex/receipts, runs, last-review or runtime, the
//     final file included (receipts/<repo>/latest.json -> ../../config.yaml),
//     turns a receipt or a runtime write into a write of another file in the
//     home, or a record read through it into a record OpenQodex never wrote.
//  4. A receipt, or a report written where --output or --report-dir
//     names, is created readable by other users, or in a folder made for it
//     that they can open; or a --report-dir folder an earlier run left that
//     they can open (0755, with 0644 files in it) stays open to them
//     (core/test/private-modes.test.ts covers the repo's own .openqodex files).
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { cli, sandbox } from "./init-helpers.js";
import { pruneRuntimes } from "../src/launcher.js";
import { pruneHomeReceipts, readHomeLastReview, writeHomeLastReview, writeHomeReceipt, writeHomeRun } from "../src/receipts.js";
import { writeActive } from "../src/launcher.js";
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
    await expect(unpackRelease(home, "0.0.9", readFileSync(archive), { agent: 1, config: 1 })).rejects.toThrow(/symbolic link|outside every folder openqodex writes to/);
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(outside, "0.0.9.tmp-" + process.pid))).toBe(false);
  });
});

describe("4. a receipt is readable by the developer only", () => {
  it("is created 0600 in folders made 0700, and an existing receipts folder other users could read is closed and named", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "oq-guard-")));
    const home = join(root, "oq home");
    mkdirSync(join(home, "receipts"), { recursive: true });
    chmodSync(join(home, "receipts"), 0o755);
    const receipt = { version: 1, change_id: "b".repeat(64), kind: "complete", report: "r", base: { sha: "b", ref: "main" } };
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      writeHomeReceipt(home, root, receipt as never);
      writeHomeReceipt(home, root, receipt as never);
    } finally {
      spy.mockRestore();
    }
    const mode = (p: string): number => statSync(p).mode & 0o777;
    const dir = readdirSync(join(home, "receipts"))[0]!;
    expect(mode(join(home, "receipts", dir))).toBe(0o700);
    expect(mode(join(home, "receipts", dir, `${"b".repeat(64)}.json`))).toBe(0o600);
    expect(mode(join(home, "receipts", dir, "latest.json"))).toBe(0o600);
    // The repo folder is new: no report for it. receipts/ itself is not
    // where a receipt lands, so it is left to the folder that is.
    expect(spy.mock.calls.map((c) => String(c[0])).join("")).not.toMatch(/could be read/);
  });
});

describe("4. a report written where the developer names is readable by them only", () => {
  it("--output makes a 0600 file and --report-dir a 0700 folder of 0600 files", () => {
    const s = sandbox({ "app.py": "print('hello')\n" });
    writeFileSync(join(s.repo, "app.py"), "print('changed')\n");
    const out = join(s.root, "out", "scan.json");
    mkdirSync(dirname(out));
    const r = cli(s, ["scan", "--no-install", "--offline", "--format", "json", "--output", out]);
    expect(r.status, r.stderr).not.toBe(2);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const dir = join(s.root, "reports", "run");
    const d = cli(s, ["scan", "--no-install", "--offline", "--report-dir", dir]);
    expect(d.status, d.stderr).not.toBe(2);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const f of readdirSync(dir)) expect(statSync(join(dir, f)).mode & 0o777, f).toBe(0o600);
  });

  it("a reused --report-dir folder other users could open (0755, an older 0644 file in it) is closed to 0700 and named once on stderr", () => {
    const s = sandbox({ "app.py": "print('hello')\n" });
    writeFileSync(join(s.repo, "app.py"), "print('changed')\n");
    for (const dir of [join(s.repo, ".openqodex", "reviews", "old"), join(s.root, "reports", "old")]) {
      mkdirSync(dir, { recursive: true });
      chmodSync(dir, 0o755);
      writeFileSync(join(dir, "older.md"), "an earlier run\n");
      chmodSync(join(dir, "older.md"), 0o644);
      const r = cli(s, ["scan", "--no-install", "--offline", "--report-dir", dir]);
      expect(r.status, r.stderr).not.toBe(2);
      expect(statSync(dir).mode & 0o777, dir).toBe(0o700);
      for (const f of readdirSync(dir).filter((f) => f !== "older.md")) expect(statSync(join(dir, f)).mode & 0o777, f).toBe(0o600);
      const named = r.stderr.split("\n").filter((l) => /could be read by other users \(mode 0755\); it is now 0700/.test(l));
      expect(named, r.stderr).toHaveLength(1);
    }
  });
});

describe("5. no link at all under receipts, runs, last-review and runtime", () => {
  function home(): { root: string; home: string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "oq-guard-")));
    const home = join(root, "oq home");
    mkdirSync(home);
    writeFileSync(join(home, "config.yaml"), "update: off\n");
    return { root, home };
  }
  const receipt = { version: 1, change_id: "c".repeat(64), kind: "complete", report: "r", base: { sha: "b", ref: "main" } };

  it("a receipt whose file is a link to the user config is refused, and the config is left as it is", () => {
    const { root, home: h } = home();
    writeHomeReceipt(h, root, receipt as never);
    const dir = join(h, "receipts", readdirSync(join(h, "receipts"))[0]!);
    rmSync(join(dir, "latest.json"));
    symlinkSync(join("..", "..", "config.yaml"), join(dir, "latest.json"));
    expect(() => writeHomeReceipt(h, root, receipt as never)).toThrow(/link/);
    expect(readFileSync(join(h, "config.yaml"), "utf8")).toBe("update: off\n");
  });

  it("a run record in a repo folder that is a link to another folder of the home is refused", () => {
    const { root, home: h } = home();
    mkdirSync(join(h, "runs"));
    mkdirSync(join(h, "elsewhere"));
    writeHomeRun(h, root, "20261008-000000-aaaaaaaaaaaa", { version: 1, change_id: "c".repeat(64), config_hash: "x", instructions_hash: null, manifest_sha256: "x", scan_sha256: "x", candidates_sha256: "x", run_sha256: "x", written_at: "now" });
    const repoDir = join(h, "runs", readdirSync(join(h, "runs"))[0]!);
    rmSync(repoDir, { recursive: true });
    symlinkSync(join(h, "elsewhere"), repoDir);
    expect(() => writeHomeRun(h, root, "20261008-000001-aaaaaaaaaaaa", { version: 1, change_id: "c".repeat(64), config_hash: "x", instructions_hash: null, manifest_sha256: "x", scan_sha256: "x", candidates_sha256: "x", run_sha256: "x", written_at: "now" })).toThrow(/link/);
    expect(readdirSync(join(h, "elsewhere"))).toEqual([]);
  });

  const lastRun = { dir: "/r/.openqodex/reviews/run", shown: ".openqodex/reviews/run", changeId: "c".repeat(64), reportSha256: "d".repeat(64) };

  it("a last-review record whose file is a link to the user config is refused, the config is left as it is, and it reads as no record", () => {
    const { root, home: h } = home();
    writeHomeLastReview(h, root, lastRun);
    const dir = join(h, "last-review", readdirSync(join(h, "last-review"))[0]!);
    rmSync(join(dir, "last-review.json"));
    symlinkSync(join("..", "..", "config.yaml"), join(dir, "last-review.json"));
    expect(() => writeHomeLastReview(h, root, lastRun)).toThrow(/link/);
    expect(readFileSync(join(h, "config.yaml"), "utf8")).toBe("update: off\n");
    expect(readHomeLastReview(h, root)).toBeNull();
  });

  it("a last-review repo folder that is a link to another folder of the home is refused, and a record there reads as none", () => {
    const { root, home: h } = home();
    writeHomeLastReview(h, root, lastRun);
    expect(readHomeLastReview(h, root)).not.toBeNull();
    const repoDir = join(h, "last-review", readdirSync(join(h, "last-review"))[0]!);
    const elsewhere = join(h, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "last-review.json"), readFileSync(join(repoDir, "last-review.json")));
    rmSync(repoDir, { recursive: true });
    symlinkSync(elsewhere, repoDir);
    expect(() => writeHomeLastReview(h, root, lastRun)).toThrow(/link/);
    expect(readHomeLastReview(h, root)).toBeNull();
    expect(readdirSync(elsewhere)).toEqual(["last-review.json"]);
  });

  it("runtime/current as a link to the user config is refused, and the config is left as it is", () => {
    const { home: h } = home();
    mkdirSync(join(h, "runtime"));
    symlinkSync(join("..", "config.yaml"), join(h, "runtime", "current"));
    expect(() => writeActive(h, { current: "9.9.9", previous: null })).toThrow(/link/);
    expect(readFileSync(join(h, "config.yaml"), "utf8")).toBe("update: off\n");
  });
});
