// The library's result carries the scan record and the phase timings, end
// to end: reviewChange from the built package, in the server profile, on the
// demo change committed in a clone, with the real scanners read from the e2e
// tools home and real git. The model provider is the only stand-in: each
// answer drops every candidate the brief names. The built CLI scans the same
// change, left uncommitted, so the two scan records can be compared.
//
// Ways it could fail, written before the code:
//  1. A hosted run cannot credit scanners: the result has no candidate list,
//     no selection and no trail, so a disposition names a candidate the host
//     cannot trace to the scanner that raised it, or the phase timings are
//     missing.
//  2. A secret in a scanned file reaches the result: in the scan record's
//     candidates or trail, as the secret's fingerprint, or anywhere else.
//  3. The library's scan record differs from the scan.json the CLI writes
//     for the same change, so a hosted run is scored on other numbers than a
//     laptop run.
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScanResult } from "@openqodex/core";
import "./global-setup.js";
import { reviewChange } from "../../packages/cli/dist/lib.js";
import type { ModelReviewer, ReviewResult } from "../../packages/cli/dist/lib.js";
import { demo, generatedSecret, git, readJson, run, toolsHome } from "./support.js";
import type { Result } from "./support.js";
import { adoptTempDir, removeTempDirs, tempDir } from "../temp-dirs.mjs";

afterAll(removeTempDirs);

const PHASES = ["change_ms", "scan_ms", "graph_ms", "brief_ms", "reviewer_ms", "finalize_ms", "total_ms"];

// The model provider stand-in: every answer drops each candidate the brief
// names, for the change id the brief gives.
const model: ModelReviewer = {
  kind: "model",
  model: "fixture-model",
  maxOutputTokens: 4096,
  async complete(request) {
    const brief = request.messages.find((m) => m.role === "user")?.text ?? "";
    const changeId = /`change_id`: `([0-9a-f]{12})`/.exec(brief)?.[1] ?? "missing";
    const dropped = [...brief.matchAll(/^- (c\d+) \[[^\]]+\] ([^:\s]+):(\d+) /gm)].map((m) => ({ candidate: m[1], reason: "Planted in the demo on purpose.", file_path: m[2], line_number: Number(m[3]) }));
    const answer = { version: 2, change_id: changeId, summary: "Reviewed the demo change.", findings: [], dropped };
    return { message: { text: JSON.stringify(answer), toolCalls: [] }, usage: { model: "fixture-model", inputTokens: 1000, outputTokens: 100, costUsd: null } };
  },
};

// A scan record with what changes from run to run left out: each scanner's
// own durations, and the secrets' fingerprints only the CLI's file keeps.
function timeless(scan: Partial<ScanResult>): unknown {
  const { secretFingerprints: _, ...rest } = scan;
  return { ...rest, scanners: (rest.scanners ?? []).map(({ durationMs: _d, resolveMs: _r, ...s }) => s) };
}

describe("the library's result on the demo change", () => {
  let secret: string;
  let scanned: Result;
  let cli: ScanResult;
  let result: ReviewResult;
  beforeAll(async () => {
    const dir = demo("library-scan");
    secret = generatedSecret(dir);
    // The host's clone: the demo with its planted change committed.
    const clone = join(tempDir("oq-lib-clone-"), "repo");
    cpSync(dir, clone, { recursive: true });
    const base = git(clone, "rev-parse", "HEAD").trim();
    git(clone, "add", "-A");
    git(clone, "commit", "-qm", "The planted change");
    const head = git(clone, "rev-parse", "HEAD").trim();

    const out = join(tempDir("oq-lib-cli-"), "report");
    scanned = run("library-scan-cli", dir, ["scan", "--report-dir", out]);
    cli = readJson<ScanResult>(join(out, "scan.json"));

    // The work folder directly under /tmp, as docs/library.md asks of a
    // host: TFLint's plugin socket goes in <workDir>/scratch/tmp, which must
    // be 80 characters or fewer, and the test run's own temp folder is longer
    // than that on macOS. A server run never moves the socket elsewhere.
    const workDir = mkdtempSync("/tmp/oq-lw-");
    adoptTempDir(workDir);
    result = await reviewChange({ clonePath: clone, mergeBaseSha: base, headSha: head }, model, {
      profile: "server",
      workDir,
      installRoot: join(toolsHome, "tools"),
      budget: { authorize: async () => true, deadlineMs: 600_000 },
      tools: { web: false, shell: false },
      scanners: "preinstalled",
    });
  }, 900_000);

  it("1. a hosted run cannot credit scanners: the result has no candidate list", () => {
    const scan = result.scan;
    expect(scan, "the result has no scan").toBeTruthy();
    expect(scan!.candidates.length).toBeGreaterThan(0);
    expect(scan!.trail?.length, "the scan has no trail").toBeGreaterThanOrEqual(scan!.candidates.length);
    const kept = scan!.trail!.filter((e) => e.stage === "kept");
    expect(kept.map((e) => e.id).sort()).toEqual(scan!.candidates.map((c) => c.id).sort());
    expect(scan!.scanners.filter((s) => s.status === "ran").length).toBeGreaterThan(0);
    for (const s of scan!.scanners) expect(scan!.selection?.some((c) => c.scanner === s.scanner), `${s.scanner} has no selection`).toBe(true);
    // Every candidate the reviewer disposed of is in the scan, by its token.
    expect(result.dispositions.length, result.reason ?? "").toBeGreaterThan(0);
    for (const d of result.dispositions) expect(scan!.candidates.find((c) => c.id === d.candidate)?.token, d.candidate).toBe(d.token);
    // The phase timings, scan_ms covering the slowest scanner.
    expect(Object.keys(result.timings ?? {}).sort()).toEqual([...PHASES].sort());
    expect(result.timings!.scan_ms).toBeGreaterThanOrEqual(Math.max(...scan!.scanners.map((s) => s.durationMs)));
  });

  it("2. a secret in a scanned file never appears in the result's scan, nor anywhere in the result", () => {
    const scan = result.scan;
    expect(scan, "the result has no scan").toBeTruthy();
    // The secret was scanned: a candidate sits on its line.
    expect(scan!.candidates.some((c) => c.filePath === "app/config.py" && c.lineStart === 2)).toBe(true);
    expect(scan).not.toHaveProperty("secretFingerprints");
    const text = JSON.stringify(result);
    expect(text).not.toContain(secret);
    expect(text).not.toContain(createHash("sha256").update(secret).digest("hex"));
  });

  it("3. the CLI's scan.json and the library's result agree on the scan record of one change", () => {
    expect([0, 1], scanned.stderr).toContain(scanned.status);
    expect(cli.trail?.length, "the CLI's scan.json has no trail").toBeGreaterThan(0);
    expect(result.scan, "the result has no scan").toBeTruthy();
    expect(timeless(result.scan!)).toEqual(timeless(cli));
  });
});
