// Strict preinstall of every scanner into a clean install root, as a server
// image build does it, then the server's resolver reading that root with
// installs off. Downloads every pinned scanner from its release (about 1 GB)
// and runs each one on its check case through the real binary. Run by the
// end-to-end config (tests/e2e/adapters.test.ts).
//
// Ways it could fail, written before the code (each test names the one it
// guards):
// 1. Preinstall reports success while a scanner is not installed at its
//    pinned version, lacks its runtime, or does not report its check case's
//    finding; or a tool or a download cache lands outside the install root
//    named (in the OpenQodex home).
// 2. Preinstall reports success while a required scanner cannot be ready (a
//    tool that does not run, a custom scanner, a name that is no scanner),
//    or names it on more or less than one line; and after a tool is
//    removed, the server's resolver installs it again, opens a connection,
//    or reads it from elsewhere.
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseConfig } from "@openqodex/core";
import type { BuiltinScanner } from "@openqodex/core";
import { checkCase, createToolResolver, loadToolchain, preinstallScanners, runScanners } from "@openqodex/scanners";
import type { PreinstallResult } from "@openqodex/scanners";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";
import { withLoggingProxy } from "./subprocess-support.js";

const savedHome = process.env.OPENQODEX_HOME;
afterAll(() => {
  if (savedHome === undefined) delete process.env.OPENQODEX_HOME;
  else process.env.OPENQODEX_HOME = savedHome;
});
afterAll(removeTempDirs);

const offline = () => process.env.OPENQODEX_E2E_OFFLINE === "1";
const table = loadToolchain();

// Every entry under `dir`, with its kind, size and modification time.
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const path = join(e.parentPath, e.name);
    const s = lstatSync(path);
    out[relative(dir, path)] = s.isSymbolicLink() ? "link" : s.isDirectory() ? "dir" : `${s.size} ${s.mtimeMs}`;
  }
  return out;
}

// Calls to the global fetch, which the installer downloads with, counted
// and passed through.
async function countFetches<T>(fn: () => Promise<T>): Promise<{ result: T; fetches: number }> {
  let fetches = 0;
  const real = globalThis.fetch;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    fetches += 1;
    return real(...args);
  }) as typeof fetch;
  try {
    return { result: await fn(), fetches };
  } finally {
    globalThis.fetch = real;
  }
}

let root = "";
let home = "";

describe("strict preinstall into a clean install root", () => {
  it("installs every scanner at its pinned version into the root alone, and each reports its check case (failure 1)", async () => {
    if (offline()) return;
    // An empty OpenQodex home that nothing may touch: the install root is named.
    home = tempDir("oq-preinstall-home-");
    process.env.OPENQODEX_HOME = home;
    root = join(tempDir("oq-preinstall-"), "tools");
    const result: PreinstallResult = await preinstallScanners({ installRoot: root, require: "all" });
    process.stdout.write(`preinstall: ${result.tools.filter((t) => t.ok).length} ready; missing: ${result.missing.join("; ") || "none"}\n`);

    expect(result.ok).toBe(result.missing.length === 0);
    // Only a runtime this machine lacks may be missing; under CI none.
    for (const line of result.missing) expect(line).toMatch(/^(golangci|cargo-deny|brakeman|rubocop): needs (Go|Cargo \(Rust\)|Ruby [0-9.]+ or newer)$/);
    if (process.env.CI) expect(result.missing).toEqual([]);
    for (const tool of result.tools.filter((t) => t.ok && t.version !== "built in")) {
      const c = checkCase(tool.scanner as BuiltinScanner)!;
      expect(tool.version).toBe(table.tools[tool.scanner]!.version);
      expect(tool.detail, tool.scanner).toBe(c.rule === null ? "ran its check case" : `reported ${c.rule} on ${c.anchor}`);
    }
    // The root holds tools and nothing else: no download cache, no lock.
    expect(readdirSync(root).filter((name) => !(name in table.tools) && name !== "uv-python")).toEqual([]);
    expect(readdirSync(home)).toEqual([]);
    // Installs on demand never go into a root other than the home's tools folder.
    expect(() => createToolResolver({ allowInstall: true, installRoot: root })).toThrow(/preinstallScanners/);
  }, 1_800_000);

  it("fails with one line per scanner that cannot be ready, and the server's resolver never installs a removed tool (failure 2)", async () => {
    if (offline()) return;
    for (const tool of ["actionlint", "hadolint"]) expect(existsSync(join(root, tool)), `${tool} was not preinstalled`).toBe(true);
    // hadolint's binary replaced by a program that reports nothing; the
    // folder and its marker still say installed.
    const hadolint = join(root, "hadolint", table.tools.hadolint!.version, "bin", "hadolint");
    writeFileSync(hadolint, "#!/bin/sh\nexit 0\n");
    chmodSync(hadolint, 0o755);
    const { result, fetches } = await countFetches(() => preinstallScanners({ installRoot: root, require: ["hadolint", "custom:mine", "no-such-scanner" as BuiltinScanner] }));
    expect(result.ok).toBe(false);
    expect(result.missing).toHaveLength(3);
    expect(result.missing[0]).toMatch(/^hadolint: its check case did not report DL3007 on Dockerfile \(/);
    expect(result.missing[1]).toMatch(/^custom:mine: /);
    expect(result.missing[2]).toBe("no-such-scanner: not a built-in scanner");
    expect(fetches).toBe(0);

    // actionlint removed: the resolver with installs off says so, and a
    // server run of the scanners reports it, installing nothing.
    renameSync(join(root, "actionlint"), join(tempDir("oq-preinstall-removed-"), "actionlint"));
    const before = tree(root);
    const resolve = createToolResolver({ allowInstall: false, installRoot: root });
    const { result: proxied, hosts } = await withLoggingProxy(() => countFetches(() => resolve("actionlint")));
    expect(proxied.result).toEqual({ ok: false, status: "not_installed", reason: "not installed (installs are off)" });
    expect(proxied.fetches).toBe(0);
    expect(hosts).toEqual([]);
    const repo = tempDir("oq-preinstall-repo-");
    mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
    writeFileSync(join(repo, ".github", "workflows", "ci.yml"), "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n");
    const scan = await countFetches(() =>
      runScanners({
        repoDir: repo,
        changedPaths: [".github/workflows/ci.yml"],
        coverage: new Map([[".github/workflows/ci.yml", new Set([1, 2, 3, 4, 5, 6])]]),
        config: parseConfig("").config,
        resolveTool: createToolResolver({ allowInstall: false, installRoot: root }),
        only: ["actionlint"],
        scratchRoot: join(tempDir("oq-preinstall-scratch-"), "run"),
      }),
    );
    expect(scan.result.scan.scanners).toEqual([expect.objectContaining({ scanner: "actionlint", status: "not_installed", reason: "not installed (installs are off)" })]);
    expect(scan.fetches).toBe(0);
    expect(tree(root)).toEqual(before);
    expect(readdirSync(home)).toEqual([]);
  }, 300_000);
});
