import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "./global-setup.js";
import type { ScannerRunSummary } from "@openqodex/core";
import { demo, report, run } from "./support.js";
import { removeTempDirs } from "../temp-dirs.mjs";

afterAll(removeTempDirs);

const PACKS = ["p/default", "p/security-audit", "p/secrets"];
const offline = process.env.OPENQODEX_E2E_OFFLINE === "1";
if (offline) process.stdout.write("semgrep rule packs: skipped, OPENQODEX_E2E_OFFLINE=1\n");

// semgrep fetches its rule packs from the registry on every run, so two
// samples of one benchmark run can be scanned with different rules. Each
// scan names the packs it consumed by sha256 and size, so that difference
// is seen, and the record of one unchanged pack set does not move.
describe.skipIf(offline)("two samples of one run use different semgrep rules unnoticed", () => {
  let dir: string;
  const scans: { status: number | null; at: number; semgrep: ScannerRunSummary | undefined }[] = [];
  const scan = (label: string) => {
    const at = Date.now();
    const status = run(label, dir, ["scan", "--only", "semgrep", "--format", "json"]).status;
    scans.push({ status, at, semgrep: report(dir).scanners.find((s) => s.scanner === "semgrep") });
  };
  beforeAll(async () => {
    dir = demo("semgrep-packs");
    scan("semgrep-packs-first");
    await new Promise((resolve) => setTimeout(resolve, 60_000));
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
  it("records the same packs for two scans a minute apart", () => {
    expect(scans[1]!.at - scans[0]!.at).toBeGreaterThanOrEqual(60_000);
    expect(scans[0]!.semgrep?.rules).toHaveLength(PACKS.length);
    expect(scans[1]!.semgrep?.rules).toEqual(scans[0]!.semgrep?.rules);
  });
});
