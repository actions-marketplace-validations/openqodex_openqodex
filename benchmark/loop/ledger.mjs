// The reviewer loop's ledger as loop.mjs keeps it: benchmark/index/ledger/
// reviewer.jsonl (PLAN-benchmark 4.8), one JSON line per stage step of a
// change, beside the proposed, validation, baseline and stop lines other
// scripts write. Every read that decides something and every write happens
// under the ledger's lock (propose.mjs lockLedger), and a write replaces the
// file in one rename.
//
// What it keeps:
// - The look number t of the next decision (decide.mjs lookOf), read and
//   advanced under the lock, so two changes deciding at once take two looks.
// - Spend. Each stage line carries `spend`: what its runs cost since the
//   ledger last named them (server dollars, laptop reviews and their reported
//   dollars), read from each run folder's budget ledger (lib/budget.mjs), and
//   every run's running total, so a run named again is never counted twice.
// - The daily server cap: 60 dollars a day (UTC) on the server path, summed
//   from the server dollars of the day's stage lines. loop.mjs passes the
//   room left as run.mjs's hard cap (--max-usd), which budget.mjs holds
//   before every model call, so a run never spends past it whatever the
//   forecast said.
// - The run lock beside the ledger: one stage that runs reviews at a time,
//   so the day's room is never read by two runs at once. A lock left by a
//   step that died is settled: what its runs spent goes into an `abandoned`
//   line before anything else runs.
//
// Failure list, written before the code:
// 1. Two iterations read the ledger before either writes, so both take look
//    t and the second is tested at a bound already spent: the look is read
//    and the line written under one hold of the lock.
// 2. A line is cut half way (a crash, a full disk), and every later reader
//    refuses the ledger: the new text is written to a file beside it, synced,
//    and renamed over it.
// 3. The day's cap is checked against a forecast and the run spends more
//    than the forecast: the cap is the run's hard cap, never a forecast.
// 4. A run's spend is counted at every stage that names it, or a parent run
//    made before the change is charged to it: each run's total is recorded
//    with the line, and only what it spent since counts; a parent's spend
//    before the loop first named it never counts.
// 5. A step dies while its runs spend, and the day's sum misses that spend:
//    the run lock names the step's runs, and the next step records what
//    they spent before it reads the room.
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { readLedger as readBudget } from "../lib/budget.mjs";
import { ToolError } from "./leak-check.mjs";
import { lockLedger, readLedger } from "./propose.mjs";

/** The most the server path may spend in one UTC day, in dollars (P3 question 9). */
export const DAILY_SERVER_USD = 60;

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const round = (usd) => Math.round(usd * 1e9) / 1e9;

/** The UTC day of an ISO time, YYYY-MM-DD. */
export const dayOf = (iso) => String(iso).slice(0, 10);

// Writes `text` after the ledger's current content as one replace: a temp
// file beside it, synced, renamed over it (failure 2).
function replaceWith(path, text) {
  const raw = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (raw !== "" && !raw.endsWith("\n")) throw new ToolError(`${path} does not end with a newline; a line was cut, so nothing is written until a person mends it`);
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = openSync(temp, "wx");
  try {
    writeSync(fd, raw + text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}

/**
 * Runs `build(lines)` under the ledger's lock and writes the lines it
 * returns. `build` returns { write: [line, ...], result }; nothing is written
 * when `write` is empty. Returns `result`.
 */
export function withLedger(path, build) {
  mkdirSync(dirname(path), { recursive: true });
  const lock = lockLedger(path);
  try {
    const lines = readLedger(path);
    const { write = [], result } = build(lines);
    if (write.length > 0) {
      if (!lock.held()) throw new ToolError(`the ledger lock ${path}.lock was taken over while this step ran; nothing is written, step again`);
      replaceWith(path, write.map((l) => `${JSON.stringify(l)}\n`).join(""));
    }
    return result;
  } finally {
    lock.release();
  }
}

// ---------------------------------------------------------------------------
// Spend.

/**
 * What a run folder has spent so far, by its budget ledger (budget.jsonl,
 * lib/budget.mjs): dollars and reviews started. A run made before the
 * budget ledger existed is read from rows.jsonl, its attempts' reported
 * costs.
 */
export function folderSpend(folder) {
  const b = readBudget(folder);
  if (b.events.length > 0) return { usd: round(b.spentUsd + b.reservedUsd), reviews: b.launched };
  const rows = join(folder, "rows.jsonl");
  if (!existsSync(rows)) return { usd: 0, reviews: 0 };
  const lines = readFileSync(rows, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { usd: round(sum(lines.map((r) => (typeof r.usage?.cost_usd === "number" ? r.usage.cost_usd : 0)))), reviews: lines.filter((r) => (r.attempt ?? 1) === 1).length };
}

/** The last total the ledger recorded for each run id: Map(runId -> {usd, reviews}). */
export function recordedRuns(lines) {
  const out = new Map();
  for (const l of lines) for (const r of l.spend?.runs ?? []) out.set(r.runId, { usd: r.usd, reviews: r.reviews });
  return out;
}

/**
 * The spend of one step: for each run it names ({runId, folder, path,
 * role, before}), what it spent since the ledger last recorded it. A run the
 * ledger never named counts from `before`: zero for a candidate (made for
 * the change), its total when the step began for a parent (made before the
 * change, failure 4).
 */
export function stepSpend(lines, runs) {
  const known = recordedRuns(lines);
  const rows = runs.map((r) => {
    const now = folderSpend(r.folder);
    const from = known.get(r.runId) ?? r.before ?? { usd: 0, reviews: 0 };
    return { runId: r.runId, role: r.role, path: r.path, usd: now.usd, reviews: now.reviews, newUsd: round(Math.max(0, now.usd - from.usd)), newReviews: Math.max(0, now.reviews - from.reviews) };
  });
  const on = (path) => rows.filter((r) => r.path === path);
  return {
    serverUsd: round(sum(on("server").map((r) => r.newUsd))),
    serverReviews: sum(on("server").map((r) => r.newReviews)),
    laptopUsd: round(sum(on("laptop").map((r) => r.newUsd))),
    laptopReviews: sum(on("laptop").map((r) => r.newReviews)),
    runs: rows.map(({ runId, role, path, usd, reviews }) => ({ runId, role, path, usd, reviews })),
  };
}

/** The server dollars the ledger's stage lines record on a UTC day. */
export function serverSpendOn(lines, day) {
  return round(sum(lines.filter((l) => l.spend && dayOf(l.at) === day).map((l) => l.spend.serverUsd ?? 0)));
}

/** The day's room on the server path: { day, spentUsd, roomUsd }. */
export function dailyRoom(lines, now = new Date(), cap = DAILY_SERVER_USD) {
  const day = dayOf(now.toISOString());
  const spentUsd = serverSpendOn(lines, day);
  return { day, spentUsd, roomUsd: round(Math.max(0, cap - spentUsd)) };
}

/** What a change has spent over every line of it. */
export function changeSpend(lines, id) {
  const mine = lines.filter((l) => l.id === id && l.spend);
  return {
    serverUsd: round(sum(mine.map((l) => l.spend.serverUsd ?? 0))),
    serverReviews: sum(mine.map((l) => l.spend.serverReviews ?? 0)),
    laptopUsd: round(sum(mine.map((l) => l.spend.laptopUsd ?? 0))),
    laptopReviews: sum(mine.map((l) => l.spend.laptopReviews ?? 0)),
  };
}

// ---------------------------------------------------------------------------
// The earliest-failure signal (PLAN 4.11, question 31).

/**
 * Why no lever may be chosen now, or null. The last `baseline` or `stop`
 * line decides: a `stop` line, or a baseline whose signal says stop,
 * refuses; so does a ledger whose baselines carry no signal yet, since the
 * plan chooses levers only after the signal is computed.
 */
export function signalRefusal(lines) {
  const last = lines.filter((l) => l.event === "stop" || (l.event === "baseline" && l.signal)).at(-1);
  if (!last) return "the ledger holds no baseline with the earliest-failure signal (P3-06 writes it after the first baselines and ruling batch); no lever is chosen before it says go";
  if (last.event === "stop") return `${last.id} (${last.at}) stopped lever selection: ${last.reason ?? "the earliest-failure signal said stop"}`;
  if (last.signal.stop === true) return `the last baseline, ${last.id} (${last.at}), carries a signal that says stop (same-issue agreement ${last.signal.sameIssueAgreement}, unresolved share ${last.signal.unresolvedShare}, tool-stress share ${last.signal.toolStressShare}); no lever is chosen until a later baseline says go`;
  if (last.signal.stop !== false) return `the last baseline, ${last.id}, carries a signal without a stop verdict`;
  return null;
}

// ---------------------------------------------------------------------------
// The run lock: one stage that runs reviews at a time.

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

export const runLockPath = (ledger) => `${ledger}.run.lock`;

/**
 * Takes the run lock for a step ({change, stage, step, runs: [{runId,
 * folder, path, role, before}]}). Returns { release, update, stale }:
 * update(info) rewrites the runs it names, and `stale` is the info a dead
 * step left, which the caller settles before it reads the room. A lock held
 * by a live process refuses.
 */
export function takeRunLock(ledger, info) {
  const path = runLockPath(ledger);
  mkdirSync(dirname(path), { recursive: true });
  let stale = null;
  for (let tries = 0; tries < 3; tries++) {
    const mine = JSON.stringify({ pid: process.pid, at: new Date().toISOString(), nonce: randomBytes(6).toString("hex"), ...info });
    try {
      writeFileSync(path, mine, { flag: "wx" });
      let text = mine;
      return {
        stale,
        update(more) {
          const now = existsSync(path) ? readFileSync(path, "utf8") : null;
          if (now !== text) throw new ToolError(`the run lock ${path} is no longer this step's`);
          text = JSON.stringify({ ...JSON.parse(text), ...more });
          writeFileSync(`${path}.tmp`, text);
          renameSync(`${path}.tmp`, path);
        },
        release() {
          if (existsSync(path) && readFileSync(path, "utf8") === text) unlinkSync(path);
        },
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    let held;
    try {
      held = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // Still being written: an empty lock older than a minute is a dead writer's.
      if (Date.now() - statSync(path).mtimeMs < 60_000) throw new ToolError(`the run lock ${path} is being taken by another step; step again in a moment`);
      held = {};
    }
    if (Number.isInteger(held.pid) && alive(held.pid)) throw new ToolError(`another step runs reviews now: ${held.change ?? "a change"} stage ${held.stage ?? "?"} (process ${held.pid}, since ${held.at}); one stage runs at a time, so step again when it ends`);
    stale = held;
    renameSync(path, `${path}.stale-${process.pid}`);
    unlinkSync(`${path}.stale-${process.pid}`);
  }
  throw new ToolError(`the run lock ${path} could not be taken`);
}
