// Ways this could fail, written before the fix:
// 1. A 4,000-character changed line left out of the brief stays unread.
// 2. Long context or removed lines prevent a range from being delivered.
// 3. The boundary measures the row label instead of the source line.
// 4. A summary hashes a secret in clear instead of the redacted text.
// 5. A line shown only by its hash completes the review, and no output says
//    the reviewer never read it.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { afterAll, expect, it } from "vitest";
import type { Change, Hunk } from "@openqodex/core";
import { deliverRanges, redactSnapshot } from "../src/conversation.js";
import { git } from "./repos.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);
const hash = (line: string) => createHash("sha256").update(line).digest("hex").slice(0, 12);
const hunk: Hunk = { path: "b.txt", start: 1, end: 1, deletion: false };
const change: Change = { files: [{ path: "b.txt", status: "added", binary: false }], coverage: new Map([["b.txt", new Set([1])]]), deletionPoints: new Map() } as Change;

// One review through the built CLI and the golden suite's scripted Codex
// provider, its answer bound to this change: a 4,000-character line in a file
// whose diff the brief leaves out. Run once, read by the two tests below.
let longReview: { status: number | null; stdout: string; stderr: string; run: string; context: string } | undefined;
function reviewLongLine() {
  if (longReview) return longReview;
  const dir = tempDir("oq-long-cli-");
  const home = tempDir("oq-long-home-");
  const provider = tempDir("oq-long-provider-");
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.txt"), "Base\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "Base");
  writeFileSync(join(dir, "a.txt"), ("x".repeat(202) + "\n").repeat(1000));
  mkdirSync(join(dir, "app"));
  writeFileSync(join(dir, "app/server.py"), "x".repeat(4000) + "\n");
  let source = readFileSync(resolve("tests/golden/stand-ins/codex.cjs"), "utf8");
  source = source.replace('const answer = readFileSync(join(folder, "submission.json"), "utf8").trim();', 'let input = ""; process.stdin.on("data", (part) => { input += part; });');
  source = source.replace('process.stdin.on("end", () => {', 'process.stdin.on("end", () => { writeFileSync(join(folder, "context"), input); const answer = JSON.stringify({ version: 2, change_id: /`change_id`: `([0-9a-f]{12})`/.exec(input)?.[1], summary: "Adds generated text.", findings: [], dropped: [] });');
  const executable = join(provider, "codex");
  writeFileSync(executable, `#!${process.execPath}\n${source}`);
  chmodSync(executable, 0o755);
  const env = { ...process.env, PATH: provider + delimiter + process.env.PATH, OPENQODEX_HOME: home, OPENQODEX_AUTO_UPDATE: "0" };
  for (const key of ["CODEX_SANDBOX", "CODEX_THREAD_ID", "CLAUDECODE", "OPENQODEX_REVIEW_DEPTH"]) delete env[key as keyof typeof env];
  const out = spawnSync(process.execPath, [resolve("packages/cli/dist/bin.js"), "review", "--reviewer", "codex", "--offline", "--no-color"], { cwd: dir, env, encoding: "utf8", timeout: 120_000 });
  const runs = join(dir, ".openqodex/reviews");
  longReview = { status: out.status, stdout: out.stdout, stderr: out.stderr, run: join(runs, readdirSync(runs)[0]!), context: readFileSync(join(provider, "context"), "utf8") };
  return longReview;
}

it("a 4,000-character line left out of the brief completes through the scripted Codex provider", () => {
  const r = reviewLongLine();
  const report = JSON.parse(readFileSync(join(r.run, "report.json"), "utf8"));
  expect(r.status, r.stderr).toBe(0);
  expect(report.completion.status).toBe("complete");
  expect(report.completion.coverage.unread).toEqual([]);
  expect(readFileSync(join(r.run, "rounds.json"), "utf8")).toContain("app/server.py");
  expect(r.context).toContain(`line 1: 4000 characters, sha256 ${hash("x".repeat(4000))}`);
}, 120_000);

it("the receipt, report.md, report.html and report.json name the 4,000-character line as not read", () => {
  const r = reviewLongLine();
  const line = "1 changed line was shown to the reviewer only by its length and hash: app/server.py:1";
  const md = readFileSync(join(r.run, "report.md"), "utf8");
  const html = readFileSync(join(r.run, "report.html"), "utf8");
  expect(r.stdout).toContain(`Not read: ${line}`);
  expect(md).toContain(line);
  expect(html).toContain(line);
  expect(JSON.parse(readFileSync(join(r.run, "report.json"), "utf8")).completion.coverage.hashed).toEqual([{ path: "app/server.py", start: 1, end: 1, deletion: false }]);
  for (const text of [r.stdout, md, html]) expect(text).not.toContain("their changed lines were in the brief");
}, 120_000);

it("long context and removed lines are summarized without blocking delivery", () => {
  const snapshotDir = tempDir("oq-long-context-");
  writeFileSync(join(snapshotDir, "b.txt"), "x".repeat(4000) + "\nshort\n");
  const removed = "y".repeat(4000);
  const deletion = { ...hunk, deletion: true };
  const given = deliverRanges({ snapshotDir, unread: [{ ...hunk, start: 2, end: 2 }, deletion], secrets: [], change: { ...change, deletionPoints: new Map([["b.txt", [{ after: 0, lines: 1, anchors: [1] }]]]), diffs: [{ path: "b.txt", text: `diff --git a/b.txt b/b.txt\n--- a/b.txt\n+++ b/b.txt\n@@ -1 +0,0 @@\n-${removed}\n` }] } });
  expect(given.delivered).toHaveLength(2);
  expect(given.left).toEqual([]);
  expect(given.text).toContain(`4000 characters, sha256 ${hash(removed)}`);
  // The long context line is not a changed line; the long removed line is.
  expect(given.hashed).toEqual([deletion]);
});

it("the 2,000-character limit is measured on the source line, not the numbered row", () => {
  const snapshotDir = tempDir("oq-long-boundary-");
  const at = "x".repeat(2000);
  const over = "y".repeat(2001);
  writeFileSync(join(snapshotDir, "b.txt"), `${at}\n${over}\n`);
  const given = deliverRanges({ snapshotDir, unread: [{ ...hunk, end: 2 }], secrets: [] });
  expect(given.text).toContain(`1\t${at}`);
  expect(given.text).toContain(`line 2: 2001 characters, sha256 ${hash(over)}`);
  expect(given.left).toEqual([]);
});

it("a secret in a long changed or removed line is hashed only after redaction", () => {
  const snapshotDir = tempDir("oq-long-secret-");
  const secret = "hidden-secret";
  const kept = "z".repeat(2001) + secret;
  const removed = "y".repeat(2001) + secret;
  writeFileSync(join(snapshotDir, "b.txt"), `${kept}\nshort\n`);
  redactSnapshot(snapshotDir, [secret]);
  const deletion = { ...hunk, end: 2, deletion: true };
  const diff = `diff --git a/b.txt b/b.txt\n--- a/b.txt\n+++ b/b.txt\n@@ -1,3 +1,2 @@\n z\n-${removed}\n short\n`;
  const given = deliverRanges({ snapshotDir, unread: [hunk, deletion], secrets: [secret], change: { ...change, deletionPoints: new Map([["b.txt", [{ after: 1, lines: 1, anchors: [1, 2] }]]]), diffs: [{ path: "b.txt", text: diff }] } });
  expect(given.leak).toBe(false);
  expect(given.delivered).toHaveLength(2);
  expect(given.text).toContain(`line 1: 2011 characters, sha256 ${hash("z".repeat(2001) + "[redacted]")}`);
  expect(given.text).toContain(`line removed: 2011 characters, sha256 ${hash("y".repeat(2001) + "[redacted]")}`);
  expect(given.text).not.toContain(secret);
  expect(given.text).not.toContain(hash(kept));
  expect(given.text).not.toContain(hash(removed));
});
