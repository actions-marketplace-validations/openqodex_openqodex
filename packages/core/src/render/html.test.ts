// report.html, the display model it is drawn from, and the receipt the
// terminal prints instead of the whole report.
//
// Ways it could fail, written before the code:
//  1. Text from the change, a scanner or the reviewer reaches the page as
//     markup: a finding title holding <script>, a file name holding quotes
//     or angle brackets, a suggested change holding a tag.
//  2. The page loads or runs something: a script element, a src or an
//     outgoing href, an inline style attribute, or a policy that allows more
//     than the one stylesheet in the page.
//  3. A secret the scanners found shows on either side of the diff: one
//     that spans several lines (a private key) is split by the diff's +, -
//     and space prefixes and escapes a plain search, or only part of it
//     falls inside a hunk; or redacting it moves the line numbers.
//  4. A finding is shown twice, not at all, or under another line than the
//     one it cites.
//  5. A finding on a line the page does not show is put under an unrelated
//     line instead of a labelled group of its file.
//  6. A review with no findings gets no page, or a page that claims findings.
//  7. An incomplete review reads as a review: what is missing is not shown
//     first, or its findings are not labelled as findings so far.
//  8. A source line that looks like a diff header (a removed "-- x" or an
//     added "++ y") ends the hunk or shifts the numbers below it.
//  9. A binary, renamed-only or too-large file drops out of the page instead
//     of getting a section with a note.
// 10. The display keeps more source rows than its bound.
// 11. A display saved for the two-step review is used for another change,
//     or one that is not in the saved shape is used at all.
// 12. The receipt carries a finding's problem or fix, misses a finding, uses
//     other numbers than the report, or names the report by a relative path.
// 13. The coverage labels say "Files not read" beside a full coverage, which
//     reads as a hole in the review.
// 14. The reviewer's summary is kept in report.json but never shown.
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { getChange } from "../change.js";
import { makeChange, makeScan } from "../test-fixtures.js";
import type { Change, CompletionRecord, Report, ReportFinding } from "../types.js";
import { DISPLAY_MAX_ROWS, buildDisplay, checkDisplay } from "./display.js";
import { renderHtml } from "./html.js";
import { renderReceipt, renderReview } from "./review.js";

const PEM_LINES = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEAq7BFUpkGp3+LQmlQBmpP2Wvs7Y0dQ9XDu1cJx0j4Q2PbTnZ5",
  "x4yWm9lHk1oNn2E8sR7dQwUy3aXhY5tTq6Ff0yG7bLc9dK1mN2pQ3rS4tU5vW6xY",
  "Z7aB8cD9eF0gH1iJ2kL3mN4oP5qR6sT7uV8wX9yZ0aB1cD2eF3gH4iJ5kL6mN7oP",
  "-----END RSA PRIVATE KEY-----",
];
const PEM = PEM_LINES.join("\n");
const BODY = PEM_LINES.slice(1, 4);

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@openqodex.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

// A real repository whose one change goes from `before` to `after` in each file.
async function changeOf(files: Record<string, [string, string]>): Promise<Change> {
  const dir = mkdtempSync(join(tmpdir(), "oq-html-"));
  git(dir, "init", "-q", "-b", "main");
  for (const [path, [before]] of Object.entries(files)) writeFileSync(join(dir, path), before);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  for (const [path, [, after]] of Object.entries(files)) writeFileSync(join(dir, path), after);
  return getChange({ repoRoot: dir, scope: { uncommitted: true }, exclude: [], defaultBase: null });
}

const COMPLETE: CompletionRecord = {
  version: 1,
  contract: "openqodex-review-2",
  status: "complete",
  missing: [],
  reviewer: { driver: "claude", version: "2.1.293", pid: 1, started_at: "2026-10-07T10:00:00.000Z", ended_at: "2026-10-07T10:01:00.000Z", duration_ms: 60_000, rounds: 1, usage: { turns: 4, input_tokens: 1000, output_tokens: 200, cost_usd: 0.1 } },
  snapshot: { change_id: "x", tree: null, before: "a", after: "a" },
  candidates: { total: 1, disposed: 1 },
  coverage: { hunks: 2, covered: 2, unread: [], files_read: ["app/search.py"], files_not_read: ["app/settings.py"] },
  outside_reads: [],
  trace_complete: true,
};

function agentFinding(over: Partial<ReportFinding>): ReportFinding {
  return {
    origin: "agent",
    severity: "major",
    category: "security",
    confidence: 0.9,
    file_path: "app/search.py",
    line_number: 14,
    line_end: 14,
    title: "Search query built from request input",
    description: "Problem. Consequence. Fix.",
    suggested_change: null,
    source: "the reviewer",
    candidate: null,
    notes: [],
    problem: "The query interpolates the q request parameter.",
    consequence: "Any caller can inject SQL.",
    fix: "Pass q as a bound parameter.",
    ...over,
  };
}

function report(change: Change, over: Partial<Report> = {}): Report {
  return {
    version: 1,
    kind: "review",
    change_id: change.id,
    base: { ref: change.baseRef, sha: change.baseSha },
    generated_at: "2026-10-07T10:01:00.000Z",
    verdict: "passed",
    block_on_severity: null,
    summary: "Builds the search query from the request and adds a settings module.",
    findings: [agentFinding({})],
    below_threshold: 0,
    outside_change: [],
    low_confidence: [],
    not_reviewed: [],
    dropped: [],
    scanners: makeScan().scanners,
    impact: null,
    not_reviewed_paths: [],
    stats: change.stats,
    completion: { ...COMPLETE, snapshot: { ...COMPLETE.snapshot, change_id: change.id } },
    ...over,
  };
}

// The fixture change split per file, as the change source gives it.
function fixtureChange(): Change {
  const c = makeChange();
  const parts = c.diff.split(/(?=^diff --git )/m);
  return { ...c, diffs: [{ path: "app/search.py", text: parts[0] ?? "" }, { path: "app/settings.py", text: parts[1] ?? "" }] };
}

const page = (r: Report, change: Change, secrets: string[] = []) => renderHtml({ report: r, display: buildDisplay({ change, secrets }), version: "0.0.0-test" });
const count = (text: string, part: string) => text.split(part).length - 1;

describe("report.html", () => {
  it("1. renders hostile text from the reviewer, a scanner and the change as text", () => {
    const change = fixtureChange();
    const hostile = agentFinding({
      title: "<script>alert(1)</script>",
      problem: `"><img src=x onerror=alert(2)>`,
      suggested_change: "</code></pre><script>alert(3)</script>",
      source: "lens:<b>x</b>",
    });
    const html = page(report(change, { findings: [hostile], summary: "<iframe src=//evil>" }), change);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<iframe/i);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&quot;&gt;&lt;img src=x onerror=alert(2)&gt;");

    const named = { ...change, files: [{ path: `app/a"b'<c>.py`, status: "added" as const, oldPath: null, binary: false }], diffs: [] };
    const out = page(report(named, { findings: [agentFinding({ file_path: `app/a"b'<c>.py`, line_number: 1, line_end: 1 })] }), named);
    expect(out).toContain("app/a&quot;b&#39;&lt;c&gt;.py");
    expect(out).not.toContain(`a"b'<c>`);
    // Anchors are generated, never built from a path.
    expect(out).not.toMatch(/id="[^"]*app\//);
  });

  it("2. loads nothing and runs nothing: no script, no source, no outgoing link, no style attribute, a policy that allows its own stylesheet only", () => {
    const change = fixtureChange();
    const html = page(report(change), change);
    expect(html).not.toMatch(/<script|<link|<img|<iframe|<object|<embed|<form|<base/i);
    expect(html).not.toMatch(/\s(src|href|action|formaction|srcset)=["']?(https?:|\/\/|data:|javascript:)/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    const css = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
    expect(count(html, "<style>")).toBe(1);
    const hash = createHash("sha256").update(css, "utf8").digest("base64");
    const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1] ?? "";
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain(`style-src 'sha256-${hash}'`);
    expect(policy).not.toContain("unsafe-inline");
    expect(policy).toContain("script-src 'none'");
    // Every href is an anchor in the page.
    for (const href of html.match(/href="([^"]*)"/g) ?? []) expect(href).toMatch(/^href="#[a-z0-9-]+"$/);
  });

  it("3. redacts a multi-line secret on both sides of the diff, keeping every line number", async () => {
    // The key moves from the top of the file to the bottom, past eight
    // lines: removed as lines 2 to 6 of the old side, added as lines 10 to
    // 14 of the new side.
    const middle = Array.from({ length: 8 }, (_, i) => `v${i} = ${i}\n`).join("");
    const before = `top = 1\nKEY = """${PEM}"""\n${middle}end = 1\n`;
    const after = `top = 1\n${middle}KEY = """${PEM}"""\nend = 1\n`;
    const change = await changeOf({ "conf.py": [before, after] });
    const display = buildDisplay({ change, secrets: [PEM] });
    const html = renderHtml({ report: report(change, { findings: [] }), display, version: "0.0.0-test" });
    for (const line of BODY) expect(html).not.toContain(line);
    expect(JSON.stringify(display)).not.toContain(BODY[0]);
    const hunks = display.files[0]?.hunks ?? [];
    const rows = hunks.flatMap((h) => h.rows);
    // Within each hunk the numbers on both sides run on with no gap, as in the file.
    for (const h of hunks) {
      const olds = h.rows.filter((r) => r.old !== null).map((r) => r.old);
      const news = h.rows.filter((r) => r.new !== null).map((r) => r.new);
      expect(olds).toEqual(Array.from({ length: olds.length }, (_, i) => h.old_start + i));
      expect(news).toEqual(Array.from({ length: news.length }, (_, i) => h.new_start + i));
    }
    expect(rows.filter((r) => r.kind === "del").map((r) => r.old)).toEqual([2, 3, 4, 5, 6]);
    expect(rows.filter((r) => r.kind === "add").map((r) => r.new)).toEqual([10, 11, 12, 13, 14]);
    expect(rows.filter((r) => r.kind === "del" && r.text.includes("[redacted]")).length).toBe(5);
    expect(rows.filter((r) => r.kind === "add" && r.text.includes("[redacted]")).length).toBe(5);
  });

  it("3. redacts the lines of a multi-line secret that only partly falls inside a hunk", async () => {
    const body = `KEY = """${PEM}"""\n`;
    const before = `${body}x = 1\ny = 2\nz = 3\n`;
    const after = `${body}x = 1\ny = 20\nz = 3\n`;
    const change = await changeOf({ "conf.py": [before, after] });
    const display = buildDisplay({ change, secrets: [PEM] });
    const shown = display.files[0]?.hunks.flatMap((h) => h.rows).map((r) => r.text) ?? [];
    // The context above y reaches into the key: its last body line is there, redacted.
    expect(shown.some((t) => t.includes("[redacted]"))).toBe(true);
    for (const line of BODY) expect(shown.join("\n")).not.toContain(line);
  });

  it("4. shows each finding once, right under the line it cites", () => {
    const change = fixtureChange();
    const html = page(report(change), change);
    expect(count(html, 'id="finding-1"')).toBe(1);
    const row = html.indexOf('data-new="14"');
    const card = html.indexOf('id="finding-1"');
    expect(row).toBeGreaterThan(-1);
    expect(card).toBeGreaterThan(row);
    expect(html.indexOf('data-new="15"')).toBeGreaterThan(card);
  });

  it("5. puts a finding on a line the page does not show in a labelled group of its file", () => {
    const change = fixtureChange();
    const html = page(report(change, { findings: [agentFinding({ line_number: 40, line_end: 41 })] }), change);
    expect(count(html, 'id="finding-1"')).toBe(1);
    const group = html.indexOf("Findings on lines this page does not show");
    expect(group).toBeGreaterThan(-1);
    expect(html.indexOf('id="finding-1"')).toBeGreaterThan(group);
    expect(html.indexOf('id="finding-1"')).toBeLessThan(html.indexOf('data-new="12"'));
    expect(html).toContain("app/search.py:40-41");
  });

  it("6. writes a page for a review with no findings that says so", () => {
    const change = fixtureChange();
    const html = page(report(change, { findings: [] }), change);
    expect(html).toContain("Passed: no findings");
    expect(html).toContain("No findings on the changed lines.");
    expect(html).not.toContain('id="finding-1"');
    expect(html).toContain('id="file-1"');
  });

  it("7. shows what an incomplete review is missing first, and its findings as findings so far", () => {
    const change = fixtureChange();
    const completion: CompletionRecord = { ...COMPLETE, status: "incomplete", missing: ["the reviewer timed out and was stopped"] };
    const html = page(report(change, { verdict: "incomplete", completion }), change);
    const verdict = html.indexOf("Review incomplete");
    const missing = html.indexOf("the reviewer timed out and was stopped");
    expect(verdict).toBeGreaterThan(-1);
    expect(missing).toBeGreaterThan(verdict);
    expect(missing).toBeLessThan(html.indexOf("Findings so far"));
  });

  it("8. reads a removed line that looks like a header as a removed line", async () => {
    const change = await changeOf({ "notes.md": ["a\n-- x\nb\n", "a\n++ y\nb\n"] });
    const rows = buildDisplay({ change, secrets: [] }).files[0]?.hunks.flatMap((h) => h.rows) ?? [];
    expect(rows.map((r) => [r.kind, r.old, r.new, r.text])).toEqual([
      ["context", 1, 1, "a"],
      ["del", 2, null, "-- x"],
      ["add", null, 2, "++ y"],
      ["context", 3, 3, "b"],
    ]);
  });

  it("9. keeps a binary file, a renamed file and a file over the size cap, each with a note", () => {
    const change: Change = {
      ...fixtureChange(),
      files: [
        { path: "logo.png", status: "modified", oldPath: null, binary: true },
        { path: "new/name.py", status: "renamed", oldPath: "old/name.py", binary: false },
        { path: "big.json", status: "modified", oldPath: null, binary: false },
      ],
      diffs: [{ path: "new/name.py", text: "diff --git a/old/name.py b/new/name.py\nsimilarity index 100%\nrename from old/name.py\nrename to new/name.py\n" }],
      notReviewed: ["big.json"],
    };
    const html = page(report(change, { findings: [] }), change);
    for (const path of ["logo.png", "new/name.py", "old/name.py", "big.json"]) expect(html).toContain(path);
    expect(html).toContain("Binary file");
    expect(html).toContain("Renamed");
    expect(html).toContain("over the size");
  });

  it("10. keeps no more source rows than its bound and names the files left out", () => {
    const lines = Array.from({ length: DISPLAY_MAX_ROWS + 10 }, (_, i) => `+line ${i}`);
    const text = `diff --git a/big.txt b/big.txt\nnew file mode 100644\n--- /dev/null\n+++ b/big.txt\n@@ -0,0 +1,${lines.length} @@\n${lines.join("\n")}\n`;
    const change: Change = { ...fixtureChange(), diffs: [fixtureChange().diffs![0]!, { path: "big.txt", text }], files: [{ path: "app/search.py", status: "modified", oldPath: null, binary: false }, { path: "big.txt", status: "added", oldPath: null, binary: false }] };
    const display = buildDisplay({ change, secrets: [] });
    expect(display.rows).toBeLessThanOrEqual(DISPLAY_MAX_ROWS);
    expect(display.files[1]?.hunks).toEqual([]);
    expect(display.files[1]?.note).toMatch(/display limit/);
    expect(display.files[0]?.hunks.length).toBe(1);
  });

  it("11. refuses a saved display of another change or not in the saved shape", () => {
    const change = fixtureChange();
    const saved = JSON.parse(JSON.stringify(buildDisplay({ change, secrets: [] }))) as unknown;
    expect(checkDisplay(saved, change.id)).not.toBeNull();
    expect(checkDisplay(saved, "f".repeat(64))).toBeNull();
    expect(checkDisplay({ ...(saved as object), files: "x" }, change.id)).toBeNull();
    expect(checkDisplay({ ...(saved as object), version: 2 }, change.id)).toBeNull();
    expect(checkDisplay(null, change.id)).toBeNull();
  });

  it("14. shows the reviewer's summary under the verdict", () => {
    const change = fixtureChange();
    const html = page(report(change), change);
    expect(html.indexOf("Builds the search query from the request")).toBeGreaterThan(html.indexOf("Passed with warnings"));
  });
});

describe("the receipt", () => {
  const paths = { html: "/abs/repo/.openqodex/reviews/run/report.html", md: "/abs/repo/.openqodex/reviews/run/report.md" };

  it("12. names the verdict, each finding by number, severity, category, title and place, the summary and both absolute paths, and nothing of a finding's prose", () => {
    const change = fixtureChange();
    const r = report(change, {
      findings: [agentFinding({ severity: "minor", title: "Second", line_number: 15, line_end: 15 }), agentFinding({ severity: "critical", title: "First" })],
    });
    const out = renderReceipt(r, { ...paths, color: false }).trimEnd().split("\n");
    expect(out[0]).toBe("Passed with warnings: 2 findings (1 critical, 1 minor)");
    expect(out).toContain("Summary: Builds the search query from the request and adds a settings module.");
    expect(out).toContain("1. Critical security: First (app/search.py:14)");
    expect(out).toContain("2. Minor security: Second (app/search.py:15)");
    expect(out.slice(-2)).toEqual([`Report: ${paths.html}`, `Markdown: ${paths.md}`]);
    const text = out.join("\n");
    for (const prose of ["interpolates the q request", "Any caller can inject", "bound parameter"]) expect(text).not.toContain(prose);
    // The same numbers as the full report.
    const full = renderReview(r, { format: "terminal" });
    expect(full).toContain("1. Critical security: First");
    expect(full).toContain("2. Minor security: Second");
  });

  it("12. says what an incomplete review is missing in one line", () => {
    const change = fixtureChange();
    const completion: CompletionRecord = { ...COMPLETE, status: "incomplete", missing: ["the reviewer timed out and was stopped", "1 scanner candidate has no disposition"] };
    const out = renderReceipt(report(change, { verdict: "incomplete", completion, findings: [] }), { ...paths, color: false }).split("\n");
    expect(out[0]).toBe("Review incomplete: this is not a review of the change");
    expect(out).toContain("Missing: the reviewer timed out and was stopped; 1 scanner candidate has no disposition");
  });

  it("12. says when there is nothing to fix", () => {
    const change = fixtureChange();
    const out = renderReceipt(report(change, { findings: [] }), { ...paths, color: false });
    expect(out.split("\n")[0]).toBe("Passed: no findings");
    expect(out).toContain("No findings on the changed lines.");
  });
});

describe("the standard report", () => {
  it("13. labels the files the reviewer opened, and those whose changed lines were in the brief", () => {
    const change = fixtureChange();
    const out = renderReview(report(change), { format: "terminal" });
    expect(out).toContain("Files the reviewer opened: app/search.py");
    expect(out).toContain("Files not opened (their changed lines were in the brief): app/settings.py");
    expect(out).not.toContain("Files not read");
  });

  it("14. prints the reviewer's summary after the change line", () => {
    const change = fixtureChange();
    const out = renderReview(report(change), { format: "markdown" }).split("\n").filter((l) => l !== "");
    const at = out.findIndex((l) => l.startsWith("Change "));
    expect(out[at + 1]).toBe("Summary: Builds the search query from the request and adds a settings module.");
  });
});
