// The update worker: `openqodex __update`, started detached by a normal
// command, and `openqodex update` in the foreground. Everything slow happens
// first, outside any lock: the registry metadata, the tarball, its
// attestations, verification, unpacking and a test start. Then one short
// step inside the commit boundary (agents/lock.ts) checks again that the
// switch is still wanted and publishes it: the runtime folder by a rename,
// then the active record by a rename. A crash between the two leaves the old
// version active and the new folder ready for the next run.
import { existsSync, readFileSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { extractArchive, openqodexHome } from "@openqodex/scanners";
import { BoundaryError, withBoundary } from "../agents/lock.js";
import { homeGuard } from "../agents/guarded-fs.js";
import { contractOf, contractText, runningContract, sameContract, type Contract } from "../contract.js";
import { activeVersion, checkRuns, identicalTree, launcherPath, launcherRunner, pruneRuntimes, runtimeDir, tempRuntimes, writeActive } from "../launcher.js";
import { byContract, contractChange, MIN_AGE_MS, selectCandidates } from "./candidate.js";
import { fetchAttestations, fetchMetadata, fetchTarball } from "./fetch.js";
import { readState, skipVersion, updateState, updatesAllowed, type UpdateState } from "./state.js";
import { verifyRelease } from "./verify.js";

// The whole worker ends by this deadline, whatever it is doing.
const LIMIT_MS = 10 * 60_000;
// A release skipped once is tried again after this long.
const RETRY_SKIPPED_MS = 7 * 24 * 60 * 60 * 1000;
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const PLAIN_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// Verification failures that mean the trust data embedded in this release no
// longer knows the signing certificate's CA, the log or the timestamp
// authority (a Sigstore key rotation), as opposed to a signature that is
// wrong or a signer that is not this repository's release workflow.
const TRUST_DATA =
  /^the provenance signature does not verify: .*(no trusted certificate path found|key not found|Public key is not valid for timestamp|expected \d+ (SCTs|tlog entries|timestamps))/;

export type WorkerResult = { outcome: "updated" | "none" | "busy" | "off" | "failed"; lines: string[] };

class SkipError extends Error {}

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

// The second test seam, also only with OPENQODEX_E2E=1: at the named stage
// the worker writes <home>/update-paused and waits until a test removes it
// (or kills the process). Stages: before-metadata, before-boundary,
// in-boundary, after-publish.
async function pauseAt(home: string, stage: string, env: NodeJS.ProcessEnv): Promise<void> {
  if (env.OPENQODEX_E2E !== "1" || env.OPENQODEX_UPDATE_PAUSE !== stage) return;
  const flag = join(home, "update-paused");
  homeGuard(home).write(flag, `${stage}\n`);
  while (existsSync(flag)) await new Promise((r) => setTimeout(r, 50));
}

function latestOf(metadata: unknown): string | null {
  const latest = (metadata as { "dist-tags"?: { latest?: unknown } } | null)?.["dist-tags"]?.latest;
  return typeof latest === "string" && PLAIN_VERSION.test(latest) ? latest : null;
}

function newer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

// Unpacks a verified tarball into <home>/runtime/<version>.tmp-<pid>/,
// compares the contract its package.json declares with `contract`, the one
// the registry claimed, and only then checks that it starts and prints its
// version: nothing of a release runs before that comparison. Returns that
// temp folder; the package is in its unpacked/package. activateUnpacked
// publishes it and removes the temp folder. Every folder and file of its
// own goes through the strict home guard (guarded-fs.ts): no link at all
// under runtime/, and nothing outside OpenQodex's home. tar unpacks inside
// the folder the guard made.
export async function unpackRelease(home: string, version: string, tarball: Buffer, contract: Contract | null): Promise<string> {
  const guard = homeGuard(home, true);
  const tmp = `${runtimeDir(version, home)}.tmp-${process.pid}`;
  guard.removeTree(tmp);
  guard.makeFolder(tmp);
  try {
    const archive = join(tmp, "package.tgz");
    guard.write(archive, tarball, { mode: 0o600 });
    const unpacked = join(tmp, "unpacked");
    guard.makeFolder(unpacked);
    // Refuses a member that is a link or escapes the folder. Nothing in the
    // package runs at install: the CLI is one bundled file with its assets.
    await extractArchive(archive, "tar.gz", unpacked);
    const declared = unpackedContract(tmp);
    if (!sameContract(declared, contract)) throw new Error(`its package.json declares contract ${contractText(declared)}, the registry ${contractText(contract)}`);
    const bin = join(unpacked, "package", "dist", "bin.js");
    if (!existsSync(bin)) throw new Error("the release has no dist/bin.js");
    await checkRuns(bin, version);
    return tmp;
  } catch (error) {
    guard.removeTree(tmp);
    throw error;
  }
}

// activated: the record names `version`. refused: the switch is no longer
// wanted (updates off, another switch happened, nothing newer). skip: this
// release cannot be used here. gone: OpenQodex was uninstalled meanwhile.
// busy: another process holds the boundary. failed: the boundary or a write failed.
export type ActivateResult = { outcome: "activated" | "refused" | "skip" | "gone" | "busy" | "failed"; reason: string };

// The contract the unpacked package declares in its package.json: the
// signed bytes, where the registry's metadata is only what npm says.
function unpackedContract(tmp: string): Contract | null {
  try {
    return contractOf(JSON.parse(readFileSync(join(tmp, "unpacked", "package", "package.json"), "utf8")));
  } catch {
    return null;
  }
}

// The commit step for a verified, unpacked release in `tmp` (unpackRelease),
// started from the active version `from` by a worker of version `running`.
// Always removes `tmp`. `contract`: the contract the registry said the
// release declares; the release's own package.json must declare the same,
// or it is skipped. `keep`: the contract a daily worker keeps; absent for a
// foreground update, which may cross one.
//
// Inside the boundary everything that decides the switch is read again: the
// user config as a whole (updates on, skip_version), the active version,
// which must still be both `from` and the worker's own, and the contract.
export async function activateUnpacked(opts: {
  home: string;
  version: string;
  from: string;
  running: string;
  tmp: string;
  env: NodeJS.ProcessEnv;
  wait: number;
  contract: Contract | null;
  keep?: Contract | null;
}): Promise<ActivateResult> {
  const { home, version, from, tmp, env } = opts;
  const guard = homeGuard(home, true);
  let result: ActivateResult;
  try {
    const declared = unpackedContract(tmp);
    if (!sameContract(declared, opts.contract)) {
      throw new SkipError(`its package.json declares contract ${contractText(declared)}, the registry ${contractText(opts.contract)}`);
    }
    await pauseAt(home, "before-boundary", env);
    result = await withBoundary(home, { wait: opts.wait }, async (): Promise<ActivateResult> => {
      await pauseAt(home, "in-boundary", env);
      const allowed = updatesAllowed(home, env);
      if (!allowed.allowed) return { outcome: "refused", reason: `updates were turned ${allowed.why}` };
      if (!existsSync(launcherPath(home))) return { outcome: "gone", reason: "openqodex was uninstalled" };
      const active = activeVersion(home);
      if (active !== from) return { outcome: "refused", reason: `the active version is ${active ?? "unknown"}, not ${from}: another update, rollback or init ran` };
      if (active !== opts.running) return { outcome: "refused", reason: `the active version is ${active}, not ${opts.running}, the version of this update: a rollback or another switch ran` };
      if (!newer(version, active)) return { outcome: "refused", reason: `${version} is not newer than the active ${active}` };
      const skip = skipVersion(home);
      if (skip !== null && !newer(version, skip)) return { outcome: "refused", reason: `skip_version is ${skip}, so ${version} is not installed` };
      if (opts.keep !== undefined && !sameContract(opts.contract, opts.keep)) {
        return { outcome: "refused", reason: `${version} changes ${contractChange(opts.contract, opts.keep)}; it waits for openqodex update` };
      }
      const target = runtimeDir(version, home);
      if (existsSync(target)) {
        if (!identicalTree(join(tmp, "unpacked", "package"), target)) return { outcome: "skip", reason: `${target} holds a different copy of ${version}; it was left as it is` };
      } else {
        guard.rename(join(tmp, "unpacked", "package"), target);
        // The tarball's own times are from 1985; the age rule counts from now.
        const now = new Date();
        utimesSync(target, now, now);
      }
      await pauseAt(home, "after-publish", env);
      // The commit. What follows is a cache: its failure changes no outcome.
      writeActive(home, { current: version, previous: active });
      try {
        updateState(home, { lastError: null, notice: { version, from: active, text: `openqodex updated to ${version} (was ${active}). Roll back: openqodex update --rollback` } });
      } catch {
        // the notice is lost; the switch stands
      }
      // Inside the boundary it holds, as init and the foreground update do:
      // runtimes older than 7 days other than the baked-in, current and
      // previous ones. Never fails the switch.
      pruneRuntimes(home, Date.now(), guard);
      return { outcome: "activated", reason: `Updated to ${version} (was ${active}).` };
    });
  } catch (error) {
    if (error instanceof SkipError) result = { outcome: "skip", reason: error.message };
    else result = { outcome: error instanceof BoundaryError && error.held ? "busy" : "failed", reason: message(error) };
  }
  try {
    guard.removeTree(tmp);
    // Uninstall removed the runtime folder's contents; leave no empty folder behind.
    if (result.outcome === "gone") guard.removeEmptyFolder(dirname(tmp));
  } catch {
    // refused or not empty: not ours to remove
  }
  return result;
}

// Every state write of the worker outside the commit step: inside the
// boundary when it is free, so it never runs beside an uninstall, and only
// while the launcher exists. When another process holds the boundary (a
// squatter on the port, or a long init) it checks the launcher and writes.
// A home without a launcher is never written to. Never throws.
async function note(home: string, change: Partial<UpdateState>): Promise<void> {
  const write = (): void => {
    if (existsSync(launcherPath(home))) updateState(home, change);
  };
  try {
    await withBoundary(home, { wait: 0 }, write);
  } catch (error) {
    try {
      if (error instanceof BoundaryError && error.held) write();
    } catch {
      // a cache write; the next check writes again
    }
  }
}

// `daily`: started by a normal command; it checks only when no other worker
// checked in the last 24 hours, and installs only a release with the
// running contract (src/contract.ts): one with another contract is
// announced and left for a foreground `openqodex update`, which installs
// the newest release whatever its contract. `wait`: how long the commit
// step waits for the boundary (0 for the daily worker, which tries again
// tomorrow).
export async function runUpdateWorker(opts: { anyAge: boolean; daily?: boolean; wait: number }): Promise<WorkerResult> {
  const home = openqodexHome();
  const env = process.env;
  const allowed = updatesAllowed(home, env);
  if (!allowed.allowed) return { outcome: "off", lines: [`Updates are ${allowed.why}.`] };
  if (opts.daily) {
    const at = Date.parse(readState(home).checkedAt ?? "");
    const age = Date.now() - at;
    if (Number.isFinite(at) && age >= 0 && age < CHECK_EVERY_MS) return { outcome: "none", lines: ["Checked less than a day ago."] };
  }
  const limit = setTimeout(() => process.exit(2), LIMIT_MS);
  limit.unref();
  try {
    return await work(home, env, opts.anyAge, opts.wait, opts.daily === true);
  } catch (error) {
    await note(home, { lastError: message(error) });
    return { outcome: "failed", lines: [`The update failed: ${message(error)}`] };
  } finally {
    clearTimeout(limit);
  }
}

async function work(home: string, env: NodeJS.ProcessEnv, anyAge: boolean, wait: number, daily: boolean): Promise<WorkerResult> {
  const now = Date.now();
  const test = seam(env);
  const running = test.as ?? __OPENQODEX_VERSION__;
  const from = activeVersion(home);
  if (from === null || !existsSync(launcherPath(home))) return { outcome: "failed", lines: ["No launcher install here; run npx openqodex init."] };
  // A worker started by a command of another version than the active one
  // (a rollback or a switch ran since) would choose with that version's
  // contract against this record: it ends here, writing nothing. Its own
  // version, never the test seam's.
  const self = __OPENQODEX_VERSION__;
  if (from !== self) return { outcome: "none", lines: [`The active version is ${from}, not ${self}, the version of this update; nothing was checked.`] };
  // What a crashed or killed worker left behind.
  for (const tmp of tempRuntimes(home, false)) homeGuard(home, true).removeTree(tmp);
  await note(home, { checkedAt: new Date(now).toISOString() });
  await pauseAt(home, "before-metadata", env);

  let metadata: unknown;
  try {
    metadata = await fetchMetadata();
  } catch (error) {
    await note(home, { lastError: message(error) });
    return { outcome: "failed", lines: [`Could not read the registry: ${message(error)}`] };
  }
  await note(home, { latestSeen: latestOf(metadata) });

  // selectCandidates applies the 24 hour rule itself; a shorter rule is
  // the same as asking it later.
  const minAge = anyAge ? 0 : (test.minAge ?? MIN_AGE_MS);
  const all = selectCandidates(metadata, { current: running, now: now + (MIN_AGE_MS - minAge), nodeVersion: process.versions.node, skip: skipVersion(home) });
  // The contract this install keeps: this build's, or under the test seam
  // the one the registry says `running` declares.
  const versions = (metadata as { versions?: Record<string, unknown> } | null)?.versions;
  const keep = test.as !== null && versions?.[test.as] !== undefined ? contractOf(versions[test.as]) : runningContract();
  const { install, held } = daily ? byContract(all, keep) : { install: all, held: null };
  const heldLine = held === null ? null : `openqodex ${held.version} changes ${contractChange(held.contract, keep)}, so it was not installed in the background: run ${launcherRunner(launcherPath(home))} update to install it.`;
  if (held !== null) {
    const state = readState(home);
    const fresh = state.held?.version !== held.version;
    await note(home, { held: { version: held.version, change: contractChange(held.contract, keep) }, ...(fresh ? { notice: { version: running, text: heldLine! } } : {}) });
  } else if (daily) await note(home, { held: null });
  const candidates = install;
  if (candidates.length === 0) {
    await note(home, { lastError: null });
    return { outcome: "none", lines: [...(heldLine === null ? [] : [heldLine]), `No newer release than ${running} to install${held === null ? "" : " in the background"}.`] };
  }

  const lines: string[] = [];
  const reasons: string[] = [];
  const skip = async (version: string, reason: string): Promise<void> => {
    reasons.push(reason);
    lines.push(`Skipped ${version}: ${reason}`);
    const skipped = readState(home).skipped.filter((s) => s.version !== version);
    await note(home, { skipped: [...skipped, { version, reason, at: new Date().toISOString() }] });
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
      await note(home, { lastError: message(error) });
      return { outcome: "failed", lines: [...lines, `Could not download ${c.version}: ${message(error)}`] };
    }
    const verified = verifyRelease({ name: "openqodex", version: c.version, tarball, integrity: c.integrity, attestations });
    if (!verified.ok) {
      await skip(c.version, verified.reason);
      continue;
    }
    let tmp: string;
    try {
      tmp = await unpackRelease(home, c.version, tarball, c.contract);
    } catch (error) {
      await skip(c.version, `it did not install: ${message(error)}`);
      continue;
    }
    const result = await activateUnpacked({ home, version: c.version, from, running: self, tmp, env, wait, contract: c.contract, ...(daily ? { keep } : {}) });
    if (result.outcome === "skip") {
      await skip(c.version, result.reason);
      continue;
    }
    // After an uninstall, nothing is written: the home folder is not ours.
    if (result.outcome === "gone") return { outcome: "none", lines: [...lines, "OpenQodex was uninstalled meanwhile; nothing was changed."] };
    if (result.outcome === "busy") {
      await note(home, { lastError: result.reason });
      return { outcome: "busy", lines: [...lines, `Downloaded and verified ${c.version}, but did not switch to it: ${result.reason}`] };
    }
    if (result.outcome !== "activated") {
      if (result.outcome === "failed") await note(home, { lastError: result.reason });
      return { outcome: result.outcome === "failed" ? "failed" : "none", lines: [...lines, `Downloaded and verified ${c.version}, but did not switch to it: ${result.reason}`] };
    }
    const after: string[] = [];
    if (!sameContract(c.contract, keep)) {
      after.push(`${c.version} changes ${contractChange(c.contract, keep)}: run ${launcherRunner(launcherPath(home))} init to refresh the files OpenQodex wrote for your agents.`);
    }
    if (heldLine !== null) {
      // The switch notice is for the new version; the held release goes with it.
      const state = readState(home);
      if (state.notice?.version === c.version) await note(home, { notice: { ...state.notice, text: `${state.notice.text}\n${heldLine}` } });
    }
    return { outcome: "updated", lines: [...lines, result.reason, ...after] };
  }

  // Every candidate failed. When each failed because the built-in trust
  // data is out of date, one notice says how to update by hand, once.
  const trustStale = reasons.length > 0 && reasons.every((r) => TRUST_DATA.test(r));
  if (trustStale) {
    const text = `openqodex cannot verify new releases with its built-in trust data; it stays on ${from}. To update by hand: npx openqodex@latest init`;
    const state = readState(home);
    await note(home, { lastError: text, ...(state.lastError === text ? {} : { notice: { version: from, text } }) });
  } else await note(home, { lastError: null });
  return { outcome: "none", lines: [...lines, `Stayed on ${from}: no newer release could be installed.`] };
}
