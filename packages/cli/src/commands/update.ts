// `openqodex update`: check for a new release now and install it, in the
// foreground, with the same verification as the daily check.
//   --now       also install a release younger than 24 hours
//   --rollback  go back to the previous version; the release left is
//               skipped from then on (skip_version), and updates stay on
//   --off/--on  turn the daily check off or on (~/.openqodex/config.yaml)
//   --status    print the update state
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { staleOwnedFiles } from "../agents/stale.js";
import { compareVersions, noticesBetween } from "../notices.js";
import { contractOf } from "../contract.js";
import { withBoundary } from "../agents/lock.js";
import { EXIT_OK, EXIT_TOOL_FAILED } from "../exit-codes.js";
import { pruneHomeReceipts } from "../receipts.js";
import { activeVersion, launcherPath, launcherRunner, launcherStarted, openqodexHomeDir, pruneRuntimes, readActive, runtimeBin, writeActive } from "../launcher.js";
import { pinnedNote } from "../update/trigger.js";
import { readState, setUserKeys, setUserUpdate, skipVersion, updatesAllowed, userConfigPath } from "../update/state.js";

const USAGE = "usage: openqodex update [--now | --rollback | --off | --on | --status]";
const FLAGS = ["--now", "--rollback", "--off", "--on", "--status"];
// How long a foreground command waits for another init, uninstall or update.
const WAIT_MS = 60_000;

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(line: string): number {
  process.stderr.write(`openqodex update: ${line}\n`);
  return EXIT_TOOL_FAILED;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ago(iso: string | null): string {
  const at = iso === null ? Number.NaN : Date.parse(iso);
  if (!Number.isFinite(at)) return "never";
  const hours = Math.max(0, Math.floor((Date.now() - at) / 3_600_000));
  return `${iso} (${hours < 24 ? `${hours} hours ago` : `${Math.floor(hours / 24)} days ago`})`;
}

// The update lines `update --status` and `doctor` print.
export function statusLines(home: string): string[] {
  const state = readState(home);
  const launched = launcherStarted();
  const allowed = updatesAllowed(home, process.env);
  const lines = [
    `running      ${__OPENQODEX_VERSION__}${launched ? " (through the launcher)" : " (pinned: not started through the launcher, never updates)"}`,
    `latest seen  ${state.latestSeen ?? "not checked yet"}`,
    `last check   ${ago(state.checkedAt)}`,
    `updates      ${allowed.why}`,
    `last error   ${state.lastError ?? "none"}`,
  ];
  if (state.held !== null) lines.push(`waiting      ${state.held.version} changes ${state.held.change}; openqodex update installs it`);
  const skip = skipVersion(home);
  if (skip !== null) lines.push(`skipped      ${skip} and every older release (skip_version in ${userConfigPath(home)})`);
  // The release notices of the last update: after the previous version, up to the current one.
  const active = readActive(home);
  if (active.current !== null && active.previous !== null && compareVersions(active.previous, active.current) < 0) {
    for (const n of noticesBetween(active.previous, active.current)) lines.push(`notice       ${n.version}: ${n.text}`);
  }
  // The files OpenQodex wrote that init would refresh, for a launcher install.
  if (existsSync(launcherPath(home))) {
    const n = staleOwnedFiles(homedir(), home).length;
    const runner = launcherRunner(launcherPath(home));
    lines.push(`agent files  ${n === 0 ? "up to date" : `${n} OpenQodex wrote ${n === 1 ? "is" : "are"} from an older version; run ${runner} init to refresh them`}`);
  }
  if (!launched) {
    const note = pinnedNote(state, __OPENQODEX_VERSION__);
    if (note !== null) lines.push(`note         ${note}`);
  }
  return lines;
}

// True when the runtime of `version` reads skip_version: it declares a
// contract in its package.json, which came in the same release.
function readsSkipVersion(home: string, version: string): boolean {
  try {
    return contractOf(JSON.parse(readFileSync(join(home, "runtime", version, "package.json"), "utf8"))) !== null;
  } catch {
    return false;
  }
}

// Inside the commit boundary, so no worker switches versions meanwhile.
// The release left is written as skip_version first: when that cannot be
// written, nothing changes, or the next daily check would install the
// release just rolled back. Updates stay on, so the release after it comes.
// The plan's R9 turned updates off instead (reversed 2026-10-07). A runtime
// from before skip_version would ignore it, so going back to one turns
// updates off, as before.
async function rollback(home: string): Promise<number> {
  return withBoundary(home, { wait: WAIT_MS }, () => {
    const from = activeVersion(home);
    const to = readActive(home).previous;
    if (to === null) return fail("there is no previous version to go back to");
    if (!existsSync(runtimeBin(home, to))) return fail(`the runtime for the previous version ${to} is gone; nothing was changed`);
    if (to === from || from === null) return fail(`${to} is already the active version`);
    const skips = readsSkipVersion(home, to);
    try {
      setUserKeys(home, skips ? { skip_version: from } : { update: "off" });
    } catch (error) {
      return fail(`could not write ${skips ? "skip_version" : "update: off"} (${message(error).split("\n")[0]}); nothing was changed`);
    }
    writeActive(home, { current: to, previous: from });
    out(
      skips
        ? `Rolled back to ${to} (was ${from}). ${from} and every older release will not be installed again; updates stay on, so the next release comes.`
        : `Rolled back to ${to} (was ${from}). ${to} cannot skip one release, so updates are off; turn them back on with openqodex update --on once a release after ${from} is out.`,
    );
    return EXIT_OK;
  });
}

export async function run(args: string[]): Promise<number> {
  const unknown = args.find((a) => !FLAGS.includes(a));
  if (unknown !== undefined) return fail(`unknown argument: ${unknown}\n${USAGE}`);
  const modes = FLAGS.filter((f) => f !== "--now" && args.includes(f));
  if (modes.length > 1 || (modes.length === 1 && args.includes("--now"))) return fail(`choose one of ${FLAGS.join(", ")}\n${USAGE}`);
  const home = openqodexHomeDir();

  if (args.includes("--status")) {
    for (const line of statusLines(home)) out(line);
    return EXIT_OK;
  }
  if (args.includes("--off") || args.includes("--on")) {
    const value = args.includes("--off") ? "off" : "on";
    try {
      await withBoundary(home, { wait: WAIT_MS }, () => setUserUpdate(home, value));
    } catch (error) {
      return fail(message(error));
    }
    const allowed = updatesAllowed(home, process.env);
    out(`Wrote update: ${value} to ${userConfigPath(home)}. Updates are ${allowed.why}.`);
    return EXIT_OK;
  }
  if (!launcherStarted()) {
    return fail("this openqodex was not started through the launcher in ~/.openqodex/bin, so it is pinned and does not update. Run npx openqodex init to install the launcher.");
  }
  try {
    if (args.includes("--rollback")) return await rollback(home);
    const { runUpdateWorker } = await import("../update/worker.js");
    const result = await runUpdateWorker({ anyAge: args.includes("--now"), wait: WAIT_MS });
    for (const line of result.lines) out(line);
    // Old runtimes go here and in init, never in the background worker.
    await withBoundary(home, { wait: WAIT_MS }, () => pruneRuntimes(home));
    pruneHomeReceipts(home);
    return result.outcome === "failed" || result.outcome === "busy" ? EXIT_TOOL_FAILED : EXIT_OK;
  } catch (error) {
    return fail(message(error));
  }
}
