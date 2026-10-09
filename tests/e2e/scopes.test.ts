import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "./global-setup.js";
import { demo, git, report, run } from "./support.js";
import { removeTempDirs } from "../temp-dirs.mjs";

afterAll(removeTempDirs);

// Half the planted files committed but not pushed, half left uncommitted, plus
// one gitignored and one untracked copy of the secret file.
describe("change scopes", () => {
  const committed = ["Dockerfile", "scripts/deploy.sh", "package-lock.json"];
  let uncommitted: Set<string>; let upstream: Set<string>; let status: (number | null)[];
  beforeAll(() => {
    const dir = demo("scopes");
    const bare = join(dir, "../remote.git"); git(dir, "init", "--bare", bare);
    git(dir, "remote", "add", "origin", bare); git(dir, "push", "-u", "origin", "HEAD:main");
    git(dir, "add", ...committed); git(dir, "commit", "-qm", "First half");
    writeFileSync(join(dir, ".gitignore"), "ignored-secret.py\n");
    copyFileSync(join(dir, "app/config.py"), join(dir, "ignored-secret.py"));
    mkdirSync(join(dir, "new"), { recursive: true });
    writeFileSync(join(dir, "new/config.py"), readFileSync(join(dir, "app/config.py")));
    const a = run("scope-uncommitted", dir, ["scan", "--uncommitted", "--format", "json"]);
    uncommitted = new Set(report(dir).findings.map((f) => f.file_path));
    const b = run("scope-upstream", dir, ["scan", "--format", "json"]);
    upstream = new Set(report(dir).findings.map((f) => f.file_path));
    status = [a.status, b.status];
  }, 300_000);

  it("--uncommitted reports the working tree and leaves out commits not yet pushed", () => {
    expect(status[0]).toBe(0);
    expect(uncommitted.has("app/config.py")).toBe(true);
    expect(committed.filter((p) => uncommitted.has(p))).toEqual([]);
  });
  it("the default scope reports commits not yet pushed and the working tree", () => {
    expect(status[1]).toBe(0);
    expect(upstream.has("Dockerfile")).toBe(true);
    expect(upstream.has("app/config.py")).toBe(true);
  });
  it("reports an untracked file", () => {
    expect(upstream.has("new/config.py")).toBe(true);
  });
  it("never reports a gitignored file", () => {
    expect(upstream.has("ignored-secret.py")).toBe(false);
  });
});
