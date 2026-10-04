import { beforeAll, describe, expect, it } from "vitest";
import "./global-setup.js";
import { bin, demo, noReviewerEnv, root, run, writeConfig } from "./support.js";

// Four visible commands; `scan` stays as a hidden alias that behaves exactly
// as it did, because released hooks, pre-commit and the Action call it.
//
// Ways it could fail, written before the code:
//  a. `--help` lists a hidden command, or misses one of the four.
//  b. Plain `review` with no reviewer available presents the scanner output
//     as a review, or exits like `scan` does (the total review changed this:
//     plain `review` no longer equals `scan`).
//  c. Plain `review` writes its progress or messages on stdout and breaks --format json.
//  d. A 0.2.1-style hook line that calls `scan` stops working.

type Json = { verdict: string; findings: { source: string | null; file_path: string; line_number: number; severity: string }[] };
const key = (r: Json): string[] => r.findings.map((f) => `${f.severity} ${f.source} ${f.file_path}:${f.line_number}`).sort();

describe("the command menu", () => {
  it("a. --help lists exactly init, review, update and trust", () => {
    const r = run("menu-help", root, ["--help"]);
    expect(r.status).toBe(0);
    const section = r.stdout.split(/^Commands:$/m)[1] ?? "";
    const names = [...section.matchAll(/^ {2}(\S+)/gm)].map((m) => m[1]).filter((n) => n !== "help");
    expect(names).toEqual(["init", "review", "update", "trust"]);
  });

  describe("scan and plain review on the demo repo", () => {
    let dir: string;
    let scan: ReturnType<typeof run>;
    let review: ReturnType<typeof run>;
    beforeAll(() => {
      dir = demo("menu");
      writeConfig(dir, "review:\n  block_on_severity: major\n");
      scan = run("menu-scan", dir, ["scan", "--format", "json"]);
      review = run("menu-review", dir, ["review", "--format", "json"], { env: noReviewerEnv() });
    }, 300_000);

    it("b. scan still blocks on its findings; plain review with no reviewer exits 2 and is never a scan report", () => {
      expect(scan.status).toBe(1);
      expect(key(JSON.parse(scan.stdout) as Json).length).toBeGreaterThan(0);
      expect(review.status).toBe(2);
      expect(review.stderr).toContain("Full review unavailable");
    });

    it("c. plain review writes nothing but the report on stdout: here, with no report, nothing", () => {
      expect(review.stdout).toBe("");
    });

    it("d. a 0.2.1-style hook line calling scan still stops the push on a blocking finding", () => {
      const line = `node ${JSON.stringify(bin)} scan; s=$?; [ "$s" -eq 1 ] && exit 1; exit 0`;
      expect(run("menu-hook-line", dir, [line], { shell: true }).status).toBe(1);
    });
  });
});
