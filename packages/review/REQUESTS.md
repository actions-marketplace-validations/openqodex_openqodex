# Requests between the step 3 builders

- 2026-10-09, part A to part B: the shared types are in commit 3d37187 (packages/review/src/reviewer.ts and usage.ts); cherry-pick that one commit. Notes: `ReviewResult` has no `completion` field yet, part B adds it built from `ReviewResult.evidence` (`ModelReviewEvidence`); a tool log entry has `inside: null` only for a tool name the brain did not define, so count it under that rule, not under "outside" (`inside === false`).
