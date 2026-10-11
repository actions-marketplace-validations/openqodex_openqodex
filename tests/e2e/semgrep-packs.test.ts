import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "./global-setup.js";
import type { RulePack, ScannerRunSummary } from "@openqodex/core";
import { createToolResolver } from "../../packages/scanners/dist/index.js";
import { demo, git, report, run, toolsHome } from "./support.js";
import { removeTempDirs, tempDir } from "../temp-dirs.mjs";

afterAll(removeTempDirs);

const PACKS = ["p/default", "p/security-audit", "p/secrets"];
const offline = process.env.OPENQODEX_E2E_OFFLINE === "1";
if (offline) process.stdout.write("semgrep rule packs: skipped, OPENQODEX_E2E_OFFLINE=1\n");

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

// The pinned semgrep, run by hand with the adapter's arguments and a temp
// folder of its own, on the changed files of `dir`. Its own log names the
// file it saved each pack to ("Downloading config from <url>", then "Saving
// rules to <path>"), so each pack's bytes are known without the adapter.
async function packsByHand(dir: string): Promise<{ packs: RulePack[]; bytes: Map<string, Buffer> }> {
  const resolution = await createToolResolver({ allowInstall: false, installBudgetMs: null, installRoot: join(toolsHome, "tools") })("semgrep");
  if (!resolution.ok) throw new Error(`semgrep is not installed in ${toolsHome}: ${resolution.reason}`);
  const files = git(dir, "ls-files", "--modified", "--others", "--exclude-standard").split("\n").filter((f) => f !== "");
  const tmp = tempDir("oq-semgrep-hand-tmp-");
  const log = join(tempDir("oq-semgrep-hand-log-"), "semgrep.log");
  const p = spawnSync(
    resolution.tool.path,
    ["scan", ...PACKS.flatMap((pack) => ["--config", pack]), "--json", "--quiet", "--metrics", "off", "--disable-version-check", "--no-git-ignore", "--timeout", "30", "--max-target-bytes", "1000000", "--", ...files],
    {
      cwd: dir,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
      env: { PATH: process.env.PATH ?? "", ...resolution.tool.env, HOME: tempDir("oq-semgrep-hand-home-"), TMPDIR: tmp, SEMGREP_ENABLE_VERSION_CHECK: "0", SEMGREP_LOG_FILE: log },
    },
  );
  if (p.status !== 0 && p.status !== 1) throw new Error(`semgrep by hand exited ${p.status}: ${p.stderr}`);
  const packs: RulePack[] = [];
  const bytes = new Map<string, Buffer>();
  let fetching: string | null = null;
  for (const line of readFileSync(log, "utf8").split("\n")) {
    const from = /Downloading config from https:\/\/semgrep\.dev\/(p\/[\w-]+)/.exec(line);
    if (from) fetching = from[1]!;
    const saved = / - Saving rules to (.+\.rules)$/.exec(line);
    if (saved && fetching !== null) {
      const content = readFileSync(saved[1]!);
      packs.push({ pack: fetching, sha256: sha256(content), bytes: content.length });
      bytes.set(fetching, content);
      fetching = null;
    }
  }
  return { packs, bytes };
}

// semgrep fetches its rule packs from the registry on every run, so two
// samples of one benchmark run can be scanned with different rules. Each
// scan names the packs it consumed by the sha256 and size of the bytes
// semgrep read, so that difference is seen, and the record of one unchanged
// pack set does not move.
describe.skipIf(offline)("two samples of one run use different semgrep rules unnoticed", () => {
  let dir: string;
  let hand: { packs: RulePack[]; bytes: Map<string, Buffer> };
  const scans: { status: number | null; at: number; semgrep: ScannerRunSummary | undefined }[] = [];
  const scan = (label: string) => {
    const at = Date.now();
    const status = run(label, dir, ["scan", "--only", "semgrep", "--format", "json"]).status;
    scans.push({ status, at, semgrep: report(dir).scanners.find((s) => s.scanner === "semgrep") });
  };
  beforeAll(async () => {
    dir = demo("semgrep-packs");
    scan("semgrep-packs-first");
    hand = await packsByHand(dir);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, scans[0]!.at + 60_000 - Date.now())));
    scan("semgrep-packs-second");
  }, 300_000);

  it("names the three packs with sha256 and byte count on each scan", () => {
    for (const s of scans) {
      expect(s.status).toBe(0);
      expect(s.semgrep?.status).toBe("ran");
      expect(s.semgrep?.rules?.map((r) => r.pack)).toEqual(PACKS);
      for (const r of s.semgrep?.rules ?? []) {
        expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(r.bytes).toBeGreaterThan(0);
      }
    }
  });
  it("records, pack by pack, the sha256 and size of the bytes semgrep read", () => {
    expect(hand.packs.map((p) => p.pack)).toEqual(PACKS);
    for (const s of scans) expect(s.semgrep?.rules).toEqual(hand.packs);
  });
  it("records a different sha256 for pack bytes that differ by one byte", () => {
    const original = hand.bytes.get("p/default")!;
    const altered = Buffer.from(original);
    altered[altered.length - 2] = altered[altered.length - 2]! ^ 1;
    const recorded = scans[0]!.semgrep?.rules?.find((r) => r.pack === "p/default");
    expect(recorded?.sha256).toBe(sha256(original));
    expect(sha256(altered)).not.toBe(recorded?.sha256);
  });
  it("records the same packs for two scans a minute apart", () => {
    expect(scans[1]!.at - scans[0]!.at).toBeGreaterThanOrEqual(60_000);
    expect(scans[0]!.semgrep?.rules).toHaveLength(PACKS.length);
    expect(scans[1]!.semgrep?.rules).toEqual(scans[0]!.semgrep?.rules);
  });
});
