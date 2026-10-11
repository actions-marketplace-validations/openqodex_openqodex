// The halt rules of a model reviewer run (PLAN-benchmark 4.7, P4 4.5): after
// each saved review, run.mjs asks whether the run should stop and ask a
// person, rather than spend on. A halt names its rule and why; run.mjs
// records it in the run's end record (`ended.halt`) and stops launching,
// the reviews running finish and are saved, and --resume continues.
//
// The rules, in the order they are asked:
// - provider-blocked: the endpoint refused the key (HTTP 401 or 403) or the
//   quota (a 429 that names a quota, or insufficient_quota). At once: every
//   later call would get the same answer.
// - served-model-changed: a review names a served model the earlier reviews
//   of its configuration did not, or names two. The deployment changed
//   under the run. Each configuration (each model reviewer) has its own.
// - same-reason-twice: two reviews in a row, in the order they ended, did
//   not complete, for the same reason class (reasonClass).
// - from the 10th review of this invocation on: incomplete-share (more than
//   20% did not complete), cost-over-estimate (the mean cost per review is
//   past 1.5 times the estimate, when the run had one) and forecast-past-cap
//   (what is spent, plus the mean cost for each review left, passes
//   --max-usd).
// Hard caps are lib/budget.mjs's and are not repeated here.
//
// Failure list, written before the code:
// 1. A key or quota refusal is read as one more incomplete review, and the
//    run spends its envelopes on calls that cannot be answered.
// 2. A deployment that changes during the run mixes two models in one run.
// 3. Two reviews that end incomplete for one cause (a broken setup) are
//    followed by a third; or two for different causes halt the run.
// 4. A run whose reviews mostly fail, or cost far more than planned, spends
//    to its cap before anyone looks.
// 5. A resumed run halts again at once on the counts that halted it: every
//    count is of this invocation only; the served models seen before are
//    carried in, since a model change across a resume is still a change.

/** Reviews of one invocation before the share and cost rules apply. */
export const HALT_AFTER = 10;
/** The share of reviews that may end not complete. */
export const MAX_NOT_COMPLETE_SHARE = 0.2;
/** How far the mean cost per review may pass the run's estimate. */
export const COST_OVER_ESTIMATE = 1.5;

// Reason classes, the first that matches a failure's text, in this order.
const CLASSES = [
  ["provider-auth", /\bHTTP 40[13]\b/],
  ["provider-quota", /insufficient_quota|\bHTTP 429\b[^;]*quota/i],
  ["provider-rate-limit", /\bHTTP 429\b/],
  ["provider", /the model call failed|the model endpoint|reply could not be read/],
  ["budget", /budget refused/],
  ["deadline", /timed out|deadline/],
  ["answer-checks", /answer still failed \d+ checks?/],
  ["coverage", /ranges? (?:was|were) not (?:read|given|sent)/],
  ["objects", /missing objects|not a commit|missing commit|history unknown|diverged|git failed/],
  ["outside", /outside its workDir/],
  ["threw", /the review threw/],
];

/** The reason class of a failure's text: a named class, or "other: " and the text with its numbers taken out. */
export function reasonClass(failure) {
  const text = String(failure ?? "");
  for (const [name, re] of CLASSES) if (re.test(text)) return name;
  return `other: ${text.split(";")[0].replace(/\d+/g, "N").trim().slice(0, 120)}`;
}

/** Why the endpoint will refuse every later call (a key or quota refusal), or null. */
export function providerBlock(failure) {
  const c = reasonClass(failure);
  if (c !== "provider-auth" && c !== "provider-quota") return null;
  const re = CLASSES.find(([name]) => name === c)[1];
  return String(failure).split(";").map((part) => part.trim()).find((part) => re.test(part)) ?? String(failure);
}

const money = (usd) => `$${usd.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;

/**
 * The halt rules of one invocation. `maxUsd` is the run's cap, `toRun` the
 * reviews this invocation plans, `estimatePerReview` the estimate's dollars
 * per review (null when there is none), `servedBefore` the served models
 * the run's earlier samples named, per configuration ({ <config>: [models] }),
 * and `spentBefore` what the run had spent
 * when this invocation started. `after(record, { spentUsd })` is asked with
 * each saved sample record (lib/server-review.mjs) and the ledger's total
 * spent; it returns { rule, why } or null.
 */
export function haltRules({ maxUsd, toRun, estimatePerReview = null, servedBefore = {}, spentBefore = 0 }) {
  // Per configuration: each model reviewer of a run answers from its own deployment.
  const servedBy = new Map(Object.entries(servedBefore).map(([config, models]) => [config, new Set(models.filter((m) => typeof m === "string" && m !== ""))]));
  let reviews = 0;
  let notComplete = 0;
  let lastClass = null;
  const halt = (rule, why) => ({ rule, why });
  return {
    after(rec, { spentUsd }) {
      reviews++;
      const ok = rec.status === "complete";
      const cls = ok ? null : reasonClass(rec.failure ?? rec.status);
      if (!ok) notComplete++;
      const blocked = ok ? null : providerBlock(rec.failure);
      if (blocked !== null) return halt("provider-blocked", `the model endpoint refused the key or the quota (${cls}): ${blocked}`);
      const named = (rec.servedModels ?? []).filter((m) => typeof m === "string" && m !== "");
      if (named.length > 1) return halt("served-model-changed", `one review was answered by ${named.join(" and ")}`);
      if (!servedBy.has(rec.config)) servedBy.set(rec.config, new Set());
      const served = servedBy.get(rec.config);
      const fresh = named.filter((m) => !served.has(m));
      if (fresh.length > 0 && served.size > 0) return halt("served-model-changed", `the served model of ${rec.config} changed from ${[...served].join(" and ")} to ${fresh.join(" and ")}`);
      for (const m of named) served.add(m);
      const previous = lastClass;
      lastClass = cls;
      if (cls !== null && previous === cls) return halt("same-reason-twice", `two reviews in a row did not complete for one reason (${cls}): ${String(rec.failure ?? rec.status).slice(0, 300)}`);
      if (reviews < HALT_AFTER) return null;
      if (notComplete / reviews > MAX_NOT_COMPLETE_SHARE) return halt("incomplete-share", `${notComplete} of ${reviews} reviews did not complete, more than ${MAX_NOT_COMPLETE_SHARE * 100}%`);
      const mean = (spentUsd - spentBefore) / reviews;
      if (typeof estimatePerReview === "number" && estimatePerReview > 0 && mean > COST_OVER_ESTIMATE * estimatePerReview) {
        return halt("cost-over-estimate", `a review costs ${money(mean)} on average, more than ${COST_OVER_ESTIMATE} times the estimate of ${money(estimatePerReview)}`);
      }
      const left = Math.max(0, toRun - reviews);
      if (spentUsd + mean * left > maxUsd) return halt("forecast-past-cap", `${money(spentUsd)} is spent and ${left} reviews are left at ${money(mean)} each on average, which passes --max-usd ${money(maxUsd)}`);
      return null;
    },
  };
}
