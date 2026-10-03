// Ways the report files could fail:
// 1. .openqodex/ shows up in git status, because its .gitignore is missing
//    or the developer's own .gitignore was needed.
// 2. A report folder name does not follow <yyyymmdd-hhmmss>-<shortid>.
// 3. Pruning keeps more than 20 folders, deletes the newest, or deletes
//    anything that is not one of its own report folders.
// 4. A reader sees a half-written file, or a temp file is left behind.
// 5. latest.json, scan.json, manifest.json or report.json do not round-trip,
//    or a missing or corrupt file throws instead of returning null.
// 6. findReportDir returns an older folder for the same change, or one for a
//    different change.
// 7. A report file name escapes the folder.
// 8. A repo ships .openqodex or .openqodex/reviews as a symlink and sends
//    writes and pruning outside the repo.
// 9. Two runs of the same change in the same second share a folder.
// 10. A failed rename leaves its temp file behind.
// 12. Pruning deletes the report a review receipt points at, so the push
//     gate or finalize loses a finished review after twenty scans.
// 11. The folder's .gitignore keeps the reports out of git but hides the
//     team files, or a Day 0 "*" is never rewritten, or a .gitignore the
//     team edited is rewritten.
import { execFileSync } from "node:child_process";
import { symlinkSync } from "node:fs";
import { OpenQodexError } from "../src/types.js";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  STATE_GITIGNORE,
  findReportDir,
  openReportDir,
  readLatest,
  readManifest,
  readReport,
  readScan,
  writeLatest,
  writeLatestScan,
  writeManifest,
  writeReportFiles,
  writeScan,
} from "../src/report-files.js";
import type { Latest, RunManifest, ScanResult } from "../src/types.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "oq-report-test-"));
  dirs.push(d);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: d });
  return d;
}

const ID = "0123456789ab";

describe("report files", () => {
  it("creates a state folder whose .gitignore keeps the reports out of git, and a dated report folder", () => {
    const r = repo();
    const dir = openReportDir(r, ID);
    expect(readFileSync(join(r, ".openqodex", ".gitignore"), "utf8")).toBe(STATE_GITIGNORE);
    expect(basename(dir)).toMatch(/^\d{8}-\d{6}-0123456789ab$/);
    expect(dir).toBe(join(r, ".openqodex", "reviews", basename(dir)));
    writeReportFiles(dir, { "report.md": "# r\n" });
    writeLatest(r, { dir: "x", change_id: ID, kind: "scan", finalized: false, verdict: null });
    writeLatestScan(r, { dir: "x", change_id: ID, kind: "scan", finalized: false, verdict: null });
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: r, encoding: "utf8" });
    expect(status).toBe("?? .openqodex/.gitignore\n");
  });

  it("rewrites a Day 0 .gitignore holding only * once, and never one the team edited", () => {
    const r = repo();
    mkdirSync(join(r, ".openqodex"));
    writeFileSync(join(r, ".openqodex", ".gitignore"), "*\n");
    openReportDir(r, ID);
    expect(readFileSync(join(r, ".openqodex", ".gitignore"), "utf8")).toBe(STATE_GITIGNORE);
    const edited = `${STATE_GITIGNORE}notes/\n`;
    writeFileSync(join(r, ".openqodex", ".gitignore"), edited);
    openReportDir(r, ID);
    expect(readFileSync(join(r, ".openqodex", ".gitignore"), "utf8")).toBe(edited);
  });

  it("keeps the newest 20 report folders and touches nothing else", () => {
    const r = repo();
    const reviews = join(r, ".openqodex", "reviews");
    mkdirSync(reviews, { recursive: true });
    const old = Array.from({ length: 25 }, (_, i) => `20200101-0000${String(i).padStart(2, "0")}-${ID}`);
    for (const n of old) mkdirSync(join(reviews, n));
    mkdirSync(join(reviews, "keep-me"));
    writeFileSync(join(reviews, "20200101-000000-aaaaaaaaaaaa.txt"), "not a folder");
    mkdirSync(join(reviews, "19990101-000000-NOTHEX000000"));
    const dir = openReportDir(r, "ffffffffffff");
    const left = readdirSync(reviews).sort();
    const reports = left.filter((n) => /^\d{8}-\d{6}-[0-9a-f]{12}$/.test(n));
    expect(reports).toHaveLength(20);
    expect(reports).toContain(basename(dir));
    expect(reports).toContain(old[24]);
    expect(reports).not.toContain(old[5]);
    expect(left).toContain("keep-me");
    expect(left).toContain("20200101-000000-aaaaaaaaaaaa.txt");
    expect(left).toContain("19990101-000000-NOTHEX000000");
  });

  it("finds the newest folder for a change id, full or short", () => {
    const r = repo();
    const reviews = join(r, ".openqodex", "reviews");
    mkdirSync(join(reviews, `20240101-000000-${ID}`), { recursive: true });
    mkdirSync(join(reviews, `20240102-000000-${ID}`));
    mkdirSync(join(reviews, "20240103-000000-bbbbbbbbbbbb"));
    expect(findReportDir(r, `${ID}${"c".repeat(52)}`)).toBe(join(reviews, `20240102-000000-${ID}`));
    expect(findReportDir(r, ID)).toBe(join(reviews, `20240102-000000-${ID}`));
    expect(findReportDir(r, "dddddddddddd")).toBeNull();
    expect(findReportDir(repo(), ID)).toBeNull();
  });

  it("round-trips every file and leaves no temp files", () => {
    const r = repo();
    const dir = openReportDir(r, ID);
    const scan: ScanResult = { candidates: [], scanners: [], fixturesDropped: 2, secretFingerprints: [] };
    const manifest: RunManifest = { version: 1, change_id: ID, config_hash: "h", created_at: "t", lenses: [] };
    const latest: Latest = { dir: "d", change_id: ID, kind: "review", finalized: true, verdict: "passed" };
    writeScan(dir, scan);
    writeManifest(dir, manifest);
    writeReportFiles(dir, { "report.json": JSON.stringify({ version: 1 }), "brief.md": "b" });
    writeLatest(r, latest);
    expect(readScan(dir)).toEqual(scan);
    expect(readManifest(dir)).toEqual(manifest);
    expect(readReport(dir)).toEqual({ version: 1 });
    expect(readLatest(r)).toEqual(latest);
    expect(readdirSync(dir).sort()).toEqual(["brief.md", "manifest.json", "report.json", "scan.json"]);
    expect(readdirSync(join(r, ".openqodex")).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("returns null for a missing or corrupt file", () => {
    const r = repo();
    expect(readLatest(r)).toBeNull();
    const dir = openReportDir(r, ID);
    writeFileSync(join(dir, "scan.json"), "{ half");
    expect(readScan(dir)).toBeNull();
    expect(readManifest(dir)).toBeNull();
    expect(readReport(dir)).toBeNull();
  });

  it("refuses a file name that is not a plain name", () => {
    const r = repo();
    const dir = openReportDir(r, ID);
    expect(() => writeReportFiles(dir, { "../escape.md": "x" })).toThrow();
    expect(existsSync(join(dir, "..", "escape.md"))).toBe(false);
  });

  it("refuses a symlinked state folder or reviews folder before writing or pruning", () => {
    const outside = repo();
    const victim = join(outside, "reviews");
    mkdirSync(join(victim, `20200101-000000-${ID}`), { recursive: true });
    for (let i = 0; i < 25; i++) mkdirSync(join(victim, `20200102-0000${String(i).padStart(2, "0")}-${ID}`));

    const a = repo();
    symlinkSync(outside, join(a, ".openqodex"));
    expect(() => openReportDir(a, ID)).toThrow(OpenQodexError);
    expect(() => writeLatest(a, { dir: "d", change_id: ID, kind: "scan", finalized: false, verdict: null })).toThrow(
      OpenQodexError,
    );

    const b = repo();
    mkdirSync(join(b, ".openqodex"));
    symlinkSync(victim, join(b, ".openqodex", "reviews"));
    expect(() => openReportDir(b, ID)).toThrow(OpenQodexError);

    expect(readdirSync(victim)).toHaveLength(26);
    expect(existsSync(join(outside, ".gitignore"))).toBe(false);
    expect(existsSync(join(outside, "latest.json"))).toBe(false);
  });

  it("gives every run its own folder and finds the newest", () => {
    const r = repo();
    const made = [openReportDir(r, ID), openReportDir(r, ID), openReportDir(r, ID)];
    expect(new Set(made).size).toBe(3);
    expect(findReportDir(r, ID)).toBe(made[2]);
  });

  it("orders same-second folders by their numeric suffix", () => {
    const r = repo();
    const reviews = join(r, ".openqodex", "reviews");
    for (const n of ["", "-2", "-10"]) mkdirSync(join(reviews, `20240101-000000-${ID}${n}`), { recursive: true });
    expect(findReportDir(r, ID)).toBe(join(reviews, `20240101-000000-${ID}-10`));
  });

  it("removes its temp file when the rename fails", () => {
    const r = repo();
    const dir = openReportDir(r, ID);
    mkdirSync(join(dir, "report.md"));
    writeFileSync(join(dir, "report.md", "keep"), "x");
    expect(() => writeReportFiles(dir, { "report.md": "# r\n" })).toThrow();
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps the report folders the review receipts name, however old", () => {
    const r = repo();
    const reviews = join(r, ".openqodex", "reviews");
    mkdirSync(reviews, { recursive: true });
    const old = Array.from({ length: 25 }, (_, i) => `20200101-0000${String(i).padStart(2, "0")}-${ID}`);
    for (const n of old) mkdirSync(join(reviews, n));
    writeLatest(r, { dir: `.openqodex/reviews/${old[0]}`, change_id: ID, kind: "review", finalized: true, verdict: "passed" });
    writeFileSync(join(r, ".openqodex", "latest-all.json"), JSON.stringify({ dir: `.openqodex/reviews/${old[1]}` }));
    openReportDir(r, "ffffffffffff");
    const left = readdirSync(reviews);
    expect(left).toContain(old[0]);
    expect(left).toContain(old[1]);
    expect(left).not.toContain(old[2]);
  });
});
