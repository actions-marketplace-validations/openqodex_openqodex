// The update worker: `openqodex __update`, started detached by a normal
// command, and `openqodex update` in the foreground. One worker at a time per
// home folder (update.lock); a live holder means this one exits quietly.
// Download and verification happen outside the installer's lock; only the
// switch to the new runtime takes it (activate.ts).
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { extractArchive, openqodexHome, readLock, takeOverStaleLock } from "@openqodex/scanners";
import { loadRecord } from "../agents/record.js";
import { checkRuns, runtimeBin, runtimeDir } from "../launcher.js";
import { activate, activeVersion } from "./activate.js";
import { MIN_AGE_MS, selectCandidates, type UpdateCandidate } from "./candidate.js";
import { fetchAttestations, fetchMetadata, fetchTarball } from "./fetch.js";
import { readState, updateState, updatesAllowed } from "./state.js";
import { verifyRelease } from "./verify.js";

const execFileAsync = promisify(execFile);

// The whole worker ends by this deadline, whatever it is doing.
const LIMIT_MS = 10 * 60_000;
// A release skipped once is tried again after this long.
const RETRY_SKIPPED_MS = 7 * 24 * 60 * 60 * 1000;
const PLAIN_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// Verification failures that mean the trust data embedded in this release no
// longer knows the signing certificate's CA, the log or the timestamp
// authority (a Sigstore key rotation), as opposed to a signature that is
// wrong or a signer that is not this repository's release workflow.
const TRUST_DATA =
  /^the provenance signature does not verify: .*(no trusted certificate path found|key not found|Public key is not valid for timestamp|expected \d+ (SCTs|tlog entries|timestamps))/;

export type WorkerResult = { outcome: "updated" | "none" | "busy" | "off" | "failed"; lines: string[] };

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 300);
}

// The test seam: honoured only with OPENQODEX_E2E=1 (tests/e2e/README.md).
// OPENQODEX_UPDATE_AS selects candidates as if this were that version;
// OPENQODEX_UPDATE_MIN_AGE_MS replaces the 24 hour age rule.
function seam(env: NodeJS.ProcessEnv): { as: string | null; minAge: number | null } {
  if (env.OPENQODEX_E2E !== "1") return { as: null, minAge: null };
  const as = env.OPENQODEX_UPDATE_AS;
  const minAge = Number(env.OPENQODEX_UPDATE_MIN_AGE_MS);
  return {
    as: as !== undefined && PLAIN_VERSION.test(as) ? as : null,
    minAge: env.OPENQODEX_UPDATE_MIN_AGE_MS !== undefined && Number.isFinite(minAge) && minAge >= 0 ? minAge : null,
  };
}

// <home>/update.lock holds "<pid> <token>", created whole through a hard
// link, as the toolchain's install lock is. Null when a live worker holds it.
function takeUpdateLock(home: string): { release: () => void } | null {
  mkdirSync(home, { recursive: true });
  const lock = join(home, "update.lock");
  const token = randomBytes(8).toString("hex");
  const mine = join(home, `.update.lock-${token}`);
  writeFileSync(mine, `${process.pid} ${token}\n`, { mode: 0o600 });
  try {
    let taken = false;
    try {
      linkSync(mine, lock);
      taken = true;
    } catch {
      const holder = readLock(lock);
      const alive = holder !== null && isAlive(holder.pid);
      taken = !alive && takeOverStaleLock(lock, holder, mine, token);
    }
    if (!taken) return null;
    return { release: () => (readLock(lock)?.token === token ? rmSync(lock, { force: true }) : undefined) };
  } finally {
    rmSync(mine, { force: true });
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function latestOf(metadata: unknown): string | null {
  const latest = (metadata as { "dist-tags"?: { latest?: unknown } } | null)?.["dist-tags"]?.latest;
  return typeof latest === "string" && PLAIN_VERSION.test(latest) ? latest : null;
}

// Unpacks a verified tarball beside the runtimes, checks that it runs and
// that it has __refresh, then moves it into <home>/runtime/<version>. A
// runtime folder of that version that the record names is kept as it is;
// one it does not name (left by a worker that was stopped) is replaced.
async function install(home: string, c: UpdateCandidate, tarball: Buffer): Promise<void> {
  const target = runtimeDir(c.version, home);
  const tmp = `${target}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    const archive = join(tmp, "package.tgz");
    writeFileSync(archive, tarball);
    const unpacked = join(tmp, "unpacked");
    mkdirSync(unpacked);
    // Refuses a member that is a link or escapes the folder. Nothing in the
    // package runs at install: the CLI is one bundled file with its assets.
    await extractArchive(archive, "tar.gz", unpacked);
    const pkg = join(unpacked, "package");
    const bin = join(pkg, "dist", "bin.js");
    if (!existsSync(bin)) throw new Error("the release has no dist/bin.js");
    await checkRuns(bin, c.version);
    try {
      await execFileAsync(process.execPath, [bin, "__refresh", "--probe"], { timeout: 30_000 });
    } catch {
      throw new SkipError("it has no __refresh command, so it cannot refresh the agent files it would replace");
    }
    if (loadRecord(home).runtimes.includes(target) && existsSync(runtimeBin(home, c.version))) return;
    const old = `${target}.old-${process.pid}`;
    if (existsSync(target)) renameSync(target, old);
    renameSync(pkg, target);
    rmSync(old, { recursive: true, force: true });
    // The tarball's own times are from 1985; the age rule for keeping
    // runtimes counts from now.
    const now = new Date();
    utimesSync(target, now, now);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// A release that is verified but cannot be activated: recorded in `skipped`.
class SkipError extends Error {}

export async function runUpdateWorker(opts: { anyAge: boolean }): Promise<WorkerResult> {
  const home = openqodexHome();
  const env = process.env;
  const allowed = updatesAllowed(home, env);
  if (!allowed.allowed) return { outcome: "off", lines: [`Updates are ${allowed.why}.`] };
  const lock = takeUpdateLock(home);
  if (lock === null) return { outcome: "busy", lines: ["Another update is running."] };
  const limit = setTimeout(() => {
    lock.release();
    process.exit(2);
  }, LIMIT_MS);
  limit.unref();
  try {
    return await work(home, env, opts.anyAge);
  } catch (error) {
    updateState(home, { lastError: message(error) });
    return { outcome: "failed", lines: [`The update failed: ${message(error)}`] };
  } finally {
    clearTimeout(limit);
    lock.release();
  }
}

async function work(home: string, env: NodeJS.ProcessEnv, anyAge: boolean): Promise<WorkerResult> {
  const now = Date.now();
  updateState(home, { checkedAt: new Date(now).toISOString() });
  const test = seam(env);
  const running = test.as ?? __OPENQODEX_VERSION__;
  const from = activeVersion(home);
  if (from === null) return { outcome: "failed", lines: ["No launcher install here; run npx openqodex init."] };

  let metadata: unknown;
  try {
    metadata = await fetchMetadata();
  } catch (error) {
    updateState(home, { lastError: message(error) });
    return { outcome: "failed", lines: [`Could not read the registry: ${message(error)}`] };
  }
  updateState(home, { latestSeen: latestOf(metadata), latestSeenAt: new Date(now).toISOString() });

  // selectCandidates applies the 24 hour rule itself; a shorter rule is
  // the same as asking it later.
  const minAge = anyAge ? 0 : (test.minAge ?? MIN_AGE_MS);
  const candidates = selectCandidates(metadata, { current: running, now: now + (MIN_AGE_MS - minAge), nodeVersion: process.versions.node });
  if (candidates.length === 0) {
    updateState(home, { lastError: null, trustFailedAt: null });
    return { outcome: "none", lines: [`No newer release than ${running} to install.`] };
  }

  const lines: string[] = [];
  const reasons: string[] = [];
  const skip = (version: string, reason: string): void => {
    reasons.push(reason);
    lines.push(`Skipped ${version}: ${reason}`);
    const skipped = readState(home).skipped.filter((s) => s.version !== version);
    updateState(home, { skipped: [...skipped, { version, reason, at: new Date().toISOString() }] });
  };

  for (const c of candidates) {
    const earlier = readState(home).skipped.find((s) => s.version === c.version && now - Date.parse(s.at) < RETRY_SKIPPED_MS);
    if (earlier) {
      reasons.push(earlier.reason);
      lines.push(`${c.version} was skipped earlier: ${earlier.reason}`);
      continue;
    }
    let tarball: Buffer;
    let attestations: unknown;
    try {
      tarball = await fetchTarball(c.tarball);
      attestations = await fetchAttestations(c.attestationsUrl);
    } catch (error) {
      updateState(home, { lastError: message(error) });
      return { outcome: "failed", lines: [...lines, `Could not download ${c.version}: ${message(error)}`] };
    }
    const verified = verifyRelease({ name: "openqodex", version: c.version, tarball, integrity: c.integrity, attestations });
    if (!verified.ok) {
      skip(c.version, verified.reason);
      continue;
    }
    try {
      await install(home, c, tarball);
    } catch (error) {
      skip(c.version, error instanceof SkipError ? error.message : `it did not install: ${message(error)}`);
      continue;
    }
    const result = await activate({ home, version: c.version, from, env });
    if (!result.ok) {
      updateState(home, { lastError: result.reason });
      return { outcome: "failed", lines: [...lines, `Downloaded and verified ${c.version}, but did not switch to it: ${result.reason}`] };
    }
    updateState(home, { trustFailedAt: null });
    const kept = result.kept.length > 0 ? ` Left as you edited them: ${result.kept.join(", ")}.` : "";
    return { outcome: "updated", lines: [...lines, `Updated to ${c.version} (was ${from}).${kept}`] };
  }

  // Every candidate failed. When each failed because the built-in trust
  // data is out of date, the notice says how to update by hand.
  const trustStale = reasons.length > 0 && reasons.every((r) => TRUST_DATA.test(r));
  updateState(home, { lastError: null, trustFailedAt: trustStale ? new Date(now).toISOString() : null });
  return { outcome: "none", lines: [...lines, `Stayed on ${from}: no newer release could be installed.`] };
}
