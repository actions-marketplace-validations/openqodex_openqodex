// The budget of a benchmark run: hard caps that bind every model call the
// harness makes, held by a reservation ledger that every process of the run
// shares, and forecast stops kept apart from the caps.
//
// Hard caps: --max-usd for the run and --review-max-usd for one review. They
// bind a review's calls and a judge's calls alike, and they are held before
// a call is sent, never counted after it:
// - A model review holds its whole cap (its envelope) against the run's cap
//   before it starts. Each of its calls reserves its worst case inside that
//   envelope before it is sent, and gives back the unused part when the call
//   reports its cost. So the run's cap stops launches and never cuts a
//   review half way, and two reviews never draw on the same room.
// - A call the harness makes outside a review (a judge's) reserves its
//   worst case against the run's cap directly.
// - The worst case of a call is its input at 3 UTF-8 bytes per character of
//   its messages and tools written as JSON (the size the library hands
//   `authorize`; one UTF-16 code unit is at most 3 UTF-8 bytes, and no
//   tokenizer yields more tokens than bytes) at the uncached input price,
//   plus maxOutputTokens (reasoning included) at the output price, from
//   benchmark/outside/prices.json.
//
// Forecast stops: --max-minutes, --max-tokens, --max-reviews, and the launch
// rule (no review starts when what is spent, plus the median review so far
// for each review running and the next, would pass --max-usd). They look
// ahead from what reviews cost so far, can overshoot, and say so. Claude
// Code and Codex report their cost only after a review, so a laptop run is
// bounded by forecast stops only.
//
// The ledger is budget.jsonl in the run folder: one JSON line per event,
// appended under budget.lock, which a process takes for one step at a time:
// run.mjs's reviews, and a judge or board script started later on the same
// folder. Amounts are whole nano-dollars, a cost or a worst case rounded up,
// so the sums never fall below what was spent.
//
// Failure list, written before the code:
// 1. A run spends past its hard cap: every model call reserves its worst
//    case before it is sent, a review's calls inside the review's envelope
//    and the envelope inside the run's cap; a run whose estimate passes the
//    cap is refused before it starts, unless --allow-over, and one whose cap
//    cannot hold one review's cap is refused even then.
// 2. Two concurrent reviews both authorise against the same remaining
//    budget: each step reads every line other processes appended, decides
//    and appends under one lock, so two reservations never see the same
//    room; the lock is made by an exclusive create, and a dead process's
//    lock is replaced by exactly one taker; a review that finds no room
//    while others hold theirs waits for one to end instead of starting.
// 3. The worst-case token count is below the real count: input is counted
//    at 3 bytes per character of the request, never at one token per
//    character; a call reported above its worst case is an overrun, after
//    which nothing more is reserved or sent, the judge's calls and calls
//    reserved earlier included, and the run stops, since the bound it relied
//    on is wrong.
// 4. Judge calls are left out of the run cap: meteredComplete reserves a
//    judge's call against the run's ledger, which openRunLedger opens from
//    the run folder with the run's own caps, from any process;
//    benchmark/judge.mjs sends every call that way, and the manifest says
//    judgeIncluded true only while it does.
// 5. A call reports no cost, or throws after the provider may have billed
//    it: it keeps its whole reservation as spent.
// 6. A process dies with reservations open: the next process to take the
//    ledger counts the dead process's call reservations as spent in full
//    and gives back the rest of its reviews' envelopes.
// 7. A forecast stop is read as a hard cap, or the reverse: every stop names
//    its limit and whether it is hard or a forecast.
import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runsRoot } from "./index.mjs";

export const LEDGER_FILE = "budget.jsonl";
export const LEDGER_LOCK = "budget.lock";
export const MAX_UTF8_BYTES_PER_CHAR = 3;

const PRICES = new URL("../outside/prices.json", import.meta.url);
const NANO = 1e9;
const up = (usd) => Math.ceil(usd * NANO);
const exact = (usd) => Math.round(usd * NANO);
const dollars = (nano) => nano / NANO;
const money = (usd) => `$${usd.toFixed(usd >= 1 ? 2 : usd >= 0.01 ? 4 : 6).replace(/0+$/, "").replace(/\.$/, "")}`;

/** A refusal of the budget: nothing was sent. */
export class BudgetRefused extends Error {}

/** The price table: prices.json's models, by deployment id. */
export function loadPrices() {
  return JSON.parse(readFileSync(PRICES, "utf8")).models;
}

const ratesOf = (prices, model) => {
  const r = prices?.[model];
  return r && typeof r.input === "number" && typeof r.output === "number" ? r : null;
};

/** The most one call can cost, in dollars: `requestBytes` as input tokens, the whole output allowance as output tokens. */
export function worstCaseUsd({ requestBytes, maxOutputTokens, rates }) {
  return (requestBytes * rates.input + maxOutputTokens * rates.output) / 1e6;
}

/** The characters of a request as the library counts them for `authorize`: its messages and its tools, written as JSON. */
export function requestChars(request) {
  return JSON.stringify(request.messages).length + JSON.stringify(request.tools ?? []).length;
}

// ---------- the lock ----------

const pause = new Int32Array(new SharedArrayBuffer(4));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

// The lock file as one open file: its inode and the process it names, or
// null when there is none.
function readLock(path) {
  let fd;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const { dev, ino } = fstatSync(fd);
    return { dev, ino, text: readFileSync(fd, "utf8").trim() };
  } finally {
    closeSync(fd);
  }
}

// Replaces a lock whose process has ended with this process's own, and only
// in one process. The taker first makes the takeover guard for that very
// file (its device and inode) by an exclusive create, so one process at a
// time may replace it; a process taking the lock the usual way never
// replaces a file, so while the stale file is there only the guard's holder
// changes it. The holder checks the lock is still that file with that dead
// owner, then renames a lock it wrote in full into place. True when this
// process now holds the lock.
function replaceStale(path, seen) {
  const guard = `${path}.takeover-${seen.dev}-${seen.ino}`;
  try {
    writeFileSync(guard, `${process.pid}\n`, { flag: "wx" });
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
  try {
    const now = readLock(path);
    if (now === null || now.dev !== seen.dev || now.ino !== seen.ino || now.text !== seen.text || alive(Number(now.text))) return false;
    const mine = `${path}.${process.pid}.${randomBytes(6).toString("hex")}`;
    writeFileSync(mine, `${process.pid}\n`);
    renameSync(mine, path);
    return true;
  } finally {
    rmSync(guard, { force: true });
  }
}

// Takes the ledger's lock for this process by an exclusive create, waiting
// while another live process holds it; a lock whose process has ended is
// replaced by exactly one taker (replaceStale). Returns the function that
// gives it back.
function takeLock(path, waitMs = 30_000) {
  const until = Date.now() + waitMs;
  const release = () => {
    if (readLock(path)?.text === String(process.pid)) rmSync(path, { force: true });
  };
  for (;;) {
    try {
      writeFileSync(path, `${process.pid}\n`, { flag: "wx" });
      return release;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const seen = readLock(path);
    if (seen === null) continue;
    if (/^\d+$/.test(seen.text) && !alive(Number(seen.text)) && replaceStale(path, seen)) return release;
    if (Date.now() > until) throw new Error(`the budget ledger's lock ${path} has been held by process ${seen.text || "unknown"} for ${waitMs / 1000} s; if no run is going, move it, and any ${LEDGER_LOCK}.takeover-* file beside it, away by hand`);
    Atomics.wait(pause, 0, 0, 2);
  }
}

// ---------- the ledger's state ----------

// Every reservation still open, what was spent, the highest spent plus
// reserved ever reached, overruns, and the reviews done so far.
function emptyFold() {
  return { spent: 0, open: new Map(), peak: 0, overruns: [], reviews: [], launched: 0, tokens: 0 };
}

// What open reservations hold against the run's cap: a review's envelope
// less what its calls have spent (its open calls are inside it), and every
// other reservation whole.
function reserved(fold) {
  let n = 0;
  for (const r of fold.open.values()) if (r.under === null) n += r.kind === "review" ? Math.max(0, r.nano - r.spentWithin) : r.nano;
  return n;
}

function apply(fold, e) {
  if (e.op === "reserve") {
    fold.open.set(e.id, { kind: e.kind, nano: e.nano, under: e.under ?? null, pid: e.pid, what: e.what ?? null, spentWithin: 0, heldWithin: 0, tokens: 0 });
    if (e.under) fold.open.get(e.under).heldWithin += e.nano;
  } else if (e.op === "settle") {
    const r = fold.open.get(e.id);
    if (!r) throw new Error(`the budget ledger settles ${e.id}, which it never reserved or settled already`);
    fold.spent += e.nano;
    if (r.under !== null) {
      const parent = fold.open.get(r.under);
      parent.spentWithin += e.nano;
      parent.heldWithin -= r.nano;
      parent.tokens += e.tokens ?? 0;
    }
    if (e.nano > r.nano) fold.overruns.push({ id: e.id, what: r.what, reservedUsd: dollars(r.nano), spentUsd: dollars(e.nano) });
    fold.open.delete(e.id);
  } else if (e.op === "close") {
    fold.open.delete(e.id);
  } else if (e.op === "spend") {
    fold.spent += e.nano;
  } else if (e.op === "review") {
    fold.reviews.push({ usd: e.usd ?? null, tokens: e.tokens ?? null, wallMs: e.wallMs ?? null });
    fold.tokens += e.tokens ?? 0;
  } else if (e.op === "launch") {
    fold.launched++;
  } else throw new Error(`the budget ledger holds an event it does not know: ${e.op}`);
  fold.peak = Math.max(fold.peak, fold.spent + reserved(fold));
}

// Why nothing more is reserved or sent once a call cost more than its worst
// case: the bound every hard cap relies on was wrong for it.
const overrunWhy = (o) => `a call (${o.what ?? o.id}) cost ${money(o.spentUsd)}, more than its worst case ${money(o.reservedUsd)}; the bound the hard caps rely on is wrong, so nothing more is reserved or sent`;

function summary(fold) {
  return { spentUsd: dollars(fold.spent), reservedUsd: dollars(reserved(fold)), peakUsd: dollars(fold.peak), overruns: fold.overruns, launched: fold.launched, tokens: fold.tokens, reviews: fold.reviews };
}

/** The ledger of a folder, replayed from its file without the lock: what was spent and reserved, the peak, overruns and every event. */
export function readLedger(dir) {
  const path = join(dir, LEDGER_FILE);
  const events = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((l) => l.endsWith("}")).map((l) => JSON.parse(l)) : [];
  const fold = emptyFold();
  for (const e of events) apply(fold, e);
  return { ...summary(fold), events };
}

// ---------- the ledger ----------

/**
 * The run's ledger in `dir`, held to `caps` ({ maxUsd, reviewMaxUsd }, in
 * dollars). Nothing is written until the first step. Every step takes the
 * lock, reads what other processes appended, decides, and appends.
 */
export function openLedger(dir, caps) {
  return new Ledger(dir, caps);
}

class Ledger {
  constructor(dir, caps) {
    if (!(caps?.maxUsd > 0)) throw new Error("a budget ledger needs a run cap (--max-usd) above 0");
    this.dir = dir;
    this.path = join(dir, LEDGER_FILE);
    this.lockPath = join(dir, LEDGER_LOCK);
    this.max = exact(caps.maxUsd);
    this.reviewMax = caps.reviewMaxUsd === null || caps.reviewMaxUsd === undefined ? null : exact(caps.reviewMaxUsd);
    this.caps = { maxUsd: caps.maxUsd, reviewMaxUsd: caps.reviewMaxUsd ?? null };
    this.offset = 0;
    this.fold = emptyFold();
    this.recovered = false;
  }

  // One step under the lock: catch up, give back what dead processes left
  // open (first step only), then `decide(fold, emit)`.
  step(decide) {
    mkdirSync(this.dir, { recursive: true });
    const release = takeLock(this.lockPath);
    try {
      this.catchUp();
      const lines = [];
      const emit = (event) => {
        const e = { ...event, at: new Date().toISOString() };
        apply(this.fold, e);
        lines.push(`${JSON.stringify(e)}\n`);
      };
      if (!this.recovered) {
        this.recovered = true;
        const dead = [...this.fold.open.entries()].filter(([, r]) => r.pid !== process.pid && !alive(r.pid));
        for (const [id, r] of dead) if (r.kind !== "review") emit({ op: "settle", id, nano: r.nano, usd: dollars(r.nano), how: "abandoned" });
        for (const [id, r] of dead) if (r.kind === "review") emit({ op: "close", id, how: "abandoned" });
      }
      let result;
      try {
        result = decide(this.fold, emit);
      } finally {
        if (lines.length > 0) {
          const text = lines.join("");
          appendFileSync(this.path, text);
          this.offset += Buffer.byteLength(text);
        }
      }
      return result;
    } finally {
      release();
    }
  }

  catchUp() {
    if (!existsSync(this.path)) return;
    const size = statSync(this.path).size;
    if (size < this.offset) throw new Error(`${this.path} is shorter than this process read it; the ledger was edited while the run went`);
    if (size === this.offset) return;
    const buffer = Buffer.alloc(size - this.offset);
    const fd = openSync(this.path, "r");
    try {
      readSync(fd, buffer, 0, buffer.length, this.offset);
    } finally {
      closeSync(fd);
    }
    const text = buffer.toString("utf8");
    if (!text.endsWith("\n")) throw new Error(`${this.path} ends in a line that was never finished; a process died writing it`);
    for (const line of text.split("\n")) if (line !== "") apply(this.fold, JSON.parse(line));
    this.offset = size;
  }

  /** What is spent and reserved now, with the peak, overruns and the reviews so far. */
  state() {
    return this.step(() => summary(this.fold));
  }

  /** Reserves `usd` against the run's cap, outside any review (a judge's call). The reservation's id, or null when it does not fit. */
  reserve({ usd, kind = "judge", what = null }) {
    const nano = up(usd);
    return this.step((fold, emit) => {
      if (fold.overruns.length > 0 || fold.spent + reserved(fold) + nano > this.max) return null;
      const id = `${kind}:${randomBytes(6).toString("hex")}`;
      emit({ op: "reserve", id, kind, nano, usd: dollars(nano), what, pid: process.pid });
      return id;
    });
  }

  /** Settles a reservation with what the call cost; null keeps the whole reservation as spent. */
  settle(id, usd, tokens = null) {
    this.step((fold, emit) => {
      const r = fold.open.get(id);
      if (!r) return;
      const nano = usd === null ? r.nano : up(usd);
      emit({ op: "settle", id, nano, usd: dollars(nano), how: usd === null ? "kept" : "reported", ...(tokens !== null ? { tokens } : {}) });
    });
  }

  /** Adds a cost reported after the fact (a laptop review, a board pipeline's usage). */
  spend(usd, what = null) {
    if (typeof usd !== "number" || !(usd >= 0)) return;
    this.step((fold, emit) => emit({ op: "spend", nano: up(usd), usd, what }));
  }

  /** Records a finished review's cost, tokens and time for the forecast stops (the cost is not added again). */
  noteReview({ jobId, usd = null, tokens = null, wallMs = null }) {
    this.step((fold, emit) => emit({ op: "review", jobId, usd, tokens, wallMs }));
  }

  noteLaunch(jobId) {
    this.step((fold, emit) => emit({ op: "launch", jobId }));
  }

  /** Why nothing more may be reserved or sent (a call cost more than its worst case), or null. */
  halted() {
    return this.step((fold) => (fold.overruns.length > 0 ? overrunWhy(fold.overruns[0]) : null));
  }

  /**
   * Holds one model review's whole cap (--review-max-usd) against the run's
   * cap. The review's meter when it fits; else `wait` when reviews running
   * now hold the room it needs, or a stop when even an empty run could not
   * hold it, or a call overran its worst case.
   */
  openReview({ jobId, prices = null }) {
    if (this.reviewMax === null) throw new Error("a model review needs --review-max-usd, the most one review may spend");
    const need = this.reviewMax;
    return this.step((fold, emit) => {
      if (fold.overruns.length > 0) return { ok: false, wait: false, why: overrunWhy(fold.overruns[0]) };
      const held = reserved(fold);
      if (fold.spent + held + need <= this.max) {
        const id = `review:${jobId}:${randomBytes(6).toString("hex")}`;
        emit({ op: "reserve", id, kind: "review", nano: need, usd: dollars(need), what: jobId, pid: process.pid });
        return new ReviewMeter(this, id, jobId, prices);
      }
      const wait = held > 0 && fold.spent + need <= this.max;
      const why = `hard cap --max-usd ${money(this.caps.maxUsd)}: ${money(dollars(fold.spent))} spent${held > 0 ? ` and ${money(dollars(held))} held by reviews running now` : ""}, and one review may spend up to --review-max-usd ${money(this.caps.reviewMaxUsd)}`;
      return { ok: false, wait, why };
    });
  }
}

// One model review's share of the run's budget: authorize for the library's
// budget, the adapter wrapped so each answered call settles its reservation,
// and close, which gives back what the review did not spend.
class ReviewMeter {
  constructor(ledger, id, jobId, prices) {
    this.ok = true;
    this.ledger = ledger;
    this.id = id;
    this.jobId = jobId;
    this.prices = prices;
    this.calls = new Map();
    this.refusals = [];
    this.closed = false;
    this.spentUsd = null;
    this.opened = Date.now();
    this.authorize = async (call) => {
      const rates = ratesOf(this.prices ?? (this.prices = loadPrices()), call.model);
      if (rates === null) {
        this.refusals.push(`no prices for ${call.model} in prices.json, so its call could not be held to a cap`);
        return false;
      }
      const usd = worstCaseUsd({ requestBytes: MAX_UTF8_BYTES_PER_CHAR * call.requestChars, maxOutputTokens: call.maxOutputTokens, rates });
      return this.reserveCall(call.callId, usd) !== null;
    };
  }

  /** Reserves a call's worst case inside the review's envelope; its id, or null when the review's cap cannot hold it. */
  reserveCall(callId, usd) {
    if (this.closed || this.calls.has(callId)) return null;
    const nano = up(usd);
    return this.ledger.step((fold, emit) => {
      const env = fold.open.get(this.id);
      if (!env) return null;
      if (fold.overruns.length > 0) {
        this.refusals.push(overrunWhy(fold.overruns[0]));
        return null;
      }
      if (env.spentWithin + env.heldWithin + nano > env.nano) {
        this.refusals.push(`hard cap --review-max-usd: ${callId} may cost up to ${money(dollars(nano))}, and the review has ${money(dollars(env.nano - env.spentWithin - env.heldWithin))} left`);
        return null;
      }
      const rid = `${this.id}/${callId}`;
      emit({ op: "reserve", id: rid, kind: "call", under: this.id, nano, usd: dollars(nano), what: `${this.jobId} ${callId}`, pid: process.pid });
      this.calls.set(callId, { rid, sent: false, settled: false });
      return rid;
    });
  }

  /** Settles a call with what it cost; null keeps its whole reservation. A call settled already stays as it was. */
  settleCall(callId, usd, tokens = null) {
    const c = this.calls.get(callId);
    if (!c || c.settled) return;
    c.settled = true;
    this.ledger.settle(c.rid, usd, tokens);
  }

  /** The adapter, sending only calls this review reserved, and settling each one with the cost it reports. */
  wrap(reviewer) {
    return {
      ...reviewer,
      complete: async (request) => {
        const c = this.calls.get(request.callId);
        if (!c || c.sent || c.settled) throw new Error(`no budget reservation for the call ${request.callId}; nothing was sent`);
        // A call reserved before another overran is not sent: its reservation goes back.
        const halted = this.ledger.halted();
        if (halted !== null) {
          this.settleCall(request.callId, 0);
          throw new Error(`${halted}; ${request.callId} was not sent`);
        }
        c.sent = true;
        let answer;
        try {
          answer = await reviewer.complete(request);
        } catch (error) {
          this.settleCall(request.callId, null);
          throw error;
        }
        const u = answer?.usage;
        const cost = typeof u?.costUsd === "number" && Number.isFinite(u.costUsd) && u.costUsd >= 0 ? u.costUsd : null;
        const tokens = Number.isInteger(u?.inputTokens) && Number.isInteger(u?.outputTokens) ? u.inputTokens + u.outputTokens : null;
        this.settleCall(request.callId, cost, tokens);
        return answer;
      },
    };
  }

  /** Ends the review: an unsent call gives its reservation back, a call still out keeps it whole, and the envelope's unspent part is released. `spentUsd` is then what the review itself spent. */
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const [callId, c] of this.calls) if (!c.settled) this.settleCall(callId, c.sent ? null : 0);
    this.ledger.step((fold, emit) => {
      const env = fold.open.get(this.id);
      if (!env) return;
      this.spentUsd = dollars(env.spentWithin);
      emit({ op: "close", id: this.id });
      emit({ op: "review", jobId: this.jobId, usd: dollars(env.spentWithin), tokens: env.tokens, wallMs: Date.now() - this.opened });
    });
  }
}

/**
 * The run's ledger, opened from its folder with the caps the run holds (the
 * last resume's, else the first invocation's), for a script that calls a
 * model on a run after it, such as the wording judge.
 */
export function openRunLedger(runDir) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"));
  } catch {
    throw new BudgetRefused(`${runDir} has no manifest.json, so there is no run cap to hold a call to`);
  }
  const resumes = existsSync(join(runDir, "resumes.jsonl")) ? readFileSync(join(runDir, "resumes.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const caps = resumes.filter((r) => r.event === "resumed" && r.budget).at(-1)?.budget?.hardCaps ?? manifest.budget?.hardCaps;
  if (!(caps?.maxUsd > 0)) throw new BudgetRefused(`${runDir} records no hard cap (budget.hardCaps.maxUsd in its manifest); a model call on it could not be held to one`);
  return openLedger(runDir, caps);
}

/**
 * One call the harness makes outside a review (a judge's), held to the run's
 * cap: its worst case is reserved first, and BudgetRefused is thrown, with
 * nothing sent, when it does not fit; the call's reported cost settles it.
 */
export async function meteredComplete(ledger, reviewer, request, { prices = loadPrices(), what = null } = {}) {
  const rates = ratesOf(prices, reviewer.model);
  if (rates === null) throw new BudgetRefused(`no prices for ${reviewer.model} in prices.json, so its call could not be held to the run's cap`);
  const usd = worstCaseUsd({ requestBytes: MAX_UTF8_BYTES_PER_CHAR * requestChars(request), maxOutputTokens: request.maxOutputTokens, rates });
  const id = ledger.reserve({ usd, kind: "judge", what });
  if (id === null) {
    const s = ledger.state();
    if (s.overruns.length > 0) throw new BudgetRefused(overrunWhy(s.overruns[0]));
    throw new BudgetRefused(`hard cap --max-usd ${money(ledger.caps.maxUsd)}: this call may cost up to ${money(usd)}, and ${money(s.spentUsd)} is spent and ${money(s.reservedUsd)} held`);
  }
  let answer;
  try {
    answer = await reviewer.complete(request);
  } catch (error) {
    ledger.settle(id, null);
    throw error;
  }
  const cost = answer?.usage?.costUsd;
  ledger.settle(id, typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null);
  return answer;
}

// ---------- the manifest's record ----------

// Whether benchmark/judge.mjs sends its model calls through the run's ledger
// (meteredComplete). It does: the judge calls GPT-5.2 through the model
// adapter and holds each call to the run's cap, so the manifest says
// judgeIncluded true. A test holds the two together.
export const JUDGE_HELD_BY_LEDGER = true;

/** The manifest's `budget`: the hard caps apart from the forecast stops, with the estimate. */
export function manifestBudget({ caps, forecast, estimate, allowOver = false }) {
  return { hardCaps: caps, forecastStops: { ...forecast, estimate }, judgeIncluded: JUDGE_HELD_BY_LEDGER, allowOver };
}

// ---------- estimates and forecast stops ----------

// What one review costs and how long it takes when no comparable run has
// measured it (P1's table; Codex reports tokens, not dollars, and its time
// is taken as Claude Code's).
export const DEFAULT_PER_REVIEW = {
  planted: { claude: { usd: 0.15, seconds: 40 }, codex: { usd: null, seconds: 40 } },
  aacr: { claude: { usd: 1, seconds: 300 }, codex: { usd: null, seconds: 300 } },
};

/** Every index entry under benchmark/index/runs/. */
export function readIndexEntries(dir = runsRoot) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

const reviewerOf = (job) => job.reviewer ?? String(job.config).split("-")[0];

const caseName = (id) => String(id).replace(/^[a-z]+\//, "").replace(/@[0-9a-f]+$/, "");

/**
 * What the planned `jobs` should cost and take: per configuration, the mean
 * cost and wall time of the comparable index entry (same suite, mode, path
 * and configuration) that ran the most of the planned cases, the newest of
 * those; else the default table.
 */
export function estimateRun({ jobs, suite = "planted", mode = "review", path = "laptop", concurrency = 1, index = readIndexEntries() }) {
  const perConfig = {};
  for (const job of jobs) {
    if (perConfig[job.config]) continue;
    const planned = new Set(jobs.filter((j) => j.config === job.config).map((j) => j.case ?? caseName(j.caseId)));
    const covers = (e) => (e.caseIds ?? []).filter((id) => planned.has(caseName(id))).length;
    const entry = index
      .filter((e) => (e.suite ?? "planted") === suite && (e.mode ?? "review") === mode && (e.path ?? "laptop") === path && e.scores?.[job.config] && (typeof e.scores[job.config].costUsdMean === "number" || typeof e.scores[job.config].wallMsMean === "number"))
      .sort((a, b) => covers(a) - covers(b) || `${a.date}\0${a.runId}`.localeCompare(`${b.date}\0${b.runId}`))
      .at(-1);
    const fallback = DEFAULT_PER_REVIEW[suite]?.[reviewerOf(job)] ?? { usd: null, seconds: null };
    const s = entry?.scores[job.config];
    perConfig[job.config] = {
      usd: typeof s?.costUsdMean === "number" ? s.costUsdMean : fallback.usd,
      seconds: typeof s?.wallMsMean === "number" ? s.wallMsMean / 1000 : fallback.seconds,
      from: entry ? `index entry ${entry.runId} (mean per review)` : "the default table",
    };
  }
  const priced = jobs.filter((j) => perConfig[j.config].usd !== null);
  const usd = priced.reduce((sum, j) => sum + perConfig[j.config].usd, 0);
  const seconds = jobs.reduce((sum, j) => sum + (perConfig[j.config].seconds ?? 0), 0);
  return { reviews: jobs.length, usd, unpriced: jobs.length - priced.length, minutes: seconds / Math.max(1, concurrency) / 60, perConfig };
}

/**
 * Why a run cannot start under its budget; empty when it can. A forecast
 * over a limit is refused unless --allow-over; a run cap that cannot hold
 * one review's cap, or a per-review cap on reviewers that report cost only
 * afterwards, is refused even then.
 */
export function startRefusals({ estimate, caps, forecast = {}, spentUsd = 0, allowOver = false, path = "laptop" }) {
  const out = [];
  if (path === "server" && caps.reviewMaxUsd !== null && caps.reviewMaxUsd !== undefined && caps.reviewMaxUsd > caps.maxUsd - spentUsd) {
    out.push(`one review may spend up to --review-max-usd ${money(caps.reviewMaxUsd)}, and the run's --max-usd ${money(caps.maxUsd)} has ${money(Math.max(0, caps.maxUsd - spentUsd))} left: no review could start`);
  }
  if (path === "laptop" && caps.reviewMaxUsd !== null && caps.reviewMaxUsd !== undefined) {
    out.push("--review-max-usd binds model calls before they are sent; Claude Code and Codex report their cost only after a review, so it cannot hold them. Leave it out of a laptop run.");
  }
  if (allowOver) return out;
  if (spentUsd + estimate.usd > caps.maxUsd) {
    out.push(`the estimate, ${money(estimate.usd)} for ${estimate.reviews - estimate.unpriced} reviews${spentUsd > 0 ? ` on top of ${money(spentUsd)} spent` : ""}, passes --max-usd ${money(caps.maxUsd)}; raise it, run fewer reviews, or add --allow-over to start anyway and stop at the cap`);
  }
  if (typeof forecast.maxMinutes === "number" && estimate.minutes > forecast.maxMinutes) {
    out.push(`the estimate, ${Math.ceil(estimate.minutes)} minutes, passes --max-minutes ${forecast.maxMinutes}; raise it, run fewer reviews, or add --allow-over to start anyway and stop at the limit`);
  }
  return out;
}

const median = (xs) => {
  const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (s.length === 0) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * The run's budget as executeRun asks it: `admit(job)` before each launch
 * (a ticket to close when the job ends, `wait`, or a stop), `stopped()`
 * after (an overrun), `summary()` for the manifest. `path` "server" holds
 * each model review's cap at its launch (its ticket is the review's meter);
 * "laptop" applies the forecast stops only, and run.mjs records each
 * review's reported cost with recordReview.
 */
export function runBudget({ dir, caps, forecast = {}, estimate = null, path = "laptop", prices = null, now = Date.now }) {
  const ledger = openLedger(dir, caps);
  const started = now();
  let running = 0;
  const stop = (limit, limitKind, why) => ({ how: "budget", limit, limitKind, why });
  const overrun = (o) => stop("worst-case", "hard", overrunWhy(o));
  const perReview = (s, config) => {
    const est = estimate?.perConfig?.[config] ?? null;
    return {
      usd: median(s.reviews.map((r) => r.usd)) ?? est?.usd ?? null,
      seconds: median(s.reviews.map((r) => (typeof r.wallMs === "number" ? r.wallMs / 1000 : null))) ?? est?.seconds ?? null,
      tokens: median(s.reviews.map((r) => r.tokens)),
    };
  };
  return {
    ledger,
    admit(job) {
      const s = ledger.state();
      if (s.overruns.length > 0) return { stop: overrun(s.overruns[0]) };
      const per = perReview(s, job.config);
      const elapsedMin = (now() - started) / 60_000;
      if (typeof forecast.maxReviews === "number" && s.launched >= forecast.maxReviews) return { stop: stop("max-reviews", "forecast", `forecast stop --max-reviews ${forecast.maxReviews}: ${s.launched} reviews started`) };
      if (typeof forecast.maxMinutes === "number" && per.seconds !== null && elapsedMin + per.seconds / 60 > forecast.maxMinutes) {
        return { stop: stop("max-minutes", "forecast", `forecast stop --max-minutes ${forecast.maxMinutes}: ${elapsedMin.toFixed(1)} minutes gone, and a review takes about ${Math.round(per.seconds)} s`) };
      }
      if (typeof forecast.maxTokens === "number" && per.tokens !== null && s.tokens + (running + 1) * per.tokens > forecast.maxTokens) {
        return { stop: stop("max-tokens", "forecast", `forecast stop --max-tokens ${forecast.maxTokens}: ${s.tokens} tokens used, and a review uses about ${Math.round(per.tokens)}`) };
      }
      if (path === "laptop") {
        if (per.usd !== null && s.spentUsd + (running + 1) * per.usd > caps.maxUsd) {
          return { stop: stop("max-usd", "forecast", `forecast stop --max-usd ${money(caps.maxUsd)}: ${money(s.spentUsd)} spent, and a review costs about ${money(per.usd)}${running > 0 ? ` (${running} running)` : ""}; the reviewer reports its cost only afterwards, so this is a forecast`) };
        }
        ledger.noteLaunch(job.jobId);
        running++;
        return { ok: true, review: { close: () => running-- } };
      }
      const meter = ledger.openReview({ jobId: job.jobId, prices });
      if (meter.ok !== true) return meter.wait ? { wait: true } : { stop: stop("max-usd", "hard", meter.why) };
      ledger.noteLaunch(job.jobId);
      return { ok: true, review: meter };
    },
    /** Another review's meter for the same job (a retry), or a stop. */
    openReview(job) {
      const meter = ledger.openReview({ jobId: job.jobId, prices });
      return meter.ok === true ? { ok: true, review: meter } : { stop: stop("max-usd", "hard", meter.why) };
    },
    /** A laptop review's reported cost, tokens and time. */
    recordReview({ jobId, usd = null, tokens = null, wallMs = null }) {
      ledger.spend(usd, jobId);
      ledger.noteReview({ jobId, usd, tokens, wallMs });
    },
    stopped() {
      const s = ledger.state();
      return s.overruns.length > 0 ? overrun(s.overruns[0]) : null;
    },
    summary() {
      const s = ledger.state();
      return { spentUsd: s.spentUsd, reservedUsd: s.reservedUsd, elapsedMin: Number(((now() - started) / 60_000).toFixed(2)) };
    },
  };
}
