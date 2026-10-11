// The three stages of one change in the reviewer loop (P3 part 4.4, PLAN
// 4.11), as loop.mjs runs them. Each stage says what it runs, how it ends
// and what its ledger line records.
//
// Looks (plan clarification A2): a look is a point where a change can be
// accepted. Stage 2 and stage 3 each take one through decide.mjs, and the
// look counter t advances under the ledger lock. Stage 1 can only stop, so
// it takes no look: its line records look null, and its reading of the rule
// uses the alpha of the look that is due without spending it.
//
// Stage 1, the screen. The target path only, one repeat of the candidate on
// the whole population of the parent's runs, against the parent's saved
// runs. It may only stop a change, never accept one. It stops when:
// - the primary's point estimate on the target path is not better than
//   zero, for any reviewer there (the decision reading: the bound worse for
//   the change);
// - a guard's point estimate is worse by more than twice its acceptable
//   loss, on any cell and stratum;
// - a critical truth item the parent found in every one of its three or
//   more reviews of a case is missed by the candidate in two or more cases;
// - the change has spent 40 percent of its cap (server dollars or laptop
//   reviews);
// - or the acceptance rule itself reads harm at this look (decide.mjs
//   "stopped-early").
// Exit: "stopped-early" (decided), or on to stage 2. Records: no look (look
// and alpha null), every cell's readings, each screen rule with whether it
// fired, and the spend.
//
// Stage 2, the decision. Every path the change runs on, three repeats of
// every reviewer, the candidate's target run grown from one repeat to three.
// decide.mjs decides. Exit: accepted, reverted, inconclusive-reverted,
// measured (a record whose aim is measure), or stage 3 when the primary is
// the only open question. Records: the decision line of decide.mjs with
// the spend.
//
// Stage 3, the confirmation. Repeats 4 to 6 on the target path, for the
// candidate and the parent; the other paths keep their three. decide.mjs
// decides, and stage 3 is final: still inconclusive reverts. Records: as
// stage 2.
//
// A stage whose runs stop before they finish (the day's server cap, a time
// limit, a reviewer failure) takes no look: its line records the spend with
// `look: null` and the next step finishes the same stage. A stage stopped
// by the change's own cap is decided inconclusive-reverted, since nothing
// more may be spent on it.
//
// Runs of the scripted model (model:scripted, the stand-in tests and dry
// runs review with) are no evidence about a change: it reads no code, so a
// parent and a candidate it reviewed agree whatever the change did. A stage
// on them takes no look, records the spend and "no evidence", and neither
// stops nor passes the change; only a real reviewer's runs decide.
//
// Failure list, written before the code:
// 1. An iteration behind after stage 1 spends through stage 3: stage 1 stops
//    on point estimates, which one repeat can give, where the interval rule
//    alone needs more repeats than stage 1 has to see any harm.
// 2. A screen stop reads noise as an accept: stage 1 only stops; nothing it
//    reads can accept.
// 3. Two changes are decided against the same parent at once, so both are
//    kept and their sum was never measured: one change at a time is in
//    stage 2 or 3.
// 4. A stage decided on part of its runs (a run cut short by a cap) reads
//    the missing reviews as nothing found: a stage whose runs did not finish
//    takes no look and decides nothing.
// 5. A scripted screen stops a change as evidence: the scripted model's
//    runs never stop, pass or decide a change.
import { GATE_METRICS, lossIn, metricOf } from "./compare.mjs";

/** The reviewers among `runs` (each with its manifest) that are the scripted model, as "<run id>: <reviewer>". */
export function scriptedReviewers(runs) {
  return runs.flatMap((run) => Object.entries(run.manifest?.reviewers ?? {}).filter(([name, r]) => name === "model:scripted" || Boolean(r?.script)).map(([name]) => `${run.runId}: ${name}`));
}

/** Each stage's repeats: on the target path, and on every other path the change runs on. */
export const STAGES = Object.freeze({
  1: Object.freeze({ name: "screen", repeats: Object.freeze({ target: 1, other: 0 }) }),
  2: Object.freeze({ name: "decision", repeats: Object.freeze({ target: 3, other: 3 }) }),
  3: Object.freeze({ name: "confirmation", repeats: Object.freeze({ target: 6, other: 3 }) }),
});

/** The screen's limits: a guard past this many times its loss, critical items missed in this many cases, this share of the cap spent. */
export const SCREEN = Object.freeze({ guardTimes: 2, criticalCases: 2, criticalParentReviews: 3, capShare: 0.4 });

/** A parent run older than this is not reused (P3 question 8). */
export const PARENT_MAX_AGE_DAYS = 7;

const EPS = 1e-12;

/** The repeats a stage needs of a run on `path` when the change targets `target`. */
export const repeatsFor = (stage, path, target) => STAGES[stage].repeats[path === target ? "target" : "other"];

/**
 * Where a change stands in the ledger: its proposed record, its own stage
 * lines, its decision line (or null), and the stage due next (null once
 * decided). A stage line that completed its stage without a decision
 * (`stageDone`, or a look taken by decide.mjs) moves the change on; one
 * that did not (runs cut short, no evidence) leaves the same stage due.
 */
export function changeState(lines, id) {
  const proposed = lines.find((l) => l.event === "proposed" && l.id === id) ?? null;
  const mine = lines.filter((l) => l.id === id && l.event !== "proposed");
  const decided = mine.find((l) => l.event === "decided") ?? null;
  const done = mine.filter((l) => l.event === "stage" && (l.stageDone === true || (l.look !== null && l.look !== undefined)));
  const last = done.at(-1);
  const due = decided ? null : last ? last.stage + 1 : 1;
  return { proposed, record: proposed?.record ?? null, lines: mine, decided, due };
}

/** Another change in stage 2 or 3 and not yet decided (failure 3), or null. */
export function inDecision(lines, id) {
  const ids = [...new Set(lines.filter((l) => l.event === "proposed" && l.id !== id).map((l) => l.id))];
  return ids.find((other) => {
    const s = changeState(lines, other);
    return s.decided === null && s.lines.some((l) => typeof l.stage === "number" && l.stage >= 2);
  }) ?? null;
}

const fmt = (metric, x) => {
  const sign = x < 0 ? "-" : "+";
  const a = Math.abs(x);
  return metricOf(metric).unit === "points" ? `${sign}${(a * 100).toFixed(1)} points` : metric === "costPerReview" ? `${sign}$${a.toFixed(4)}` : metric === "secondsPerReview" ? `${sign}${a.toFixed(1)} s` : `${sign}${a.toFixed(3)}`;
};

/**
 * The stage 1 screen over one decide.mjs result. `pairs` are the compare.mjs
 * pairs the result read (their sides hold every review, the parent's
 * repeats all of them); `spent` is what the change has spent, this step
 * included. Returns every rule with whether it fired and why.
 */
export function screen({ result, pairs, record, spent }) {
  const rules = [];
  const primary = record.primary.metric;
  const up = (m) => metricOf(m).better === "higher";

  for (const cell of result.cells.filter((c) => c.target)) {
    const r = cell.strata.pooled.metrics[primary];
    const better = r.measured && r.comparable && (up(primary) ? r.delta > EPS : r.delta < -EPS);
    rules.push({ rule: "primary", fired: !better, text: `the primary ${primary} on ${cell.path} ${cell.reviewer} ${!r.measured ? "is not measured" : !r.comparable ? "is not comparable" : `moved ${fmt(primary, r.delta)}`}${better ? "" : ", not better than zero"}` });
  }

  for (const cell of result.cells) {
    for (const stratum of ["planted", "real", "pooled"]) {
      const s = cell.strata[stratum];
      if (s === null || (stratum !== "pooled" && s === cell.strata.pooled)) continue;
      for (const m of GATE_METRICS) {
        if (cell.target && stratum === "pooled" && m === primary) continue;
        const r = s.metrics[m];
        if (!r.measured || !r.comparable) continue;
        const loss = lossIn(m, record.acceptableLoss[m], r.parent);
        const worse = up(m) ? -r.delta : r.delta;
        if (worse > SCREEN.guardTimes * loss + EPS) rules.push({ rule: "guard", fired: true, text: `${cell.path} ${cell.reviewer} (${stratum}): ${m} moved ${fmt(m, r.delta)}, past twice its loss of ${fmt(m, loss).slice(1)}` });
      }
    }
  }

  const missed = [];
  for (const { parent, candidate } of pairs.filter((p) => p.parent.path === record.target)) {
    for (const id of parent.caseIds) {
      const a = parent.jobs.filter((j) => j.caseId === id);
      const b = candidate.jobs.filter((j) => j.caseId === id);
      if (a.length < SCREEN.criticalParentReviews || b.length === 0) continue;
      const lost = a[0].bugs.filter((bug) => bug.severity === "critical" && a.every((j) => j.bugs.find((x) => x.id === bug.id)?.found) && b.every((j) => !j.bugs.find((x) => x.id === bug.id)?.found));
      if (lost.length > 0) missed.push(`${id} (${lost.map((x) => x.id).join(", ")})`);
    }
  }
  rules.push({ rule: "critical", fired: missed.length >= SCREEN.criticalCases, text: `${missed.length} cases lose a critical item the parent found in every review${missed.length > 0 ? `: ${missed.slice(0, 5).join("; ")}` : ""}` });

  const usd = record.capUsd * SCREEN.capShare;
  const reviews = record.capReviews * SCREEN.capShare;
  const overCap = spent.serverUsd > usd + EPS || spent.laptopReviews > reviews + EPS;
  rules.push({ rule: "cap", fired: overCap, text: `the change has spent $${spent.serverUsd.toFixed(4)} of its $${record.capUsd} server cap and ${spent.laptopReviews} of its ${record.capReviews} laptop reviews; the screen stops at ${SCREEN.capShare * 100} percent` });

  rules.push({ rule: "acceptance rule", fired: result.decision === "stopped-early", text: result.decision === "stopped-early" ? "the acceptance rule reads harm at the alpha of the look that is due" : "the acceptance rule reads no harm at the alpha of the look that is due" });
  return rules;
}

/** How a stage ends: the line's event, decision and reason, from decide.mjs's result and, at stage 1, the screen. */
export function stageOutcome(stage, result, rules = []) {
  if (stage !== 1) return { event: result.event, decision: result.decision, reason: result.reason };
  const fired = rules.filter((r) => r.fired);
  if (fired.length > 0) return { event: "decided", decision: "stopped-early", reason: `stopped-early at the stage 1 screen: ${fired.map((r) => r.text).join("; ")}. The interval rule at the alpha of the look that is due (stage 1 takes none): ${result.reason}` };
  return { event: "stage", decision: null, reason: `the stage 1 screen passed, so stage 2 runs next: ${rules.map((r) => r.text).join("; ")}. The interval rule at the alpha of the look that is due (stage 1 takes none): ${result.reason}` };
}
