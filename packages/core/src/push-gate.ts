// What the agent hook decides before a `git push`. It never allows: an allow
// would skip the developer's own permission prompt for the push. It abstains
// (optionally with a note) or, only when block_on_severity is set, denies.
import { countedSeverities, severityBreakdown } from "./render/common.js";
import type { Config, Latest, PushDecision, Report } from "./types.js";

const REVIEW_STEP = "run openqodex review";

function reportPath(latest: Latest): string {
  return `${latest.dir}/report.md`;
}

function counts(report: Report | null): string | null {
  if (!report) return null;
  const severities = countedSeverities(report);
  return severities.length > 0 ? severityBreakdown(severities) : null;
}

// What kind of review a receipt records: "complete" or "incomplete" for a
// review `review` ran with its own reviewer (its completion record decides),
// "legacy" for one from the two-step protocol, which never counts as an
// independent review. Null when there is no review receipt.
export type ReceiptKind = "complete" | "incomplete" | "legacy";

export function receiptKind(latest: Latest | null, report: Report | null): ReceiptKind | null {
  if (latest === null || latest.kind !== "review") return null;
  if (latest.completion === undefined) return "legacy";
  return latest.completion === "complete" && report?.completion?.status === "complete" ? "complete" : "incomplete";
}

// The lookup both push hooks make: the receipt of exactly the change being
// pushed. A complete passing review is silent; a complete blocked one denies
// when block_on_severity is set; none asks for `openqodex review` (and denies
// when a threshold is set, so the agent reviews and retries); an incomplete
// record never blocks. A legacy receipt counts as reviewed, with one line
// saying it was not an independent review.
export function checkPush(args: {
  currentChangeId: string;
  latest: Latest | null;
  report: Report | null;
  config: Config;
}): PushDecision {
  const { currentChangeId, latest, report, config } = args;
  const threshold = config.blockOnSeverity;
  const kind = receiptKind(latest, report);
  const sameId = latest !== null && latest.change_id === currentChangeId;

  if (sameId && kind === "incomplete" && latest) {
    const why = report?.completion?.missing[0];
    return {
      decision: "abstain",
      message: `OpenQodex: the last review of this change was incomplete${why ? ` (${why})` : ""}, so it does not block. To finish it, ${REVIEW_STEP}. Report: ${reportPath(latest)}`,
    };
  }

  const sameChange = sameId && latest !== null && latest.finalized && (kind === "complete" || kind === "legacy");
  // The config lives in .openqodex/, outside the change, so raising the
  // threshold does not move the change id: a review judged under another
  // threshold does not count once one is set.
  const otherRule = sameChange && threshold !== null && report?.block_on_severity !== threshold;
  const reviewed = sameChange && !otherRule;
  const earlier = latest !== null && latest.finalized && latest.change_id !== currentChangeId;
  const notReviewed = `OpenQodex has not reviewed this change${
    otherRule ? " under the current block_on_severity" : earlier ? " (the last review was of an earlier version)" : ""
  }`;

  if (!reviewed || !latest) {
    if (!threshold) return { decision: "abstain", message: `${notReviewed}. Run openqodex review before pushing.` };
    return {
      decision: "deny",
      message: `${notReviewed}, and this repo blocks a push without a passing review (block_on_severity: ${threshold}). Run openqodex review, then push again.`,
    };
  }

  const legacy = kind === "legacy" ? " This was not an independent review: it came from the older two-step protocol." : "";
  const found = counts(report);
  if (threshold && latest.verdict !== "passed") {
    return {
      decision: "deny",
      message: `OpenQodex blocks this push: the review of this change found ${found ?? "findings"}, at or above ${threshold} (see ${reportPath(latest)}). Fix them, ${REVIEW_STEP} again, then push.${legacy}`,
    };
  }
  if (kind === "legacy") {
    return { decision: "abstain", message: `OpenQodex review of this change: ${found ?? "no findings"}. Report: ${reportPath(latest)}.${legacy}` };
  }
  return { decision: "abstain", message: null };
}
