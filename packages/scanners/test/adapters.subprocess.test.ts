// Real binaries on tiny planted inputs, one case per builtin scanner: each
// guards that scanner's invocation, output parser, changed-line filter and tool
// resolution together. Run by the end-to-end config, not the unit config.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseConfig } from "@openqodex/core";
import type { BuiltinScanner } from "@openqodex/core";
import { createToolResolver, runScanners } from "@openqodex/scanners";
import { cacheFolder, removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

const scannerHome = process.env.OPENQODEX_E2E_HOME ?? cacheFolder("openqodex-e2e-home");
process.env.OPENQODEX_HOME = scannerHome;
process.env.HOME = tempDir("oq-adapter-user-");

const generatedSecret = `sk_live_${randomBytes(12).toString("hex")}`;
// A React page whose effect reads `id` and leaves it out of its dependencies.
const REACT_PAGE = `import { useEffect, useState } from "react";
export default function Page({ id }: { id: string }) {
  const [data, setData] = useState<string | null>(null);
  useEffect(() => {
    fetch(\`/api/\${id}\`).then((r) => r.text()).then(setData);
  }, []);
  return <p>{data}</p>;
}
`;

// runtime: the language runtime a scanner needs that this machine may lack, and
// the reason the product must give when it is missing.
type Case = { scanner: BuiltinScanner; rule: string; files: Record<string, string>; anchor: string; runtime?: RegExp; network?: true };
const cases: Case[] = [
  { scanner: "gitleaks", rule: "stripe-access-token", files: { "config.py": `STRIPE_KEY = '${generatedSecret}'\n` }, anchor: "config.py" },
  { scanner: "osv-scanner", rule: "GHSA-p6mc-m468-83gw", files: { "package-lock.json": JSON.stringify({ name: "tiny", lockfileVersion: 2, packages: { "": { name: "tiny" }, "node_modules/lodash": { version: "4.17.15" } } }, null, 2) }, anchor: "package-lock.json", network: true },
  { scanner: "sqllint", rule: "security-definer-no-search-path", files: { "db/unsafe.sql": "CREATE FUNCTION public.do_thing() RETURNS void\nLANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN END $$;\n" }, anchor: "db/unsafe.sql" },
  { scanner: "semgrep", rule: "python.lang.security.audit.formatted-sql-query.formatted-sql-query", files: { "search.py": `import sqlite3
from flask import request
def query():
    user = request.args.get("name")
    db = sqlite3.connect("test.db")
    return db.execute(f"SELECT * FROM users WHERE name = '{user}'")
` }, anchor: "search.py", network: true },
  { scanner: "actionlint", rule: "expression", files: { ".github/workflows/ci.yml": "on: pull_request\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ${{ github.event.pull_request.title }}\n" }, anchor: ".github/workflows/ci.yml" },
  { scanner: "hadolint", rule: "DL3007", files: { Dockerfile: "FROM python:latest\n" }, anchor: "Dockerfile" },
  { scanner: "shellcheck", rule: "SC2086", files: { "deploy.sh": "#!/bin/sh\necho $FOO\n" }, anchor: "deploy.sh" },
  { scanner: "ruff", rule: "F401", files: { "main.py": "import os\n" }, anchor: "main.py" },
  { scanner: "brakeman", rule: "SQL", files: { Gemfile: "source 'https://rubygems.org'\ngem 'rails'\n", "config/application.rb": "require 'rails/all'\nmodule Tiny\n  class Application < Rails::Application\n  end\nend\n", "app/controllers/users_controller.rb": "class UsersController < ApplicationController\n  def index\n    User.where(\"name = '#{params[:name]}'\")\n  end\nend\n" }, anchor: "app/controllers/users_controller.rb", runtime: /^needs Ruby/ },
  { scanner: "rubocop", rule: "Lint/UselessAssignment", files: { "app.rb": "unused = 1\n" }, anchor: "app.rb", runtime: /^needs Ruby/ },
  { scanner: "bandit", rule: "B608", files: { "search.py": "def query(user):\n    return f'SELECT * FROM users WHERE name = {user}'\n" }, anchor: "search.py" },
  { scanner: "oxlint", rule: "eslint/no-debugger", files: { "main.js": "debugger;\n" }, anchor: "main.js" },
  // Framework rules the project's manifest switches on (detect.ts): oxlint's
  // react plugin in a React project, ruff's DJ rules in a Django one.
  { scanner: "oxlint", rule: "react-hooks/exhaustive-deps", files: { "web/package.json": JSON.stringify({ dependencies: { react: "18.3.1" } }), "web/page.tsx": REACT_PAGE }, anchor: "web/page.tsx" },
  { scanner: "ruff", rule: "DJ001", files: { "requirements.txt": "Django==5.0\n", "shop/models.py": "from django.db import models\n\n\nclass Item(models.Model):\n    name = models.CharField(max_length=10, null=True)\n\n    def __str__(self):\n        return self.name\n" }, anchor: "shop/models.py" },
  { scanner: "golangci", rule: "gosec", files: { "go.mod": "module example.com/tiny\n\ngo 1.22\n", "main.go": "package main\nimport \"crypto/md5\"\nfunc main() { _ = md5.New() }\n" }, anchor: "main.go", runtime: /^needs Go/ },
];

// Every line of every planted file counts as changed, as for a new file.
async function scan(spec: Case) {
  const repo = tempDir(`oq-adapter-${spec.scanner}-`);
  for (const [name, body] of Object.entries(spec.files)) { const path = join(repo, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); }
  const paths = Object.keys(spec.files);
  const coverage = new Map(paths.map((p) => [p, new Set(readFileSync(join(repo, p), "utf8").split("\n").map((_, i) => i + 1))]));
  return runScanners({ repoDir: repo, changedPaths: paths, coverage, config: parseConfig("").config, resolveTool: createToolResolver({ allowInstall: true, installBudgetMs: null }), only: [spec.scanner] });
}

let ran = 0; let skipped = 0;
afterAll(() => {
  process.stdout.write(`${ran} ran, ${skipped} skipped\n`);
  if (process.env.CI) expect(skipped, "a builtin scanner was skipped under CI").toBe(0);
});
// Vitest runs the last registered after-all hook first, and a hook that
// throws stops the rest: registered here, the cleanup runs before the check
// above, so a failed check still removes this file's temp folders.
afterAll(removeTempDirs);
describe("builtin scanner subprocesses", () => {
  for (const spec of cases) it(`${spec.scanner} reports ${spec.rule} on a changed line`, async () => {
    if (spec.network && process.env.OPENQODEX_E2E_OFFLINE === "1") {
      skipped++; process.stdout.write(`${spec.scanner}: skipped, OPENQODEX_E2E_OFFLINE=1\n`); return;
    }
    const result = await scan(spec);
    const status = result.scan.scanners[0]!;
    // A missing runtime is reported with its reason and the case is skipped.
    if (spec.runtime && status.status === "not_installed") {
      expect(status.reason).toMatch(spec.runtime);
      skipped++; process.stdout.write(`${spec.scanner}: ${status.reason}\n`); return;
    }
    ran++;
    expect(status.status).toBe("ran");
    expect(result.scan.candidates).toContainEqual(expect.objectContaining({ source: spec.scanner, ruleId: spec.rule, filePath: spec.anchor }));
  }, 300_000);

  // golangci-lint caches issues by package content and replays the first
  // folder's absolute paths for the same package elsewhere (two worktrees of
  // one repo), which matched no changed line, so the second scan read clean.
  it("golangci reports gosec in a second checkout of the same package", async () => {
    const spec = cases.find((c) => c.scanner === "golangci")!;
    const first = await scan(spec);
    if (first.scan.scanners[0]!.status === "not_installed") { process.stdout.write(`golangci: ${first.scan.scanners[0]!.reason}\n`); return; }
    const second = await scan(spec);
    expect(second.scan.candidates).toContainEqual(expect.objectContaining({ source: "golangci", ruleId: spec.rule, filePath: spec.anchor }));
  }, 300_000);

  it("oxlint's React rules stay off for a file outside a React project, and the run says which files had them", async () => {
    const spec: Case = {
      scanner: "oxlint",
      rule: "",
      files: {
        "web/package.json": JSON.stringify({ dependencies: { react: "18.3.1" } }),
        "web/page.tsx": REACT_PAGE,
        "api/package.json": JSON.stringify({ dependencies: { express: "4.21.0" } }),
        "api/hooks.tsx": REACT_PAGE,
      },
      anchor: "",
    };
    const result = await scan(spec);
    expect(result.scan.scanners[0]!.status).toBe("ran");
    const deps = result.scan.candidates.filter((c) => c.ruleId === "react-hooks/exhaustive-deps").map((c) => c.filePath);
    expect(deps).toEqual(["web/page.tsx"]);
    expect([...(result.checked.get("oxlint:react-hooks/exhaustive-deps") ?? [])]).toEqual(["web/page.tsx"]);
  }, 300_000);

  // osv-scanner 2 asks deps.dev and sends file hashes unless told not to;
  // OpenQodex promises names and versions to osv.dev only. A proxy that
  // logs every host the scan opens a tunnel to holds that promise.
  it("osv-scanner reads a bun.lock and opens api.osv.dev only", async () => {
    if (process.env.OPENQODEX_E2E_OFFLINE === "1") return;
    const hosts: string[] = [];
    const proxy = http.createServer((_req, res) => res.writeHead(403).end());
    proxy.on("connect", (req, socket, head) => {
      const [host, port] = (req.url ?? "").split(":");
      hosts.push(host ?? "");
      const upstream = net.connect(Number(port), host, () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
    });
    await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
    const { port } = proxy.address() as net.AddressInfo;
    const saved = { HTTPS_PROXY: process.env.HTTPS_PROXY, HTTP_PROXY: process.env.HTTP_PROXY };
    process.env.HTTPS_PROXY = `http://127.0.0.1:${port}`;
    process.env.HTTP_PROXY = `http://127.0.0.1:${port}`;
    try {
      // Resolved first, outside the proxy, so the download is not counted.
      await createToolResolver({ allowInstall: true, installBudgetMs: null })("osv-scanner");
      hosts.length = 0;
      const bun = '{\n  "lockfileVersion": 1,\n  "workspaces": { "": { "name": "tiny", "dependencies": { "lodash": "4.17.15" } } },\n  "packages": {\n    "lodash": ["lodash@4.17.15", "", {}, "sha512-x"]\n  }\n}\n';
      const pom = "<project><modelVersion>4.0.0</modelVersion><groupId>a</groupId><artifactId>b</artifactId><version>1</version><dependencies><dependency><groupId>org.apache.logging.log4j</groupId><artifactId>log4j-core</artifactId><version>2.14.1</version></dependency></dependencies></project>\n";
      const result = await scan({ scanner: "osv-scanner", rule: "", files: { "bun.lock": bun, "pom.xml": pom }, anchor: "" });
      expect(result.scan.scanners[0]!.status).toBe("ran");
      expect(result.scan.candidates).toContainEqual(expect.objectContaining({ source: "osv-scanner", ruleId: "GHSA-p6mc-m468-83gw", filePath: "bun.lock" }));
      expect([...new Set(hosts)]).toEqual(["api.osv.dev"]);
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
      proxy.close();
    }
  }, 300_000);

  it("gitleaks finds a secret and never puts its value in the scan result", async () => {
    const result = await scan(cases[0]!);
    expect(result.scan.candidates.some((c) => c.ruleId === "stripe-access-token")).toBe(true);
    expect(JSON.stringify(result.scan)).not.toContain(generatedSecret);
  }, 300_000);
});
