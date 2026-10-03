// What the agent hook decides before a `git push`. It never allows: an allow
// would skip the developer's own permission prompt for the push. It abstains
// (optionally with a note) or, only when block_on_severity is set, denies.
import { countedSeverities, severityBreakdown } from "./render/common.js";
import type { Config, Latest, PushDecision, Report } from "./types.js";

const REVIEW_STEP =
  'ask the agent to "review my change with openqodex" (the openqodex skill runs the review)';

function reportPath(latest: Latest): string {
  return `${latest.dir}/report.md`;
}

function counts(report: Report | null): string | null {
  if (!report) return null;
  const severities = countedSeverities(report);
  return severities.length > 0 ? severityBreakdown(severities) : null;
}

export function checkPush(args: {
  currentChangeId: string;
  latest: Latest | null;
  report: Report | null;
  config: Config;
}): PushDecision {
  const { currentChangeId, latest, report, config } = args;
  const threshold = config.blockOnSeverity;
  const sameChange =
    latest !== null && latest.kind === "review" && latest.finalized && latest.change_id === currentChangeId;
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
    if (!threshold) return { decision: "abstain", message: `${notReviewed}. To review it before pushing, ${REVIEW_STEP}.` };
    return {
      decision: "deny",
      message: `${notReviewed}, and this repo blocks a push without a passing review (block_on_severity: ${threshold}). To review it, ${REVIEW_STEP}, then push again.`,
    };
  }

  const found = counts(report);
  if (threshold && latest.verdict !== "passed") {
    return {
      decision: "deny",
      message: `OpenQodex blocks this push: the review of this change found ${found ?? "findings"}, at or above ${threshold} (see ${reportPath(latest)}). Fix them, review again (${REVIEW_STEP}), then push.`,
    };
  }
  return {
    decision: "abstain",
    message: found ? `OpenQodex review of this change: ${found}. Report: ${reportPath(latest)}` : null,
  };
}
