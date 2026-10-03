// `openqodex update`: check for a new release now and install it, in the
// foreground, with the same verification as the daily check.
//   --now       also install a release younger than 24 hours
//   --rollback  go back to the previous version and turn updating off
//   --off/--on  turn the daily check off or on (~/.openqodex/config.yaml)
//   --status    print the update state
import { existsSync } from "node:fs";
import { withLock } from "../agents/record.js";
import { EXIT_OK, EXIT_TOOL_FAILED } from "../exit-codes.js";
import { launcherStarted, openqodexHomeDir, runtimeBin, writeCurrent } from "../launcher.js";
import { activeVersion, reconcileLocked, refreshWith } from "../update/activate.js";
import { pinnedNote } from "../update/trigger.js";
import { readState, setUserUpdate, updateState, updatesAllowed, userConfigPath } from "../update/state.js";

const USAGE = "usage: openqodex update [--now | --rollback | --off | --on | --status]";
const FLAGS = ["--now", "--rollback", "--off", "--on", "--status"];
const PLAIN_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

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
    `latest seen  ${state.latestSeen === null ? "not checked yet" : `${state.latestSeen}, ${ago(state.latestSeenAt)}`}`,
    `last check   ${ago(state.checkedAt)}`,
    `updates      ${allowed.why}`,
    `last error   ${state.lastError ?? "none"}`,
  ];
  if (!launched) {
    const note = pinnedNote(state, __OPENQODEX_VERSION__);
    if (note !== null) lines.push(`note         ${note}`);
  }
  return lines;
}

// Turns updating off first: when that cannot be written, nothing changes,
// or the next daily check would install the release just rolled back.
async function rollback(home: string): Promise<number> {
  return withLock(home, async () => {
    reconcileLocked(home);
    const state = readState(home);
    const from = activeVersion(home);
    const to = state.previous;
    if (to === null || !PLAIN_VERSION.test(to)) return fail("there is no previous version to go back to");
    if (!existsSync(runtimeBin(home, to))) return fail(`the runtime for the previous version ${to} is gone; nothing was changed`);
    if (to === from) return fail(`${to} is already the active version`);
    try {
      setUserUpdate(home, "off");
    } catch (error) {
      return fail(`could not turn updates off (${message(error).split("\n")[0]}); nothing was changed`);
    }
    let refreshNote = "";
    try {
      await refreshWith(home, to, process.env);
    } catch (error) {
      refreshNote = ` The agent files were not refreshed: ${message(error).split("\n")[0]}`;
    }
    writeCurrent(home, to);
    updateState(home, { installed: to, previous: from, notified: true });
    out(`Rolled back to ${to} (was ${from}). Updates are off; turn them back on with openqodex update --on.${refreshNote}`);
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
      setUserUpdate(home, value);
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
  if (args.includes("--rollback")) return rollback(home);

  const { runUpdateWorker } = await import("../update/worker.js");
  const result = await runUpdateWorker({ anyAge: args.includes("--now") });
  for (const line of result.lines) out(line);
  return result.outcome === "failed" ? EXIT_TOOL_FAILED : EXIT_OK;
}
