import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractArchive } from "../../packages/scanners/src/toolchain/fetch.js";
import { fetchAttestations, fetchTarball } from "../../packages/cli/src/update/fetch.js";
import { verifyRelease } from "../../packages/cli/src/update/verify.js";
import { verifiedRelease } from "../../scripts/self-update-check-lib.mjs";
import { bin, git, receipt, root, skipNetwork } from "./support.js";
import { removeTempDirs, tempDir } from "../temp-dirs.mjs";

afterAll(removeTempDirs);

// The whole update chain against the real npm registry, in a temp HOME.
//
// `init` from this build installs the launcher; the test then turns that
// install into one that runs 0.1.0: the installed runtime with its version
// string changed, in runtime/0.1.0, named by the active record. A normal
// command through the launcher starts the detached worker, which reads the
// real registry metadata, downloads the newest published release, checks
// its integrity and its Sigstore provenance, unpacks it, starts it, and
// activates it through the commit boundary. The seam (honoured only with
// OPENQODEX_E2E=1) only shortens the 24 hour age rule and pins the version
// the worker chooses from, and so the contract it keeps: 0.1.0 declares
// none, so the daily worker installs the newest release that declares none
// either and leaves any later one for a foreground update. Verification is
// never skipped. Released versions
// do not know this build's record format, so after the activation only the
// record, the folder and `--version` are read, then this build rolls back.
//
// Ways it could fail, written before the code:
//  a. The command that starts the check waits for the worker.
//  b. A verified release is downloaded but never activated, or the launcher
//     does not run it afterwards, or an unpacked temp folder is left.
//  c. Rollback after a real activation leaves the launcher on the new version.
//  d. The seam works without OPENQODEX_E2E=1.
//  e. With no release newer than the running one, something is installed.
//  f. A rollback by this build to a runtime that cannot read skip_version
//     (the real 0.7.1, checked as the updater checks a release) leaves
//     updates on, so that runtime would install the release just left.

const offline = skipNetwork("self-update");
const version = (JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")) as { version: string }).version;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const FROM = "0.1.0";
const SEAM = { OPENQODEX_E2E: "1", OPENQODEX_UPDATE_AS: FROM, OPENQODEX_UPDATE_MIN_AGE_MS: "0" };

type Box = { home: string; oqHome: string; repo: string };

function laptop(b: Box, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, HOME: b.home, OPENQODEX_HOME: b.oqHome };
  for (const key of ["CI", "OPENQODEX_OFFLINE", "OPENQODEX_AUTO_UPDATE", "OPENQODEX_E2E", "OPENQODEX_UPDATE_AS", "OPENQODEX_UPDATE_MIN_AGE_MS", "OPENQODEX_LAUNCHER", "CODEX_HOME", "CLAUDE_CONFIG_DIR"]) delete e[key];
  return { ...e, ...extra };
}

function box(): Box {
  const top = realpathSync(tempDir("oq-update-"));
  const b = { home: join(top, "home"), oqHome: join(top, "home/.openqodex"), repo: join(top, "repo") };
  mkdirSync(b.home, { recursive: true });
  mkdirSync(b.repo, { recursive: true });
  git(b.repo, "init", "-q");
  const r = spawnSync(process.execPath, [bin, "init", "--yes", "--agent", "claude-code", "--hook", "none", "--no-repo"], { cwd: b.repo, env: laptop(b), encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return b;
}

// The install as one of 0.1.0: this build's runtime with its version string
// changed, the only runtime there, named by the active record.
function asOld(b: Box): string {
  const rt = (v: string): string => join(b.oqHome, "runtime", v);
  cpSync(rt(version), rt(FROM), { recursive: true });
  const file = join(rt(FROM), "dist/bin.js");
  writeFileSync(file, readFileSync(file, "utf8").replaceAll(`"${version}"`, `"${FROM}"`));
  rmSync(rt(version), { recursive: true });
  writeFileSync(join(b.oqHome, "runtime/current"), `${FROM}\n\n`);
  return file;
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

const record = (b: Box): string[] => readFileSync(join(b.oqHome, "runtime/current"), "utf8").split("\n").slice(0, 2);
function state(b: Box): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(join(b.oqHome, "update.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

describe.skipIf(offline)("the self-update against the real registry", () => {
  let b: Box;
  let oldBin = "";
  let latest = "";
  let parentMs = 0;
  let activatedMs = -1;

  beforeAll(async () => {
    const meta = (await (await fetch("https://registry.npmjs.org/openqodex")).json()) as { versions: Record<string, { openqodex?: unknown; deprecated?: unknown }> };
    // The newest release that, like 0.1.0, declares no contract.
    const plain = Object.entries(meta.versions)
      .filter(([v, m]) => /^\d+\.\d+\.\d+$/.test(v) && m.openqodex === undefined && !m.deprecated)
      .map(([v]) => v.split(".").map(Number))
      .sort((a, b) => b[0]! - a[0]! || b[1]! - a[1]! || b[2]! - a[2]!);
    latest = plain[0]!.join(".");
    b = box();
    oldBin = asOld(b);
    expect(launch(b, "before", ["--version"]).stdout.trim()).toBe(FROM);
    const parent = launch(b, "trigger", ["hook", "check"], SEAM, "{}");
    expect(parent.status).toBe(0);
    parentMs = parent.ms;
    const exitedAt = Date.now();
    // The worker is detached: the parent has exited, the switch comes later.
    for (let i = 0; i < 2400; i++) {
      if (record(b)[0] !== FROM) {
        activatedMs = Date.now() - exitedAt;
        break;
      }
      if (typeof state(b).lastError === "string") break;
      await sleep(250);
    }
  }, 700_000);

  it("a. the command exits without waiting for the worker, which keeps running after it", () => {
    process.stdout.write(`self-update: parent exit ${parentMs} ms, ${latest} active ${activatedMs} ms after it\n`);
    expect(parentMs).toBeLessThan(5_000);
    expect(activatedMs, JSON.stringify(state(b))).toBeGreaterThan(0);
  });

  it("b. the newest published release is downloaded, verified, started and activated; the launcher runs it", () => {
    expect(record(b), JSON.stringify(state(b))).toEqual([latest, FROM]);
    const pkg = JSON.parse(readFileSync(join(b.oqHome, "runtime", latest, "package.json"), "utf8")) as { name: string; version: string };
    expect(pkg).toMatchObject({ name: "openqodex", version: latest });
    expect(launch(b, "after", ["--version"]).stdout.trim()).toBe(latest);
    expect(readdirSync(join(b.oqHome, "runtime")).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  it("c. rollback by this build after the real activation puts the launcher back on the old version", () => {
    const r = spawnSync(process.execPath, [oldBin, "update", "--rollback"], { cwd: b.repo, env: laptop(b, { OPENQODEX_LAUNCHER: oldBin }), encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(record(b)).toEqual([FROM, latest]);
    expect(launch(b, "rolled-back", ["--version"]).stdout.trim()).toBe(FROM);
  });

  it("d. the seam is ignored without OPENQODEX_E2E=1", () => {
    const fresh = box();
    const r = launch(fresh, "no-seam", ["update", "--now"], { OPENQODEX_UPDATE_AS: FROM, OPENQODEX_UPDATE_MIN_AGE_MS: "0" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toContain(`No newer release than ${FROM}`);
    expect(record(fresh)[0]).not.toBe("0.2.0");
  });

  it("e. with no release newer than the running one, nothing is installed and the latest is recorded", () => {
    const fresh = box();
    // Selected as if this were 999.0.0, so no published release is newer.
    const r = launch(fresh, "nothing-newer", ["update"], { OPENQODEX_E2E: "1", OPENQODEX_UPDATE_AS: "999.0.0" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("No newer release than 999.0.0");
    expect(state(fresh).latestSeen).toMatch(/^\d+\.\d+\.\d+$/);
    expect(record(fresh)[0]).toBe(version);
  });

  it("f. a rollback to the real 0.7.1, which cannot read skip_version, turns updates off instead", async () => {
    const fresh = box();
    const legacy = "0.7.1";
    const meta = (await (await fetch("https://registry.npmjs.org/openqodex")).json()) as { versions: Record<string, unknown> };
    const unpacked = realpathSync(tempDir("oq-legacy-"));
    await verifiedRelease(legacy, meta, unpacked, { fetchAttestations, fetchTarball, verifyRelease, extractArchive });
    cpSync(join(unpacked, "package"), join(fresh.oqHome, "runtime", legacy), { recursive: true });
    // This build active, the real 0.7.1 as the version before it.
    writeFileSync(join(fresh.oqHome, "runtime/current"), `${version}\n${legacy}\n`);
    const r = launch(fresh, "rollback-legacy", ["update", "--rollback"]);
    expect(r.status, r.stderr).toBe(0);
    expect(record(fresh)).toEqual([legacy, version]);
    expect(readFileSync(join(fresh.oqHome, "config.yaml"), "utf8")).toMatch(/^update: off$/m);
    expect(launch(fresh, "rollback-legacy-version", ["--version"]).stdout.trim()).toBe(legacy);
  }, 300_000);
});
