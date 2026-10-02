// The runner, end to end through the real adapters. The only scanner that
// actually runs here is the in-process sqllint, on real .sql files in a temp
// directory; every other builtin is stopped at tool resolution by a real
// resolver that reports it not installed. Custom scanners are given as the
// CustomAdapter values the custom module would hand over.
//
// Failure list, written before the tests:
//   1. sqllint does not run without a resolved tool, or the resolver is
//      asked for it.
//   2. A finding on a line the change did not touch survives.
//   3. Candidate ids are not c1, c2, ... in severity order, the token is not
//      "<source>:<ruleId>", or reviewSeverity is not the mapped scale.
//   4. The resolver is asked for a scanner whose files are not in the change.
//   5. A scanner the resolver reports not installed (or failed, or
//      installing) is missing from the summaries, has the wrong status or
//      no reason, or makes runScanners reject.
//   6. A resolver or a custom scanner that throws makes runScanners reject.
//   7. A scanner in config.disabledScanners runs, or is resolved, or has no
//      "disabled" row.
//   8. `only` and `skip` are ignored.
//   9. A finding in a fixture folder survives without include_fixtures, or
//      is dropped with it.
//  10. A rule matched by disabled_rules survives.
//  11. A matched secret appears in a candidate message, or the fingerprints
//      are missing.
//  12. A custom scanner marked skipped is run, or its row is lost.
//  13. A custom scanner's findings skip the pipeline (changed-line filter,
//      dedup, sort) or come before the builtins'.
//  14. onProgress does not get one line per scanner.
//  15. An absolute path a scanner prints, through a symlinked directory, is
//      not rebased onto the repo root (toRunDirRelative).
//  16. With OPENQODEX_OFFLINE=1, osv-scanner still starts (it would send
//      dependency names to osv.dev) instead of giving its plain reason.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { matchesGlob, REDACTED } from "@openqodex/core";
import type {
  BuiltinScanner,
  Config,
  DiffCoverage,
  ResolveTool,
  StaticFinding,
  ToolResolution,
} from "@openqodex/core";
import { OSV_OFFLINE_REASON } from "./adapters/osv-scanner.js";
import { runScanners, toRunDirRelative } from "./run.js";
import type { CustomAdapter } from "./run.js";

const SQL = [
  "create or replace function public.admin_get_users() returns setof users", // 1: admin, no revoke (high)
  "language sql security definer", // 2: definer without search_path (high)
  "as $$ select * from users $$;", // 3
  "comment on function admin_get_users() is 'list users';", // 4: unqualified comment (low)
  "",
].join("\n");

const roots: string[] = [];
afterAll(() => {
  for (const d of roots) fs.rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openqodex-run-"));
  roots.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

function config(over: Partial<Config> = {}): Config {
  return {
    blockOnSeverity: null,
    exclude: [],
    disabledRules: [],
    includeFixtures: false,
    disabledScanners: [],
    custom: [],
    ...over,
  };
}

function lines(...ns: number[]): Set<number> {
  return new Set(ns);
}

// A real resolver: nothing is installed on this imaginary machine. It
// records what it was asked for.
function notInstalled(asked: BuiltinScanner[] = []): ResolveTool {
  return async (scanner) => {
    asked.push(scanner);
    return { ok: false, status: "not_installed", reason: `${scanner} is not installed` };
  };
}

function finding(over: Partial<StaticFinding>): StaticFinding {
  return {
    source: "custom:demo",
    ruleId: "rule",
    filePath: "db/migrate.sql",
    lineStart: 1,
    lineEnd: 1,
    severity: "medium",
    message: "msg",
    reference: null,
    ...over,
  };
}

function custom(over: Partial<CustomAdapter> & Pick<CustomAdapter, "run">): CustomAdapter {
  return { source: "custom:demo", skipped: null, wants: () => true, ...over };
}

describe("runScanners", () => {
  it("runs sqllint in process and turns its findings into candidates (1, 2, 3)", async () => {
    const dir = repo({ "db/migrate.sql": SQL });
    const asked: BuiltinScanner[] = [];
    const coverage: DiffCoverage = new Map([["db/migrate.sql", lines(1, 2)]]);
    const { scan } = await runScanners({
      repoDir: dir,
      changedPaths: ["db/migrate.sql"],
      coverage,
      config: config(),
      resolveTool: notInstalled(asked),
    });
    expect(asked).not.toContain("sqllint");
    expect(scan.candidates.map((c) => [c.id, c.token, c.reviewSeverity, c.lineStart])).toEqual([
      ["c1", "sqllint:function-default-public-execute", "major", 1],
      ["c2", "sqllint:security-definer-no-search-path", "major", 2],
    ]);
    const row = scan.scanners.find((s) => s.scanner === "sqllint");
    expect(row).toMatchObject({ status: "ran", rawCount: 3, keptCount: 2, reason: null, version: null });
  });

  it("orders candidates by severity and keeps a low one on a changed line (3)", async () => {
    const dir = repo({ "db/migrate.sql": SQL });
    const { scan } = await runScanners({
      repoDir: dir,
      changedPaths: ["db/migrate.sql"],
      coverage: new Map([["db/migrate.sql", lines(1, 2, 3, 4)]]),
      config: config(),
      resolveTool: notInstalled(),
    });
    expect(scan.candidates.map((c) => [c.id, c.severity])).toEqual([
      ["c1", "high"],
      ["c2", "high"],
      ["c3", "low"],
    ]);
    expect(scan.candidates[2]).toMatchObject({ token: "sqllint:comment-on-function-unqualified", reviewSeverity: "nitpick" });
  });

  it("asks the resolver only for scanners that want the change, and records not installed (4, 5)", async () => {
    const dir = repo({ "scripts/deploy.sh": "rm -rf $DIR/\n" });
    const asked: BuiltinScanner[] = [];
    const { scan } = await runScanners({
      repoDir: dir,
      changedPaths: ["scripts/deploy.sh"],
      coverage: new Map([["scripts/deploy.sh", lines(1)]]),
      config: config(),
      resolveTool: notInstalled(asked),
    });
    // semgrep and gitleaks look at every change; shellcheck at .sh files.
    expect(asked.sort()).toEqual(["gitleaks", "semgrep", "shellcheck"]);
    expect(scan.scanners).toHaveLength(13);
    expect(scan.scanners.find((s) => s.scanner === "shellcheck")).toMatchObject({
      status: "not_installed",
      reason: "shellcheck is not installed",
    });
    expect(scan.scanners.find((s) => s.scanner === "ruff")).toMatchObject({ status: "no_matching_files", reason: null });
    expect(scan.candidates).toEqual([]);
  });

  it("maps every failed resolution to its status (5)", async () => {
    const dir = repo({ "a.sh": "echo $1\n" });
    const results: Record<string, ToolResolution> = {
      semgrep: { ok: false, status: "installing", reason: "first run only, will be included next run" },
      gitleaks: { ok: false, status: "failed", reason: "checksum mismatch" },
      shellcheck: { ok: false, status: "not_installed", reason: "xz missing" },
    };
    const { scan } = await runScanners({
      repoDir: dir,
      changedPaths: ["a.sh"],
      coverage: new Map([["a.sh", lines(1)]]),
      config: config(),
      resolveTool: async (s) => results[s] ?? { ok: false, status: "not_installed", reason: "?" },
    });
    const status = Object.fromEntries(scan.scanners.map((s) => [s.scanner, [s.status, s.reason]]));
    expect(status.semgrep).toEqual(["installing", "first run only, will be included next run"]);
    expect(status.gitleaks).toEqual(["failed", "checksum mismatch"]);
    expect(status.shellcheck).toEqual(["not_installed", "xz missing"]);
  });

  it("never rejects when a resolver or a custom scanner throws (6)", async () => {
    const dir = repo({ "a.sh": "echo hi\n" });
    const { scan } = await runScanners({
      repoDir: dir,
      changedPaths: ["a.sh"],
      coverage: new Map([["a.sh", lines(1)]]),
      config: config(),
      resolveTool: async () => {
        throw new Error("resolver\nexploded");
      },
      custom: [
        custom({
          run: async () => {
            throw new Error("custom exploded");
          },
        }),
      ],
    });
    expect(scan.scanners.find((s) => s.scanner === "shellcheck")).toMatchObject({
      status: "failed",
      reason: "resolver exploded",
    });
    expect(scan.scanners.find((s) => s.scanner === "custom:demo")).toMatchObject({
      status: "failed",
      reason: "custom exploded",
    });
  });

  it("records disabled scanners without resolving them (7)", async () => {
    const dir = repo({ "a.sh": "echo hi\n", "db/migrate.sql": SQL });
    const asked: BuiltinScanner[] = [];
    const { scan } = await runScanners({
      repoDir: dir,
      changedPaths: ["a.sh", "db/migrate.sql"],
      coverage: new Map([["db/migrate.sql", lines(1, 2, 3, 4)]]),
      config: config({ disabledScanners: ["shellcheck", "sqllint"] }),
      resolveTool: notInstalled(asked),
    });
    expect(asked).not.toContain("shellcheck");
    expect(scan.candidates).toEqual([]);
    for (const name of ["shellcheck", "sqllint"]) {
      expect(scan.scanners.find((s) => s.scanner === name)).toMatchObject({ status: "disabled" });
      expect(scan.scanners.find((s) => s.scanner === name)?.reason).toBeTruthy();
    }
  });

  it("honours only and skip (8)", async () => {
    const dir = repo({ "db/migrate.sql": SQL });
    const base = {
      repoDir: dir,
      changedPaths: ["db/migrate.sql"],
      coverage: new Map([["db/migrate.sql", lines(1, 2, 3, 4)]]),
      config: config(),
      resolveTool: notInstalled(),
    };
    const only = await runScanners({ ...base, only: ["sqllint"] });
    expect(only.scan.scanners.map((s) => s.scanner)).toEqual(["sqllint"]);
    const skip = await runScanners({ ...base, skip: ["sqllint"] });
    expect(skip.scan.scanners.map((s) => s.scanner)).not.toContain("sqllint");
    expect(skip.scan.candidates).toEqual([]);
  });

  it("drops fixture findings unless include_fixtures is set (9)", async () => {
    const dir = repo({ "test/fixtures/seed.sql": SQL });
    const base = {
      repoDir: dir,
      changedPaths: ["test/fixtures/seed.sql"],
      coverage: new Map([["test/fixtures/seed.sql", lines(1, 2, 3, 4)]]),
      resolveTool: notInstalled(),
    };
    const dropped = await runScanners({ ...base, config: config() });
    expect(dropped.scan.candidates).toEqual([]);
    expect(dropped.scan.fixturesDropped).toBe(3);
    const kept = await runScanners({ ...base, config: config({ includeFixtures: true }) });
    expect(kept.scan.candidates).toHaveLength(3);
    expect(kept.scan.fixturesDropped).toBe(0);
  });

  // matchesGlob belongs to the core change stream; until it lands the stub
  // throws, and this case waits for it.
  const globBuilt = (() => {
    try {
      matchesGlob("a", "a");
      return true;
    } catch {
      return false;
    }
  })();
  it.skipIf(!globBuilt)("drops rules matched by disabled_rules (10)", async () => {
    const dir = repo({ "db/migrate.sql": SQL });
    const { scan } = await runScanners({
      repoDir: dir,
      changedPaths: ["db/migrate.sql"],
      coverage: new Map([["db/migrate.sql", lines(1, 2, 3, 4)]]),
      config: config({ disabledRules: ["sqllint:security-definer-*", "sqllint:comment-on-function-unqualified"] }),
      resolveTool: notInstalled(),
    });
    expect(scan.candidates.map((c) => c.token)).toEqual(["sqllint:function-default-public-execute"]);
  });

  it("redacts matched secrets from every candidate and keeps only fingerprints (11)", async () => {
    // Built at run time so this file holds no secret-shaped literal.
    const secret = ["sk", "live", "Zq8Xk2Lm9Pq4Rs7Tv1Wx3Yz5"].join("_");
    const dir = repo({ "app/config.py": `KEY = "${secret}"\n` });
    const { scan, secrets } = await runScanners({
      repoDir: dir,
      changedPaths: ["app/config.py"],
      coverage: new Map([["app/config.py", lines(1)]]),
      config: config(),
      resolveTool: notInstalled(),
      custom: [
        custom({
          source: "custom:secrets",
          run: async () => ({
            findings: [
              finding({
                source: "custom:secrets",
                ruleId: "key",
                filePath: "app/config.py",
                severity: "high",
                message: `found ${secret} on line 1`,
              }),
            ],
            error: null,
            secrets: [secret],
            version: "1.0.0",
          }),
        }),
      ],
    });
    expect(secrets).toEqual([secret]);
    expect(JSON.stringify(scan)).not.toContain(secret);
    expect(scan.candidates[0]?.message).toBe(`found ${REDACTED} on line 1`);
    expect(scan.secretFingerprints).toEqual([{ length: secret.length, sha256: expect.any(String) }]);
    expect(scan.scanners.find((s) => s.scanner === "custom:secrets")).toMatchObject({ status: "ran", version: "1.0.0" });
  });

  it("records a skipped custom scanner and never runs it (12)", async () => {
    const dir = repo({ "a.txt": "x\n" });
    let ran = false;
    const skipped = {
      scanner: "custom:trivy" as const,
      status: "untrusted" as const,
      version: null,
      rawCount: 0,
      keptCount: 0,
      durationMs: 0,
      reason: "not approved; run openqodex trust",
    };
    const { scan } = await runScanners({
      repoDir: dir,
      changedPaths: ["a.txt"],
      coverage: new Map([["a.txt", lines(1)]]),
      config: config(),
      resolveTool: notInstalled(),
      custom: [
        custom({
          source: "custom:trivy",
          skipped,
          run: async () => {
            ran = true;
            return { findings: [], error: null, version: null };
          },
        }),
      ],
    });
    expect(ran).toBe(false);
    expect(scan.scanners.find((s) => s.scanner === "custom:trivy")).toEqual(skipped);
  });

  it("puts custom findings through the same pipeline, after the builtins (13)", async () => {
    const dir = repo({ "db/migrate.sql": SQL });
    const { scan } = await runScanners({
      repoDir: dir,
      changedPaths: ["db/migrate.sql"],
      coverage: new Map([["db/migrate.sql", lines(1, 2)]]),
      config: config(),
      resolveTool: notInstalled(),
      custom: [
        custom({
          run: async () => ({
            findings: [
              // Same severity as sqllint's: sorted after the builtins.
              finding({ ruleId: "function-default-public-execute", lineStart: 1, lineEnd: 1, severity: "high" }),
              // Two secret-class rules on one span: deduped to the first.
              finding({ ruleId: "generic-api-key", lineStart: 2, lineEnd: 2 }),
              finding({ ruleId: "hardcoded-token", lineStart: 2, lineEnd: 2 }),
              // Off the changed lines: dropped.
              finding({ ruleId: "off", lineStart: 9, lineEnd: 9, severity: "critical" }),
              // Kept, and sorted first as the only critical.
              finding({ ruleId: "top", lineStart: 2, lineEnd: 2, severity: "critical", filePath: path.join(dir, "db/migrate.sql") }),
            ],
            error: null,
            version: null,
          }),
        }),
      ],
    });
    expect(scan.candidates.map((c) => [c.id, c.token])).toEqual([
      ["c1", "custom:demo:top"],
      ["c2", "sqllint:function-default-public-execute"],
      ["c3", "sqllint:security-definer-no-search-path"],
      ["c4", "custom:demo:function-default-public-execute"],
      ["c5", "custom:demo:generic-api-key"],
    ]);
    expect(scan.candidates[0]?.filePath).toBe("db/migrate.sql");
    expect(scan.scanners.at(-1)?.scanner).toBe("custom:demo");
  });

  it("reports one progress line per scanner (14)", async () => {
    const dir = repo({ "db/migrate.sql": SQL });
    const progress: string[] = [];
    await runScanners({
      repoDir: dir,
      changedPaths: ["db/migrate.sql"],
      coverage: new Map([["db/migrate.sql", lines(1)]]),
      config: config(),
      resolveTool: notInstalled(),
      onProgress: (line) => progress.push(line),
    });
    expect(progress).toHaveLength(13);
    expect(progress.find((l) => l.startsWith("sqllint:"))).toMatch(/^sqllint: ran, 3 raw finding\(s\) in /);
    expect(progress.find((l) => l.startsWith("semgrep:"))).toBe("semgrep: not installed: semgrep is not installed");
  });
});

describe("osv-scanner offline", () => {
  it("skips itself with a plain reason and never starts the tool (16)", async () => {
    const dir = repo({ "package-lock.json": "{}\n" });
    const before = process.env.OPENQODEX_OFFLINE;
    process.env.OPENQODEX_OFFLINE = "1";
    try {
      const { scan } = await runScanners({
        repoDir: dir,
        changedPaths: ["package-lock.json"],
        coverage: new Map([["package-lock.json", lines(1)]]),
        config: config(),
        only: ["osv-scanner"],
        // A path that cannot start: reaching it would fail with a different reason.
        resolveTool: async () => ({ ok: true, tool: { path: path.join(dir, "no-such-tool"), version: "1.9.2", env: {} } }),
      });
      expect(scan.scanners).toEqual([
        expect.objectContaining({ scanner: "osv-scanner", reason: OSV_OFFLINE_REASON }),
      ]);
    } finally {
      if (before === undefined) delete process.env.OPENQODEX_OFFLINE;
      else process.env.OPENQODEX_OFFLINE = before;
    }
  });
});

// Copied from the source product's path round-trip tests.
describe("toRunDirRelative", () => {
  function ruffFinding(filePath: string): StaticFinding {
    return finding({ source: "ruff", ruleId: "S602", filePath, lineStart: 3, lineEnd: 3, severity: "high" });
  }

  it("rebases an absolute path onto the directory the linter ran in", () => {
    const out = toRunDirRelative([ruffFinding("/tmp/clone/app/main.py")], "/tmp/clone");
    expect(out[0].filePath).toBe("app/main.py");
  });

  it("leaves an already-relative path alone, apart from a ./ prefix", () => {
    expect(toRunDirRelative([ruffFinding("app/main.py")], "/tmp/clone")[0].filePath).toBe("app/main.py");
    expect(toRunDirRelative([ruffFinding("./app/main.py")], "/tmp/clone")[0].filePath).toBe("app/main.py");
  });

  it("leaves an absolute path outside the run directory alone", () => {
    // No honest way to guess where it belongs; the coverage filter drops it.
    const out = toRunDirRelative([ruffFinding("/etc/passwd")], "/tmp/clone");
    expect(out[0].filePath).toBe("/etc/passwd");
  });

  it("rebases a path printed through the resolved side of a symlinked run directory (15)", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "openqodex-rebase-"));
    roots.push(base);
    const real = path.join(base, "real");
    const link = path.join(base, "link");
    fs.mkdirSync(path.join(real, "app"), { recursive: true });
    fs.symlinkSync(real, link);
    const printed = path.join(fs.realpathSync(real), "app", "main.py");
    expect(toRunDirRelative([ruffFinding(printed)], link)[0].filePath).toBe("app/main.py");
  });
});
