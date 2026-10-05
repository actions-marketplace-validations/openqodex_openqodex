// A change that tells a scanner to skip its own lines, through the built CLI
// in a real temp repo. No scanner is installed (an empty OPENQODEX_HOME and
// --no-install): the candidates for an added suppression comment and a
// changed settings file are raised whether or not their scanner runs. What
// the real scanners do with the same comments belongs to the end-to-end
// tests (tests/e2e/suppression.test.ts).
//
// Ways this could fail, written before the code:
// 1. A scan leaves an added suppression comment out of its findings, or
//    counts it at a severity other than minor.
// 2. A scan counts a marker the change did not add, or one inside a string.
// 3. A scan still shows a changed scanner settings file as a note that never
//    counts, instead of a minor finding.
// 4. block_on_severity: minor does not block on them, or major does.
// 5. The brief of review --agent does not list the suppression candidate.
// 6. A key on the line of an added gitleaks:allow reaches the terminal or a
//    report file.
// Added after the security check of the first version:
// 7. A review.severity_threshold above minor hides them from the terminal,
//    report.md, report.json or report.sarif of a scan.
// 8. --only or --skip of the scanner they name leaves them out, although the
//    comment still silences that scanner in every other run; or
//    scanners.disable, the repository's own choice, does not.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { cli, sandbox } from "./init-helpers.js";
import type { Sandbox } from "./init-helpers.js";

// Built at run time so this file holds no secret-shaped literal.
const KEY = ["sk", "live", "Qw3Er5Ty7Ui9Op2As4Df6Gh8"].join("_");

type Json = { verdict: string; findings: { source: string; severity: string; file_path: string; line_number: number; description: string }[] } & Record<string, unknown>;

// A repo whose committed app.py already holds a # nosec on line 2. The
// change adds a # nosec on line 3, the same text inside a string on line 4,
// a key behind gitleaks:allow and a root .gitleaksignore.
function changed(config?: string): Sandbox {
  const s = sandbox({ "app.py": "import os\nx = os.getcwd()  # nosec\n" });
  writeFileSync(join(s.repo, "app.py"), 'import os\nx = os.getcwd()  # nosec\ny = os.getpid()  # nosec\ns = "# nosec"\n');
  mkdirSync(join(s.repo, "app"));
  writeFileSync(join(s.repo, "app/config.py"), `KEY = "${KEY}"  # gitleaks:allow\n`);
  writeFileSync(join(s.repo, ".gitleaksignore"), "app/config.py:stripe-access-token:1\n");
  if (config !== undefined) {
    mkdirSync(join(s.repo, ".openqodex"));
    writeFileSync(join(s.repo, ".openqodex/config.yaml"), config);
  }
  return s;
}

const where = (r: Json) => r.findings.map((f) => `${f.source} ${f.file_path}:${f.line_number} ${f.severity}`).sort();

const EXPECTED = [
  "bandit:openqodex.suppression-added app.py:3 minor",
  "gitleaks:openqodex.suppression-added app/config.py:1 minor",
  "gitleaks:settings-file .gitleaksignore:1 minor",
];

describe("a scan of a change that silences a scanner", () => {
  let s: Sandbox;
  let out: { code: number | null; stdout: string };
  beforeAll(() => {
    s = changed();
    const r = cli(s, ["scan", "--no-install", "--format", "json"]);
    if (r.status === 2) throw new Error(r.stderr);
    out = { code: r.status, stdout: r.stdout };
  });

  it("counts each added suppression comment and the changed settings file as minor, and nothing else (1, 2, 3)", () => {
    const report = JSON.parse(out.stdout) as Json;
    expect(where(report)).toEqual(EXPECTED);
    expect(report).not.toHaveProperty("settings_changes");
    expect(out.code).toBe(0);
    expect(report.verdict).toBe("passed");
  });

  it("never prints the key behind gitleaks:allow, in the terminal or any report file (6)", () => {
    const terminal = cli(s, ["scan", "--no-install"]);
    expect(terminal.status).toBe(0);
    expect(terminal.stdout).toContain("openqodex.suppression-added");
    const reports = join(s.repo, ".openqodex", "reviews");
    const files = readdirSync(reports, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
    expect(files.map((e) => e.name)).toContain("report.sarif");
    for (const text of [out.stdout, terminal.stdout, terminal.stderr, ...files.map((e) => readFileSync(join(e.parentPath, e.name), "utf8"))]) {
      expect(text).not.toContain(KEY);
    }
  });
});

describe("block_on_severity and the minor findings of a scan", () => {
  it("blocks at minor and passes at major (4)", () => {
    const minor = cli(changed("review:\n  block_on_severity: minor\n"), ["scan", "--no-install", "--format", "json"]);
    expect(minor.status, minor.stderr).toBe(1);
    expect((JSON.parse(minor.stdout) as Json).verdict).toBe("blocked");
    const major = cli(changed("review:\n  block_on_severity: major\n"), ["scan", "--no-install", "--format", "json"]);
    expect(major.status, major.stderr).toBe(0);
    expect(where(JSON.parse(major.stdout) as Json)).toEqual(EXPECTED);
  });
});

describe("what can leave them out of a scan", () => {
  it("a severity_threshold above minor hides neither from any output format (7)", () => {
    const s = changed("review:\n  severity_threshold: major\n");
    const json = cli(s, ["scan", "--no-install", "--format", "json"]);
    expect(json.status, json.stderr).toBe(0);
    expect(where(JSON.parse(json.stdout) as Json)).toEqual(EXPECTED);
    const terminal = cli(s, ["scan", "--no-install"]);
    const latest = JSON.parse(readFileSync(join(s.repo, ".openqodex", "latest-scan.json"), "utf8")) as { dir: string };
    const read = (name: string) => readFileSync(join(s.repo, latest.dir, name), "utf8");
    const outputs = { terminal: terminal.stdout, "report.md": read("report.md"), "report.json": read("report.json"), "report.sarif": read("report.sarif") };
    for (const [name, text] of Object.entries(outputs)) {
      expect(text, name).toContain("openqodex.suppression-added");
      expect(text, name).toContain("settings-file");
      expect(text, name).toContain("app/config.py");
    }
  });

  it("--only and --skip of their scanner keep them; scanners.disable leaves them out (8)", () => {
    for (const flags of [["--only", "sqllint"], ["--skip", "bandit,gitleaks"]]) {
      const r = cli(changed(), ["scan", "--no-install", "--format", "json", ...flags]);
      expect(r.status, r.stderr).toBe(0);
      expect(where(JSON.parse(r.stdout) as Json), flags.join(" ")).toEqual(EXPECTED);
    }
    const disabled = cli(changed("scanners:\n  disable: [bandit]\n"), ["scan", "--no-install", "--format", "json"]);
    expect(where(JSON.parse(disabled.stdout) as Json)).toEqual(EXPECTED.filter((f) => !f.startsWith("bandit:")));
  });
});

describe("the review brief", () => {
  it("lists the added suppression comment for the reviewer to keep or drop (5)", () => {
    const s = changed();
    const r = cli(s, ["review", "--agent", "--no-install", "--no-graph"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/\[bandit:openqodex\.suppression-added\] app\.py:3 \(minor\)/);
    expect(r.stdout).toMatch(/\[gitleaks:openqodex\.suppression-added\] app\/config\.py:1 \(minor\)/);
  });
});
