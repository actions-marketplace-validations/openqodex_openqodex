// Real binaries and small repositories. Each case guards the adapter's process
// invocation, parser, changed-line filter, and tool resolution together.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseConfig } from "@openqodex/core";
import type { BuiltinScanner } from "@openqodex/core";
import { createToolResolver, runScanners } from "@openqodex/scanners";

const scannerHome = process.env.OPENQODEX_E2E_HOME ?? join(tmpdir(), "openqodex-e2e-home");
process.env.OPENQODEX_HOME = scannerHome;
process.env.HOME = mkdtempSync(join(tmpdir(), "oq-adapter-user-"));

const generatedSecret = `sk_live_${randomBytes(12).toString("hex")}`;
const cases: { scanner: BuiltinScanner; rule: string; files: Record<string, string>; anchor: string }[] = [
  { scanner: "gitleaks", rule: "stripe-access-token", files: { "config.py": `STRIPE_KEY = '${generatedSecret}'\n` }, anchor: "config.py" },
  { scanner: "osv-scanner", rule: "GHSA-p6mc-m468-83gw", files: { "package-lock.json": JSON.stringify({ name: "tiny", lockfileVersion: 2, packages: { "": { name: "tiny" }, "node_modules/lodash": { version: "4.17.15" } } }, null, 2) }, anchor: "package-lock.json" },
  { scanner: "sqllint", rule: "security-definer-no-search-path", files: { "db/unsafe.sql": "CREATE FUNCTION public.do_thing() RETURNS void\nLANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN END $$;\n" }, anchor: "db/unsafe.sql" },
  { scanner: "semgrep", rule: "python.lang.security.audit.formatted-sql-query.formatted-sql-query", files: { "search.py": `import sqlite3
from flask import request
def query():
    user = request.args.get("name")
    db = sqlite3.connect("test.db")
    return db.execute(f"SELECT * FROM users WHERE name = '{user}'")
` }, anchor: "search.py" },
  { scanner: "actionlint", rule: "expression", files: { ".github/workflows/ci.yml": "on: pull_request\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ${{ github.event.pull_request.title }}\n" }, anchor: ".github/workflows/ci.yml" },
  { scanner: "hadolint", rule: "DL3007", files: { Dockerfile: "FROM python:latest\n" }, anchor: "Dockerfile" },
  { scanner: "shellcheck", rule: "SC2086", files: { "deploy.sh": "#!/bin/sh\necho $FOO\n" }, anchor: "deploy.sh" },
  { scanner: "ruff", rule: "F401", files: { "main.py": "import os\n" }, anchor: "main.py" },
  { scanner: "brakeman", rule: "SQL", files: { Gemfile: "source 'https://rubygems.org'\ngem 'rails'\n", "config/application.rb": "require 'rails/all'\nmodule Tiny\n  class Application < Rails::Application\n  end\nend\n", "app/controllers/users_controller.rb": "class UsersController < ApplicationController\n  def index\n    User.where(\"name = '#{params[:name]}'\")\n  end\nend\n" }, anchor: "app/controllers/users_controller.rb" },
  { scanner: "rubocop", rule: "Lint/UselessAssignment", files: { "app.rb": "unused = 1\n" }, anchor: "app.rb" },
  { scanner: "bandit", rule: "B608", files: { "search.py": "def query(user):\n    return f'SELECT * FROM users WHERE name = {user}'\n" }, anchor: "search.py" },
  { scanner: "oxlint", rule: "eslint/no-debugger", files: { "main.js": "debugger;\n" }, anchor: "main.js" },
  { scanner: "golangci", rule: "gosec", files: { "go.mod": "module example.com/tiny\n\ngo 1.22\n", "main.go": "package main\nimport \"crypto/md5\"\nfunc main() { _ = md5.New() }\n" }, anchor: "main.go" },
];
let ran = 0; let skipped = 0;
afterAll(() => { process.stdout.write(`${ran} ran, ${skipped} skipped\n`); if (process.env.CI) expect(skipped).toBe(0); });
describe("builtin scanner subprocesses", () => {
  for (const spec of cases) it(`${spec.scanner} reports ${spec.rule} on a changed line`, async () => {
    if (process.env.OPENQODEX_E2E_OFFLINE === "1" && ["semgrep", "osv-scanner"].includes(spec.scanner)) {
      skipped++; process.stdout.write(`${spec.scanner}: skipped offline network lookup\n`); return;
    }
    const repo = mkdtempSync(join(tmpdir(), `oq-adapter-${spec.scanner}-`));
    for (const [name, body] of Object.entries(spec.files)) { const path = join(repo, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); }
    const paths = Object.keys(spec.files);
    const coverage = new Map(paths.map((p) => [p, new Set(readFileSync(join(repo, p), "utf8").split("\n").map((_, i) => i + 1))]));
    const result = await runScanners({ repoDir: repo, changedPaths: paths, coverage, config: parseConfig("").config, resolveTool: createToolResolver({ allowInstall: true, installBudgetMs: null }), only: [spec.scanner] });
    const status = result.scan.scanners[0]!;
    if (status.status === "not_installed" && /Ruby|Go/.test(status.reason ?? "")) { skipped++; process.stdout.write(`${spec.scanner}: ${status.reason}\n`); return; }
    ran++;
    expect(status.status).toBe("ran");
    expect(result.scan.candidates).toContainEqual(expect.objectContaining({ source: spec.scanner, ruleId: spec.rule, filePath: spec.anchor }));
    if (spec.scanner === "gitleaks") expect(JSON.stringify(result.scan)).not.toContain(generatedSecret);
    if (spec.scanner === "osv-scanner") expect(result.scan.candidates.find((c) => c.ruleId === spec.rule)?.lineStart).toBeGreaterThan(1);
  }, 300_000);
});
