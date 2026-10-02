import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import "./global-setup.js";
import { demo, git, run, writeConfig } from "./support.js";

// `hook install` and a real `git push` to a local bare remote.
describe("git pre-push hook", () => {
  let dir: string; let home: string; let remote: string;
  const remoteHead = () => git(remote, "rev-parse", "main").trim();
  beforeAll(() => {
    dir = demo("git-hook"); home = mkdtempSync(join(tmpdir(), "oq-hook-home-")); remote = join(dir, "../hook-remote.git");
    git(dir, "init", "--bare", remote);
    git(dir, "remote", "add", "origin", remote);
    const installed = run("git-hook-install", dir, ["hook", "install"], { home });
    if (installed.status !== 0) throw new Error(installed.stderr);
    git(dir, "push", "-u", "origin", "HEAD:main");
    git(dir, "add", "-A"); git(dir, "commit", "-qm", "Planted change");
  }, 300_000);

  it("prints the scan and lets the push through when nothing blocks", () => {
    const push = run("git-hook-warn-push", dir, ["git push origin HEAD:main"], { shell: true, home });
    expect(push.stdout + push.stderr).toContain("hadolint:DL3007");
    expect(push.status).toBe(0);
    expect(remoteHead()).toBe(git(dir, "rev-parse", "HEAD").trim());
  });
  it("refuses the push when block_on_severity: major is met", () => {
    writeConfig(dir, "review:\n  block_on_severity: major\n");
    const config = join(dir, "app/config.py");
    writeFileSync(config, readFileSync(config, "utf8").replace(/sk_live_([A-Za-z0-9])/, (_, c: string) => `sk_live_${c === "A" ? "B" : "A"}`));
    git(dir, "add", "-A"); git(dir, "commit", "-qm", "Change the secret");
    const before = remoteHead();
    const refused = run("git-hook-block-push", dir, ["git push origin HEAD:main"], { shell: true, home });
    expect(refused.status).not.toBe(0);
    expect(remoteHead()).toBe(before);
  });
});
