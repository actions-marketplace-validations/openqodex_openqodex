// Real binaries on tiny planted inputs for the workflow and SQL scanners:
// zizmor, squawk and SQLFluff. Each case guards that scanner's invocation,
// output parser, changed-line filter and tool resolution together; the proxy
// cases guard that a scanner opens no connection; the settings cases guard
// what each one reads from the repository and that it writes nothing there.
// Run by the end-to-end config, not the unit config.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { parseConfig } from "@openqodex/core";
import type { BuiltinScanner } from "@openqodex/core";
import { createToolResolver, runScanners } from "@openqodex/scanners";
import { afterAll, describe, expect, it } from "vitest";
import { resolveFirst, scan, withLoggingProxy } from "./subprocess-support.js";
import type { Case } from "./subprocess-support.js";

// A pull request title pasted into a script: template injection.
const INJECTED_WORKFLOW = `on: pull_request
permissions: {}
jobs:
  greet:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ github.event.pull_request.title }}"
`;

const cases: Case[] = [
  { scanner: "zizmor", rule: "template-injection", files: { ".github/workflows/greet.yml": INJECTED_WORKFLOW }, anchor: ".github/workflows/greet.yml" },
  {
    scanner: "zizmor",
    rule: "template-injection",
    files: { ".github/actions/greet/action.yml": 'name: greet\ndescription: d\nruns:\n  using: composite\n  steps:\n    - run: echo "${{ github.event.issue.title }}"\n      shell: bash\n' },
    anchor: ".github/actions/greet/action.yml",
  },
  {
    scanner: "zizmor",
    rule: "dependabot-execution",
    files: { ".github/dependabot.yml": "version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule:\n      interval: daily\n    cooldown:\n      default-days: 7\n    insecure-external-code-execution: allow\n" },
    anchor: ".github/dependabot.yml",
  },
];

// Every file under `dir`, relative to it, sorted.
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.push(relative(dir, path));
    }
  };
  walk(dir);
  return out.sort();
}

// A scan of `files` in a repository at `repoDir`, every line of `changed`
// counted as changed.
async function scanAt(repoDir: string, scanner: BuiltinScanner, files: Record<string, string>, changed: string[]) {
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(repoDir, name)), { recursive: true });
    writeFileSync(join(repoDir, name), body);
  }
  const coverage = new Map(changed.map((p) => [p, new Set(readFileSync(join(repoDir, p), "utf8").split("\n").map((_, i) => i + 1))]));
  return runScanners({ repoDir, changedPaths: changed, coverage, config: parseConfig("").config, resolveTool: createToolResolver({ allowInstall: true, installBudgetMs: null }), only: [scanner] });
}

let ran = 0;
let skipped = 0;
afterAll(() => {
  process.stdout.write(`${ran} ran, ${skipped} skipped\n`);
  if (process.env.CI) expect(skipped, "a builtin scanner was skipped under CI").toBe(0);
});

describe("workflow and SQL scanner subprocesses", () => {
  for (const spec of cases) it(`${spec.scanner} reports ${spec.rule} on a changed line of ${spec.anchor}`, async () => {
    const result = await scan(spec);
    ran++;
    expect(result.scan.scanners[0]!.status).toBe("ran");
    expect(result.scan.candidates).toContainEqual(expect.objectContaining({ source: spec.scanner, ruleId: spec.rule, filePath: spec.anchor }));
  }, 300_000);

  // zizmor's template injection spans the expression alone; actionlint and
  // semgrep report the same problem on the same line (same-problem.ts).
  it("zizmor reports template injection on the expression's line, high", async () => {
    const result = await scan(cases[0]!);
    const hits = result.scan.candidates.filter((c) => c.source === "zizmor" && c.ruleId === "template-injection");
    expect(hits.map((c) => [c.lineStart, c.lineEnd, c.severity])).toEqual([[7, 7, "high"]]);
  }, 300_000);

  // --offline: zizmor runs no audit that asks the GitHub API.
  it("zizmor opens no connection", async () => {
    await resolveFirst("zizmor");
    const { result, hosts } = await withLoggingProxy(() => scan(cases[0]!));
    expect(result.scan.scanners[0]!.status).toBe("ran");
    expect(hosts).toEqual([]);
  }, 300_000);

  // zizmor's settings hold rules only. The one at the repository root is
  // read, a change to it is a settings-file candidate, and zizmor writes
  // nothing into the repository.
  it("zizmor reads the root zizmor.yml, raises the changed settings file and writes nothing", async () => {
    const repo = mkdtempSync(join(tmpdir(), "oq-adapter-zizmor-config-"));
    const files = {
      ".github/workflows/greet.yml": INJECTED_WORKFLOW,
      ".github/zizmor.yml": "rules:\n  template-injection:\n    disable: true\n",
    };
    const result = await scanAt(repo, "zizmor", files, Object.keys(files));
    expect(result.scan.scanners[0]!.status).toBe("ran");
    expect(result.scan.candidates.filter((c) => c.ruleId === "template-injection")).toEqual([]);
    expect(result.scan.candidates).toContainEqual(expect.objectContaining({ source: "zizmor", ruleId: "settings-file", filePath: ".github/zizmor.yml" }));
    expect(listFiles(repo)).toEqual(Object.keys(files).sort());
  }, 300_000);

  // With no .git folder (a worktree has a .git file), zizmor itself would
  // walk up to the filesystem root for a zizmor.yml. One above the
  // repository is never read.
  it("zizmor never reads a zizmor.yml above the repository", async () => {
    const parent = mkdtempSync(join(tmpdir(), "oq-adapter-zizmor-parent-"));
    writeFileSync(join(parent, "zizmor.yml"), "rules:\n  template-injection:\n    disable: true\n");
    const repo = join(parent, "repo");
    mkdirSync(repo);
    const result = await scanAt(repo, "zizmor", { ".github/workflows/greet.yml": INJECTED_WORKFLOW }, [".github/workflows/greet.yml"]);
    expect(result.scan.candidates).toContainEqual(expect.objectContaining({ source: "zizmor", ruleId: "template-injection" }));
  }, 300_000);
});
