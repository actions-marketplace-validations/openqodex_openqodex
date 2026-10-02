// The toolchain installs pinned scanners into the OpenQodex home folder.
// These tests download real releases from GitHub and run the real binaries.
// They import the built package (dist), because the install runs in a separate
// detached process that cannot load TypeScript; run `pnpm build` first.
//
// Ways the toolchain could fail, written before the code:
// 1. The first install of a real tool does not leave a working binary at
//    tools/<tool>/<version>/bin/<binary>.
// 2. A second resolve downloads or rewrites anything although the tool is there.
// 3. A download whose sha256 differs from the table is unpacked or installed,
//    or leaves a version folder behind that a later run takes as installed.
// 4. Two resolvers racing on the same tool install it twice or corrupt it.
// 5. With installs off, a missing tool is installed anyway or the reason is
//    not one plain line.
// 6. When the install outlives its budget, the caller blocks, or the install
//    dies with the calling process instead of finishing on its own.
// 7. An archive member such as ../escape is written outside the destination.
// 8. A home folder that cannot be written gives a stack trace or a crash
//    instead of one plain line naming the fix.
// 9. A missing developer runtime (Ruby 2.7 or newer, Go) is not named.
// 10. openqodexHome ignores OPENQODEX_HOME.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist", "index.js");
const worker = join(here, "install-worker.mjs");
const table = JSON.parse(readFileSync(join(here, "..", "toolchain.json"), "utf8"));
const actionlintVersion: string = table.tools.actionlint.version;

type Toolchain = typeof import("../src/toolchain/index.js");
let tc: Toolchain;

beforeAll(async () => {
  if (!existsSync(dist)) throw new Error("run pnpm build before these tests");
  tc = (await import(dist)) as Toolchain;
  tc.setInstallWorkerEntry(worker);
});

const savedHome = process.env.OPENQODEX_HOME;
afterEach(() => {
  if (savedHome === undefined) delete process.env.OPENQODEX_HOME;
  else process.env.OPENQODEX_HOME = savedHome;
});

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "oq-toolchain-"));
  process.env.OPENQODEX_HOME = home;
  return home;
}

function actionlintBin(home: string): string {
  return join(home, "tools", "actionlint", actionlintVersion, "bin", "actionlint");
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return check();
}

describe("toolchain", () => {
  it("reads OPENQODEX_HOME", () => {
    const home = freshHome();
    expect(tc.openqodexHome()).toBe(home);
  });

  it("installs actionlint end to end, then resolves it again without downloading", async () => {
    const home = freshHome();
    const lines: string[] = [];
    const resolve = tc.createToolResolver({ allowInstall: true, installBudgetMs: null, onProgress: (l) => lines.push(l) });
    const first = await resolve("actionlint");
    expect(first).toMatchObject({ ok: true });
    if (!first.ok) return;
    expect(first.tool.path).toBe(actionlintBin(home));
    expect(first.tool.version).toBe(actionlintVersion);
    expect(execFileSync(first.tool.path, ["--version"], { encoding: "utf8" })).toContain(actionlintVersion);
    expect(lines).toEqual([`installing actionlint ${actionlintVersion} (first run only)`]);

    const marker = join(home, "tools", "actionlint", actionlintVersion, ".installed");
    const before = statSync(marker).mtimeMs;
    const again: string[] = [];
    const second = await tc.createToolResolver({ allowInstall: true, installBudgetMs: null, onProgress: (l) => again.push(l) })("actionlint");
    expect(second).toEqual(first);
    expect(again).toEqual([]);
    expect(statSync(marker).mtimeMs).toBe(before);
    expect(readdirSync(join(home, "tools", "actionlint")).filter((n) => n.startsWith(".staging"))).toEqual([]);
  }, 60_000);

  it("refuses a download whose checksum differs and leaves no version folder", async () => {
    const home = freshHome();
    const bad = structuredClone(table);
    for (const asset of Object.values(bad.tools.actionlint.assets) as { sha256: string }[]) asset.sha256 = "0".repeat(64);
    await expect(tc.installTool("actionlint", { table: bad })).rejects.toMatchObject({ message: "checksum mismatch" });
    expect(existsSync(join(home, "tools", "actionlint", actionlintVersion))).toBe(false);
    expect(readdirSync(join(home, "tools", "actionlint")).filter((n) => !n.startsWith(".lock"))).toEqual([]);
  }, 60_000);

  it("installs once when two resolvers race", async () => {
    const home = freshHome();
    const opts = { allowInstall: true, installBudgetMs: null };
    const [a, b] = await Promise.all([tc.createToolResolver(opts)("actionlint"), tc.createToolResolver(opts)("actionlint")]);
    expect(a).toMatchObject({ ok: true });
    expect(b).toEqual(a);
    const log = readFileSync(join(home, "tools", "actionlint", "install.log"), "utf8").trim().split("\n");
    expect(log).toHaveLength(1);
  }, 60_000);

  it("returns not_installed with one plain line when installs are off", async () => {
    const home = freshHome();
    const r = await tc.createToolResolver({ allowInstall: false, installBudgetMs: null })("actionlint");
    expect(r).toEqual({ ok: false, status: "not_installed", reason: "not installed (installs are off)" });
    expect(existsSync(join(home, "tools", "actionlint"))).toBe(false);
  });

  it("returns installing past the budget and finishes after the caller exits", async () => {
    const home = freshHome();
    // A separate caller process: resolves with a 1 ms budget, prints the result, exits.
    const caller = `
      const tc = await import(${JSON.stringify(dist)});
      tc.setInstallWorkerEntry(${JSON.stringify(worker)});
      const r = await tc.createToolResolver({ allowInstall: true, installBudgetMs: 1 })("actionlint");
      process.stdout.write(JSON.stringify(r));
    `;
    const started = Date.now();
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", caller], {
      encoding: "utf8",
      env: { ...process.env, OPENQODEX_HOME: home },
      timeout: 15_000,
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(JSON.parse(out)).toEqual({
      ok: false,
      status: "installing",
      reason: "first run only, still installing; it will be included next run",
    });
    expect(await waitFor(() => existsSync(join(home, "tools", "actionlint", actionlintVersion, ".installed")), 60_000)).toBe(true);
    expect(execFileSync(actionlintBin(home), ["--version"], { encoding: "utf8" })).toContain(actionlintVersion);
  }, 90_000);

  it("gives a plain reason when the home folder cannot be written", async () => {
    const parent = mkdtempSync(join(tmpdir(), "oq-readonly-"));
    chmodSync(parent, 0o555);
    const home = join(parent, "home");
    process.env.OPENQODEX_HOME = home;
    const r = await tc.createToolResolver({ allowInstall: true, installBudgetMs: null })("actionlint");
    chmodSync(parent, 0o755);
    expect(r).toEqual({
      ok: false,
      status: "not_installed",
      reason: `cannot write ${home} here: run \`npx openqodex doctor --install\` in your own terminal`,
    });
  });

  it("names the missing runtime instead of installing", async () => {
    freshHome();
    // An empty PATH has neither Ruby nor Go; the caller is a separate process
    // so this process keeps its own PATH.
    const caller = `
      const tc = await import(${JSON.stringify(dist)});
      const resolve = tc.createToolResolver({ allowInstall: true, installBudgetMs: null });
      process.stdout.write(JSON.stringify([await resolve("brakeman"), await resolve("golangci")]));
    `;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", caller], {
      encoding: "utf8",
      env: { ...process.env, PATH: "/nonexistent" },
    });
    expect(JSON.parse(out)).toEqual([
      { ok: false, status: "not_installed", reason: "needs Ruby 2.7 or newer" },
      { ok: false, status: "not_installed", reason: "needs Go" },
    ]);
  });
});

describe("downloadVerified and extractArchive", () => {
  it("refuses an archive member that escapes the destination", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oq-tar-"));
    const archive = join(dir, "evil.tar.gz");
    writeFileSync(archive, gzipSync(tarOf([["ok.txt", "fine\n"], ["../escape.txt", "outside\n"]])));
    const dest = join(dir, "out");
    mkdirSync(dest);
    await expect(tc.extractArchive(archive, "tar.gz", dest)).rejects.toThrow(/escapes/);
    expect(existsSync(join(dir, "escape.txt"))).toBe(false);
    expect(readdirSync(dest)).toEqual([]);
  });

  it("unpacks a normal archive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oq-tar-"));
    const archive = join(dir, "good.tar.gz");
    writeFileSync(archive, gzipSync(tarOf([["a/b.txt", "hello\n"]])));
    const dest = join(dir, "out");
    mkdirSync(dest);
    await tc.extractArchive(archive, "tar.gz", dest);
    expect(readFileSync(join(dest, "a", "b.txt"), "utf8")).toBe("hello\n");
  });

  it("returns the sha256 of what it downloaded and refuses a wrong one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oq-dl-"));
    const asset = table.tools.actionlint.assets["linux-arm64"];
    const got = await tc.downloadVerified(asset.url, null, join(dir, "a"));
    expect(got.sha256).toBe(asset.sha256);
    expect(createHash("sha256").update(readFileSync(join(dir, "a"))).digest("hex")).toBe(asset.sha256);
    await expect(tc.downloadVerified(asset.url, "f".repeat(64), join(dir, "b"))).rejects.toThrow("checksum mismatch");
    expect(existsSync(join(dir, "b"))).toBe(false);
  }, 60_000);
});

// A minimal ustar archive, written by hand so a member can carry ../ in its name.
function tarOf(files: [string, string][]): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, text] of files) {
    const body = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
