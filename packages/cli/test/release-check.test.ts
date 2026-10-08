// The self-update check that runs after every publish: it runs published
// packages, so it must hold nothing they could misuse.
//
// Ways it could fail, written before the code:
//  1. The check runs in the job that holds the npm token, the OIDC id-token
//     permission or a GITHUB_TOKEN that can write, so a package it runs could
//     publish, tag or push; or it runs before the publish, or can stop it.
//  2. An action in the release workflow is named by a tag its owner can move,
//     not by a commit.
//  3. The check job checks out anything but this repository's tag of the new
//     version, or keeps the checkout's credentials in .git/config.
//  4. A secret of the job (NPM_TOKEN, NODE_AUTH_TOKEN, GITHUB_TOKEN, the
//     Actions OIDC request token, a cloud key) reaches a package the check
//     runs, because the environment it spawns with is the job's, not one
//     built from an allowlist.
//  5. Code of a release runs before its provenance verified as this
//     repository's release workflow on main (tests/e2e/release-check.test.ts,
//     which needs the registry).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
type Step = { uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, unknown> };
type Job = { needs?: string | string[]; if?: string; permissions?: Record<string, string>; steps: Step[]; outputs?: Record<string, string> };
const workflow = parse(readFileSync(join(root, ".github/workflows/release.yml"), "utf8")) as { permissions?: Record<string, string>; jobs: Record<string, Job> };
const checkJob = Object.entries(workflow.jobs).find(([, job]) => job.steps.some((s) => s.run?.includes("check-self-update.mjs")));

describe("the self-update check in the release workflow", () => {
  it("runs in a job of its own after the publish, with a read-only token and no secret (failure 1)", () => {
    expect(checkJob, "a job runs scripts/check-self-update.mjs").toBeDefined();
    const [name, job] = checkJob!;
    expect(name).not.toBe("release");
    expect(job.needs).toBe("release");
    expect(job.permissions).toEqual({ contents: "read" });
    const text = JSON.stringify(job);
    expect(text).not.toMatch(/secrets\./);
    expect(text).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN|id-token|registry-url/);
    // The publishing job never waits on it.
    expect(workflow.jobs.release!.needs).toBeUndefined();
    expect(workflow.jobs.release!.steps.some((s) => s.run?.includes("check-self-update.mjs"))).toBe(false);
  });

  it("names every action by a full commit sha (failure 2)", () => {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      for (const s of job.steps.filter((x) => x.uses !== undefined)) expect(s.uses, name).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    }
  });

  it("checks out only this repository's tag of the new version, without credentials (failure 3)", () => {
    const [, job] = checkJob!;
    const checkouts = job.steps.filter((s) => s.uses?.startsWith("actions/checkout@"));
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0]!.with).toEqual({ ref: "refs/tags/v${{ needs.release.outputs.version }}", "persist-credentials": false });
  });
});

describe("the environment of what the check runs", () => {
  it("is built from an allowlist: no token, key or Actions variable of the job passes (failure 4)", async () => {
    const { cleanEnv } = (await import(join(root, "scripts/self-update-check-lib.mjs"))) as { cleanEnv: (base: NodeJS.ProcessEnv, set: Record<string, string>) => NodeJS.ProcessEnv };
    const job = {
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      HOME: "/home/runner",
      NPM_TOKEN: "npm_x",
      NODE_AUTH_TOKEN: "npm_x",
      GITHUB_TOKEN: "ghs_x",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "x",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://x",
      ACTIONS_RUNTIME_TOKEN: "x",
      AWS_SECRET_ACCESS_KEY: "x",
      NPM_CONFIG_PROVENANCE: "true",
      CI: "true",
    };
    expect(cleanEnv(job, { HOME: "/tmp/box/home" })).toEqual({ PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", HOME: "/tmp/box/home" });
  });

  it("is the one every process the script starts gets: the script never passes its own environment on (failure 4)", () => {
    const script = readFileSync(join(root, "scripts/check-self-update.mjs"), "utf8");
    expect(script).not.toMatch(/\.\.\.process\.env/);
    // One place starts processes, and it passes the allowlisted environment.
    expect(script.match(/\bspawnSync\(/g)).toHaveLength(1);
    expect(script).toMatch(/spawnSync\([^;]*env: cleanEnv\(process\.env, /);
    expect(script).not.toMatch(/\b(spawn|exec|execFile|execSync|execFileSync|fork)\(/);
  });
});
