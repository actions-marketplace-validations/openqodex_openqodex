import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "./global-setup.js";
import type { RulePack, ScannerRunSummary } from "@openqodex/core";
import { createToolResolver, readRulePack, rulePackHash } from "../../packages/scanners/dist/index.js";
import { demo, git, report, run, toolsHome } from "./support.js";
import { removeTempDirs, tempDir } from "../temp-dirs.mjs";

afterAll(removeTempDirs);

const PACKS = ["p/default", "p/security-audit", "p/secrets"];
const offline = process.env.OPENQODEX_E2E_OFFLINE === "1";
if (offline) process.stdout.write("semgrep rule packs: skipped, OPENQODEX_E2E_OFFLINE=1\n");

// A pack by its name and the sha256 of its rules, without its raw size: two
// fetches of one rule set can differ in size when the registry serves its
// YAML form to one and its JSON form to the other.
const rulesOf = (packs: RulePack[] | undefined) => packs?.map(({ pack, sha256 }) => ({ pack, sha256 }));

// The sha256 of a pack's rules, from the bytes semgrep saved.
const hashOf = (bytes: Buffer): string => {
  const hash = rulePackHash(bytes);
  if (hash === null) throw new Error(`semgrep saved ${bytes.length} bytes that are not a rule pack`);
  return hash;
};

// The byte offset of one letter inside the `pattern` value of one rule of
// the pack, found by parsing: the first rule whose pattern is plain ASCII
// text (no quote or backslash, so the JSON and the YAML forms spell it as
// it is) and whose `pattern` key and value occur once in the raw text.
function patternLetter(raw: Buffer): { rule: number; at: number } {
  const rules = readRulePack(raw);
  if (rules === null) throw new Error("semgrep saved bytes that are not a rule pack");
  const text = raw.toString("latin1");
  for (const [i, r] of rules.entries()) {
    const p = r.pattern;
    if (typeof p !== "string" || !/^[\x20-\x7e]+$/.test(p) || /["'\\]/.test(p) || !/[a-z]/.test(p)) continue;
    for (const spelled of [`"pattern":"${p}"`, `pattern: ${p}\n`, `pattern: '${p}'`, `pattern: "${p}"`]) {
      const at = text.indexOf(spelled);
      if (at === -1 || text.indexOf(spelled, at + 1) !== -1) continue;
      const value = at + spelled.lastIndexOf(p);
      return { rule: i, at: value + p.search(/[a-z]/) };
    }
  }
  throw new Error("no rule of the pack has a plain pattern that occurs once");
}

// The pinned semgrep, run by hand with the adapter's arguments and a temp
// folder of its own, on the changed files of `dir`. Its own log names the
// file it saved each pack to ("Downloading config from <url>", then "Saving
// rules to <path>"), so each pack's bytes are known without the adapter.
// Each pack is recorded as the adapter records it: the sha256 of its rules
// in the documented normal form, and its raw size.
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
      packs.push({ pack: fetching, sha256: hashOf(content), bytes: content.length });
      bytes.set(fetching, content);
      fetching = null;
    }
  }
  return { packs, bytes };
}

// semgrep fetches its rule packs from the registry on every run, so two
// samples of one benchmark run can be scanned with different rules. Each
// scan names the packs it consumed by the sha256 of their rules, so that
// difference is seen, and the record of one unchanged rule set does not
// move. The registry lists the same rules in another order from one
// response to the next (CI run 38151186100 saw two orders of p/default
// within two minutes), so the sha256 is of the rules in a normal form, not
// of the raw bytes.
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
  it("records, pack by pack, the sha256 of the rules semgrep read", () => {
    expect(hand.packs.map((p) => p.pack)).toEqual(PACKS);
    for (const s of scans) expect(rulesOf(s.semgrep?.rules)).toEqual(rulesOf(hand.packs));
  });
  it("records a different sha256 for a pack whose rules differ by one byte", () => {
    const original = hand.bytes.get("p/default")!;
    // One letter of one rule's pattern moved to the next letter: the pack
    // still parses, with the same rules, and only that pattern changed.
    const { rule, at } = patternLetter(original);
    const altered = Buffer.from(original);
    altered[at] = original[at] === 0x7a ? 0x61 : original[at]! + 1;
    const before = readRulePack(original)!;
    const after = readRulePack(altered);
    expect(after?.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(after![rule]!.pattern).not.toBe(before[rule]!.pattern);
    expect(after!.filter((r, i) => i !== rule && JSON.stringify(r) !== JSON.stringify(before[i]))).toEqual([]);
    const recorded = scans[0]!.semgrep?.rules?.find((r) => r.pack === "p/default");
    expect(recorded?.sha256).toBe(hashOf(original));
    expect(hashOf(altered)).not.toBe(recorded?.sha256);
  });
  it("records the same packs for two scans a minute apart", () => {
    expect(scans[1]!.at - scans[0]!.at).toBeGreaterThanOrEqual(60_000);
    expect(scans[0]!.semgrep?.rules).toHaveLength(PACKS.length);
    expect(rulesOf(scans[1]!.semgrep?.rules)).toEqual(rulesOf(scans[0]!.semgrep?.rules));
  });
});
