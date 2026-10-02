// One test per real failure found in the review of the custom scanner code.
// The scanners here are real shell scripts on disk, run as real processes.
//
// Ways it could fail:
// 1. Two repos approving different scanners with the same name and version
//    share one install folder, so one repo's approval runs the other's bytes;
//    a version text such as ".." reaches a recursive delete in the home folder.
// 2. An `install: path` approval binds nothing: the binary can be swapped
//    after approval and still runs; a binary inside the repo, or found through
//    a relative PATH entry, is approved.
// 3. An npm or uv spec without an exact pin, or a version that disagrees with
//    the pin, is approved and installs whatever the registry serves later.
// 4. Two processes writing trust.json at once lose each other's records.
// 5. A report line of 2^53 or a span of millions of lines reaches the
//    changed-line filter, which then never finishes.
// 6. A scanner leaving a FIFO or a symlink to /dev/zero at {report} hangs the
//    run or exhausts memory.
// Second pass:
// 7. A repo folder whose name starts with two dots ("..tools") counts as
//    outside the repo, so a binary in it is approved.
// 8. A lock left by a dead process is taken over automatically, which can
//    admit two writers; a live holder is waited for forever.
// 9. Two approvals of the same entry and artifact from two repos at once
//    delete or replace each other's install folder.
// 10. An install: path binary swapped after the adapter was built still runs.
import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parseConfig, type CustomScanner } from "@openqodex/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approve, customAdapters, resolveCustomArtifact, revoke, trustState, type ResolvedArtifact } from "../src/custom/index.js";
import { parseJsonMap } from "../src/formats/json-map.js";
import { parseSarif } from "../src/formats/sarif.js";

const here = dirname(fileURLToPath(import.meta.url));
const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

let home: string;
const saved = { home: process.env.OPENQODEX_HOME, path: process.env.PATH };
beforeEach(() => {
  home = tmp("oq-home-");
  process.env.OPENQODEX_HOME = home;
});
afterEach(() => {
  if (saved.home === undefined) delete process.env.OPENQODEX_HOME;
  else process.env.OPENQODEX_HOME = saved.home;
  process.env.PATH = saved.path;
});

const entryFrom = (yaml: string): CustomScanner => parseConfig(`scanners:\n  custom:\n${yaml}`).config.custom[0]!;

function script(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const sarifFor = (file: string) =>
  JSON.stringify({ version: "2.1.0", runs: [{ tool: { driver: { name: "s" } }, results: [{ ruleId: "r", message: { text: "m" }, locations: [{ physicalLocation: { artifactLocation: { uri: file }, region: { startLine: 1 } } }] }] }] });

function repoWith(file: string): string {
  const repo = tmp("oq-repo-");
  writeFileSync(join(repo, file), "x\n");
  return repo;
}

// A bare-binary release artifact placed in quarantine, the way resolve leaves it.
function quarantined(bytes: string): ResolvedArtifact {
  const dir = join(home, "quarantine", Math.random().toString(16).slice(2));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "download");
  writeFileSync(path, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { version: "1", assetName: "scan-linux-arm64", url: "https://github.com/a/scan/releases/download/1/scan", sha256, checksumSource: "first-download", binary: "scan", quarantinePath: path };
}

describe("custom scanner review fixes", () => {
  it("1: a second repo approving another scanner with the same name and version does not replace the first one's bytes", async () => {
    const entryA = entryFrom(`    - { source: "https://github.com/a/scan", name: scan, version: "1", run: "scan --a" }`);
    const entryB = entryFrom(`    - { source: "https://github.com/b/scan", name: scan, version: "1", run: "scan --b" }`);
    const [repoA, repoB] = [tmp("oq-a-"), tmp("oq-b-")];
    await approve(repoA, entryA, quarantined("#!/bin/sh\necho A\n"));
    await approve(repoB, entryB, quarantined("#!/bin/sh\necho B\n"));
    const a = trustState(repoA, { ...parseConfig("").config, custom: [entryA] })[0]!.record!;
    expect(readFileSync(a.artifact.binary, "utf8")).toContain("echo A");
  });

  it("1: a version of '..' never deletes anything in the home folder", async () => {
    const keep = join(home, "tools", "custom", "other", "keep");
    mkdirSync(dirname(keep), { recursive: true });
    writeFileSync(keep, "x");
    const entry = entryFrom(`    - { source: "https://github.com/a/scan", version: "..", run: "scan", install: { npm: "left-pad@1.3.0" } }`);
    await expect(resolveCustomArtifact(entry).then((art) => approve(tmp("oq-r-"), entry, art))).rejects.toThrow();
    expect(existsSync(keep)).toBe(true);
  });

  it("2: an install: path binary swapped after approval does not run", async () => {
    const bin = tmp("oq-bin-");
    const path = script(bin, "pscan", `cat <<'EOF'\n${sarifFor("a.txt")}\nEOF`);
    process.env.PATH = `${bin}:${saved.path}`;
    const repo = repoWith("a.txt");
    const entry = entryFrom(`    - { source: "https://github.com/a/pscan", run: "pscan", install: path }`);
    await approve(repo, entry, await resolveCustomArtifact(entry));
    const config = { ...parseConfig("").config, custom: [entry] };
    const ran = await customAdapters(repo, config)[0]!.run({ repoDir: repo, changedPaths: ["a.txt"] });
    expect(ran.findings).toHaveLength(1);
    writeFileSync(path, "#!/bin/sh\necho swapped\n");
    expect(trustState(repo, config)[0]!.state).toBe("changed");
    expect(customAdapters(repo, config)[0]!.skipped).toMatchObject({ status: "untrusted", reason: "the approved binary changed: run `openqodex trust`" });
  });

  it("2: an install: path binary inside the repo, or on a relative PATH entry, is refused", async () => {
    const repo = repoWith("a.txt");
    script(join(repo, "bin"), "rscan", "exit 0");
    const entry = entryFrom(`    - { source: "https://github.com/a/rscan", run: "rscan", install: path }`);
    process.env.PATH = `${join(repo, "bin")}:${saved.path}`;
    await expect(resolveCustomArtifact(entry).then((art) => approve(repo, entry, art))).rejects.toThrow(/inside the repo/);
    process.env.PATH = `bin:${saved.path}`;
    const cwd = process.cwd();
    process.chdir(repo);
    try {
      await expect(resolveCustomArtifact(entry)).rejects.toThrow(/not on PATH/);
    } finally {
      process.chdir(cwd);
    }
  });

  it("3: an npm or uv spec without an exact pin, or with a version that disagrees, is refused", async () => {
    const refused = [
      `install: { npm: "scanner" }`,
      `install: { npm: "scanner@^1.2.0" }`,
      `install: { npm: "scanner@latest" }`,
      `install: { uv: "scanner" }`,
      `install: { uv: "scanner>=1.0" }`,
      `install: { uv: "scanner==1.*" }`,
      `version: "2.0.0", install: { npm: "scanner@1.0.0" }`,
    ];
    for (const install of refused) {
      const entry = entryFrom(`    - { source: "https://github.com/a/scanner", run: "scanner", ${install} }`);
      await expect(resolveCustomArtifact(entry), install).rejects.toThrow(/exact version/);
    }
    const ok = await resolveCustomArtifact(entryFrom(`    - { source: "https://github.com/a/scanner", run: "scanner", install: { npm: "@scope/scanner@1.2.3" } }`));
    expect(ok).toMatchObject({ version: "1.2.3", assetName: "@scope/scanner@1.2.3" });
  });

  it("4: approvals written by several processes at once are all kept", { timeout: 120_000 }, async () => {
    const bin = tmp("oq-bin-");
    script(bin, "cscan", "exit 0");
    const repo = tmp("oq-repo-");
    const dist = pathToFileURL(join(here, "..", "dist", "index.js")).href;
    const program = `
      const { approve, resolveCustomArtifact } = await import(${JSON.stringify(dist)});
      const { parseConfig } = await import("@openqodex/core");
      for (let i = 0; i < 15; i++) {
        const name = "p" + process.argv[1] + "-" + i;
        const entry = parseConfig("scanners:\\n  custom:\\n    - { source: https://github.com/a/cscan, name: " + name + ", run: cscan, install: path }").config.custom[0];
        await approve(${JSON.stringify(repo)}, entry, await resolveCustomArtifact(entry));
      }`;
    const run = promisify(execFile);
    const env = { ...process.env, OPENQODEX_HOME: home, PATH: `${bin}:${saved.path}` };
    await Promise.all([0, 1, 2, 3, 4, 5].map((n) => run(process.execPath, ["--input-type=module", "-e", program, String(n)], { env, cwd: join(here, "..") })));
    const records = JSON.parse(readFileSync(join(home, "trust.json"), "utf8")).records;
    expect(records).toHaveLength(90);
  });

  it("5: a line number past the safe integer range or a span over 100,000 lines is dropped", () => {
    const repoDir = repoWith("a.txt");
    const opts = { repoDir, source: "custom:x" as const };
    const sarif = (startLine: number, endLine: number) =>
      JSON.stringify({ version: "2.1.0", runs: [{ results: [{ ruleId: "r", message: { text: "m" }, locations: [{ physicalLocation: { artifactLocation: { uri: "a.txt" }, region: { startLine, endLine } } }] }] }] });
    expect(parseSarif(sarif(2 ** 53, 2 ** 53), opts)).toEqual([]);
    expect(parseSarif(sarif(1, 2 ** 53), opts)).toEqual([]);
    expect(parseSarif(sarif(1, 200_000), opts)).toEqual([]);
    expect(parseSarif(sarif(1, 100_000), opts)).toHaveLength(1);
    const map = { items: ".", file: "f", line: "l", end_line: "e", rule: "r", severity: null, message: "m", reference: null, severity_map: {} };
    const json = (l: number, e: number) => JSON.stringify([{ f: "a.txt", l, e, r: "r", m: "m" }]);
    expect(parseJsonMap(json(2 ** 53, 2 ** 53), map, opts)).toEqual([]);
    expect(parseJsonMap(json(1, 2 ** 53), map, opts)).toEqual([]);
    expect(parseJsonMap(json(1, 200_000), map, opts)).toEqual([]);
  });

  for (const [what, body] of [
    ["a symlink to /dev/zero", `ln -s /dev/zero "$1"`],
    ["a FIFO", `mkfifo "$1"`],
  ] as const) {
    it(`6: a report left as ${what} fails the run instead of hanging it`, { timeout: 20_000 }, async () => {
      const bin = tmp("oq-bin-");
      script(bin, "fscan", body);
      process.env.PATH = `${bin}:${saved.path}`;
      const repo = repoWith("a.txt");
      const entry = entryFrom(`    - { source: "https://github.com/a/fscan", run: "fscan {report}", install: path }`);
      await approve(repo, entry, await resolveCustomArtifact(entry));
      const result = await customAdapters(repo, { ...parseConfig("").config, custom: [entry] })[0]!.run({ repoDir: repo, changedPaths: ["a.txt"] });
      expect(result.error).toMatch(/report/);
      expect(result.findings).toEqual([]);
    });
  }

  it("7: an install: path binary in a repo folder named '..tools' is refused as inside the repo", async () => {
    const repo = repoWith("a.txt");
    script(join(repo, "..tools"), "dscan", "exit 0");
    process.env.PATH = `${join(repo, "..tools")}:${saved.path}`;
    const entry = entryFrom(`    - { source: "https://github.com/a/dscan", run: "dscan", install: path }`);
    await expect(resolveCustomArtifact(entry).then((art) => approve(repo, entry, art))).rejects.toThrow(/inside the repo/);
  });

  it("8: a trust lock left by a dead process is not taken over; the error names the lock file", () => {
    const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
    const lock = join(home, "tools", "custom", ".lock");
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, `${dead} feedfacefeedface\n`);
    expect(() => revoke(tmp("oq-r-"), "x")).toThrow(lock);
    expect(readFileSync(lock, "utf8")).toContain("feedface");
  });

  it("8: a trust lock held by a live process is waited for, then refused with a plain error", { timeout: 30_000 }, () => {
    const holder = spawn("sleep", ["30"]);
    try {
      const lock = join(home, "tools", "custom", ".lock");
      mkdirSync(dirname(lock), { recursive: true });
      writeFileSync(lock, `${holder.pid} feedfacefeedface\n`);
      const started = Date.now();
      expect(() => revoke(tmp("oq-r-"), "x")).toThrow(/locked/);
      expect(Date.now() - started).toBeGreaterThanOrEqual(9_000);
    } finally {
      holder.kill();
    }
  });

  it("9: two repos approving the same entry and artifact at once both keep a working install", async () => {
    const entry = entryFrom(`    - { source: "https://github.com/a/scan", name: scan, version: "1", run: "scan" }`);
    const [repoA, repoB] = [tmp("oq-a-"), tmp("oq-b-")];
    const bytes = "#!/bin/sh\necho same\n";
    await Promise.all([approve(repoA, entry, quarantined(bytes)), approve(repoB, entry, quarantined(bytes))]);
    const config = { ...parseConfig("").config, custom: [entry] };
    for (const repo of [repoA, repoB]) {
      const record = trustState(repo, config)[0]!.record!;
      expect(readFileSync(record.artifact.binary, "utf8")).toBe(bytes);
    }
  });

  it("10: an install: path binary swapped after the adapter was built does not run", async () => {
    const bin = tmp("oq-bin-");
    const ran = join(bin, "ran");
    const path = script(bin, "lscan", `cat <<'EOF'\n${sarifFor("a.txt")}\nEOF`);
    process.env.PATH = `${bin}:${saved.path}`;
    const repo = repoWith("a.txt");
    const entry = entryFrom(`    - { source: "https://github.com/a/lscan", run: "lscan", install: path }`);
    await approve(repo, entry, await resolveCustomArtifact(entry));
    const [adapter] = customAdapters(repo, { ...parseConfig("").config, custom: [entry] });
    writeFileSync(path, `#!/bin/sh\ntouch ${JSON.stringify(ran)}\n`);
    const result = await adapter!.run({ repoDir: repo, changedPaths: ["a.txt"] });
    expect(result.error).toBe("the approved binary changed: run `openqodex trust`");
    expect(existsSync(ran)).toBe(false);
  });
});
