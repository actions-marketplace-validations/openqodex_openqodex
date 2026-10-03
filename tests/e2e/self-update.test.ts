import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { bin, git, receipt, root, skipNetwork } from "./support.js";

// The self-update worker against the real npm registry, in a temp HOME
// holding a launcher install of this build made by `init`.
//
// The test seam: OPENQODEX_UPDATE_AS makes the worker select candidates as
// if it ran that version, and OPENQODEX_UPDATE_MIN_AGE_MS shortens the
// 24 hour age rule. Both are honoured only with OPENQODEX_E2E=1. With them a
// worker really downloads the published 0.2.0 tarball, verifies it against
// its real attestations, unpacks it and runs it. 0.2.0 has no __refresh
// command, so activating it would leave old agent files behind: the worker
// skips it with a reason, which is the path these cases prove.
//
// Ways it could fail, written before the code:
//  a. The command that starts the check waits for the worker.
//  b. A release that cannot refresh the agent files is activated, or its
//     unpacked folder is left in the runtime folder.
//  c. A version skipped earlier is downloaded again on the next run.
//  d. The seam works without OPENQODEX_E2E=1.
//  e. With no release newer than the running one, something is installed.

const offline = skipNetwork("self-update");
const version = (JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")) as { version: string }).version;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const SEAM = { OPENQODEX_E2E: "1", OPENQODEX_UPDATE_AS: "0.1.0", OPENQODEX_UPDATE_MIN_AGE_MS: "0" };

type Box = { home: string; oqHome: string; repo: string };
type State = { checkedAt: string | null; latestSeen: string | null; skipped: { version: string; reason: string }[]; lastError: string | null };

function laptop(b: Box, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, HOME: b.home, OPENQODEX_HOME: b.oqHome };
  for (const key of ["CI", "OPENQODEX_OFFLINE", "OPENQODEX_AUTO_UPDATE", "OPENQODEX_E2E", "OPENQODEX_UPDATE_AS", "OPENQODEX_UPDATE_MIN_AGE_MS", "OPENQODEX_LAUNCHER", "CODEX_HOME"]) delete e[key];
  return { ...e, ...extra };
}

function box(): Box {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "oq-update-")));
  const b = { home: join(top, "home"), oqHome: join(top, "home/.openqodex"), repo: join(top, "repo") };
  mkdirSync(b.home, { recursive: true });
  mkdirSync(b.repo, { recursive: true });
  git(b.repo, "init", "-q");
  const r = spawnSync(process.execPath, [bin, "init", "--yes", "--agent", "claude-code", "--hook", "none", "--no-repo"], { cwd: b.repo, env: laptop(b), encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return b;
}

function launch(b: Box, label: string, args: string[], extra: Record<string, string> = {}, input = "") {
  const started = Date.now();
  const r = spawnSync("sh", [join(b.oqHome, "bin/openqodex"), ...args], { cwd: b.repo, env: laptop(b, extra), encoding: "utf8", input, timeout: 600_000 });
  const ms = Date.now() - started;
  const dir = join(receipt, `self-update-${label}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "stdout.txt"), r.stdout ?? "");
  writeFileSync(join(dir, "stderr.txt"), r.stderr ?? "");
  writeFileSync(join(dir, "duration-ms.txt"), `${ms}\n`);
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ms };
}

function state(b: Box): State {
  try {
    return JSON.parse(readFileSync(join(b.oqHome, "update.json"), "utf8")) as State;
  } catch {
    return { checkedAt: null, latestSeen: null, skipped: [], lastError: null };
  }
}

function lockHolder(b: Box): number | null {
  try {
    return Number(readFileSync(join(b.oqHome, "update.lock"), "utf8").trim().split(/\s+/)[0]);
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(offline)("the self-update worker against the real registry", () => {
  let b: Box;
  let parentMs = 0;
  let workerSeenAfterParent = false;
  let workerGoneMs = 0;

  beforeAll(async () => {
    b = box();
    const parent = launch(b, "trigger", ["hook", "check"], SEAM, "{}");
    expect(parent.status).toBe(0);
    parentMs = parent.ms;
    const exitedAt = Date.now();
    // The worker holds update.lock while it works; the parent has exited.
    for (let i = 0; i < 100; i++) {
      const pid = lockHolder(b);
      if (pid !== null && alive(pid)) {
        workerSeenAfterParent = true;
        break;
      }
      await sleep(50);
    }
    for (let i = 0; i < 1200 && lockHolder(b) !== null; i++) await sleep(250);
    workerGoneMs = Date.now() - exitedAt;
  }, 600_000);

  it("a. the command exits without waiting for the worker, which keeps running after it", () => {
    process.stdout.write(`self-update: parent exit ${parentMs} ms, worker finished ${workerGoneMs} ms after it\n`);
    expect(workerSeenAfterParent).toBe(true);
    expect(parentMs).toBeLessThan(5_000);
  });

  it("b. the real 0.2.0 is downloaded, verified, run and then skipped because it cannot refresh the agent files", () => {
    const s = state(b);
    expect(s.checkedAt).not.toBeNull();
    const skip = s.skipped.find((x) => x.version === "0.2.0");
    expect(skip?.reason, JSON.stringify(s)).toMatch(/__refresh/);
    expect(readFileSync(join(b.oqHome, "runtime/current"), "utf8").trim()).toBe(version);
    // No half-unpacked folder is left, and no 0.2.0 runtime unless this build is 0.2.0.
    const left = readdirSync(join(b.oqHome, "runtime"));
    expect(left.filter((n) => n.includes(".tmp-") || n.includes(".old-"))).toEqual([]);
    if (version !== "0.2.0") expect(left).not.toContain("0.2.0");
  });

  it("c. a version skipped earlier is not downloaded again", () => {
    const r = launch(b, "again", ["update", "--now"], SEAM);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/0\.2\.0.*skipped earlier/);
  });

  it("d. the seam is ignored without OPENQODEX_E2E=1", () => {
    const fresh = box();
    const r = launch(fresh, "no-seam", ["update", "--now"], { OPENQODEX_UPDATE_AS: "0.1.0", OPENQODEX_UPDATE_MIN_AGE_MS: "0" });
    expect(r.status, r.stderr).toBe(0);
    // Only the seam makes 0.2.0 a candidate. A release newer than this build
    // (0.2.1 since 2026-10-03) may be tried and skipped; that is not the seam.
    expect(r.stdout).not.toContain("No newer release than 0.1.0");
    expect(state(fresh).skipped.map((x) => x.version)).not.toContain("0.2.0");
  });

  it("e. with no release newer than the running one, nothing is installed and the latest is recorded", () => {
    const fresh = box();
    // Selected as if this were 999.0.0, so no published release is newer.
    const r = launch(fresh, "nothing-newer", ["update"], { OPENQODEX_E2E: "1", OPENQODEX_UPDATE_AS: "999.0.0" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("No newer release than 999.0.0");
    expect(state(fresh).latestSeen).toMatch(/^\d+\.\d+\.\d+$/);
    expect(readFileSync(join(fresh.oqHome, "runtime/current"), "utf8").trim()).toBe(version);
  });
});
