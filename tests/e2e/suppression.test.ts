import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import "./global-setup.js";
import { git, report, reportDir, run, skipNetwork, writeConfig } from "./support.js";
import { removeTempDirs, tempDir } from "../temp-dirs.mjs";

afterAll(removeTempDirs);

// Suppression comments a change adds, through the real scanners: each
// scanner obeys its comment and reports nothing on that line, and the scan
// shows the comment itself as a minor finding instead.

// A repo with one commit holding `base`, then `change` written over it, uncommitted.
function repo(base: Record<string, string>, change: Record<string, string>): string {
  const dir = tempDir("oq-suppress-");
  const write = (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
  };
  write(base);
  git(dir, "init", "-q", "-b", "main"); git(dir, "add", "-A"); git(dir, "commit", "-qm", "Base");
  write(change);
  return dir;
}

const at = (dir: string) => report(dir).findings.map((f) => `${f.source} ${f.file_path}:${f.line_number} ${f.severity}`).sort();
const scanned = (dir: string, scanner: string) => report(dir).scanners.find((s) => s.scanner === scanner)?.status;

describe("an added suppression comment, with the real scanners", () => {
  it("an added # nosec hides bandit's finding on its line, and the scan shows the comment instead", () => {
    const dir = repo(
      { "app/run.py": "import subprocess\n" },
      { "app/run.py": "import subprocess\nsubprocess.call(cmd, shell=True)  # nosec\nsubprocess.call(cmd, shell=True)\n" },
    );
    const out = run("suppress-nosec", dir, ["scan", "--only", "bandit", "--no-install", "--format", "json"]);
    expect(out.status, out.stderr).toBe(0);
    expect(scanned(dir, "bandit")).toBe("ran");
    const line2 = at(dir).filter((f) => f.includes("app/run.py:2 "));
    expect(line2).toEqual(["bandit:openqodex.suppression-added app/run.py:2 minor"]);
    // bandit ran and flags the same call on line 3, which has no comment.
    expect(at(dir).some((f) => f.startsWith("bandit:B602 app/run.py:3 "))).toBe(true);
  });

  it("a # nosec the change did not add raises nothing", () => {
    const dir = repo(
      { "app/run.py": "import os\nsubprocess.call(cmd, shell=True)  # nosec\n" },
      { "app/run.py": "import sys\nsubprocess.call(cmd, shell=True)  # nosec\n" },
    );
    const out = run("suppress-unchanged", dir, ["scan", "--only", "bandit", "--no-install", "--format", "json"]);
    expect(out.status, out.stderr).toBe(0);
    expect(scanned(dir, "bandit")).toBe("ran");
    expect(at(dir)).toEqual([]);
  });

  it("an added shellcheck directive is the scan's only finding, minor, and blocks only at block_on_severity minor", () => {
    const base = { "deploy.sh": "#!/bin/sh\necho start\n" };
    const change = { "deploy.sh": "#!/bin/sh\necho start\n# shellcheck disable=SC2086\necho $A\n" };
    const minor = repo(base, change);
    writeConfig(minor, "review:\n  block_on_severity: minor\n");
    const blocked = run("suppress-block-minor", minor, ["scan", "--only", "shellcheck", "--no-install", "--format", "json"]);
    expect(scanned(minor, "shellcheck")).toBe("ran");
    expect(at(minor)).toEqual(["shellcheck:openqodex.suppression-added deploy.sh:3 minor"]);
    expect(blocked.status, blocked.stderr).toBe(1);
    const major = repo(base, change);
    writeConfig(major, "review:\n  block_on_severity: major\n");
    expect(run("suppress-block-major", major, ["scan", "--only", "shellcheck", "--no-install", "--format", "json"]).status).toBe(0);
  });

  it("gitleaks:allow beside a key: gitleaks stays silent, the comment and semgrep's own finding both stay, and the key is never printed", () => {
    const key = `sk_live_${randomBytes(12).toString("hex")}`;
    const dir = repo({ "app/__init__.py": "" }, { "app/config.py": `STRIPE_KEY = "${key}"  # gitleaks:allow\n` });
    const online = !skipNetwork("semgrep beside gitleaks:allow");
    const only = online ? "gitleaks,semgrep" : "gitleaks";
    const json = run("suppress-gitleaks-json", dir, ["scan", "--only", only, "--no-install", "--format", "json"]);
    expect(json.status, json.stderr).toBe(0);
    expect(scanned(dir, "gitleaks")).toBe("ran");
    const found = at(dir);
    expect(found.filter((f) => f.startsWith("gitleaks:"))).toEqual(["gitleaks:openqodex.suppression-added app/config.py:1 minor"]);
    if (online) {
      expect(scanned(dir, "semgrep")).toBe("ran");
      expect(found.some((f) => f.startsWith("semgrep:") && f.includes("stripe") && f.includes("app/config.py:1 "))).toBe(true);
    }
    const terminal = run("suppress-gitleaks-terminal", dir, ["scan", "--only", only, "--no-install"]);
    const folder = reportDir(dir);
    const files = readdirSync(folder).map((name) => readFileSync(join(folder, name), "utf8"));
    for (const text of [json.stdout, json.stderr, terminal.stdout, terminal.stderr, ...files]) expect(text).not.toContain(key);
  });
});
