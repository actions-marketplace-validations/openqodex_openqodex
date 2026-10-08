// Rules of different scanners that name one problem. When two of them report
// it on overlapping lines of one file, the report keeps one finding: the
// higher severity, or on a tie the scanner earlier in the ensemble
// (adapters/index.ts). Rules outside this table merge only as run.ts
// classes them, on the very same lines.
//
// Each group was checked on a planted case through the real binaries at
// their pinned versions; the spans each scanner reports differ (a whole
// resource, one attribute, one expression), so a group merges on overlap,
// not on equal lines.

import type { BuiltinScanner, StaticFinding } from "@openqodex/core";

type Member = {
  source: BuiltinScanner;
  // The rule id, exactly or by pattern.
  rule: string | RegExp;
  // For a rule id that covers several problems (actionlint's `expression`),
  // the message that names this one.
  message?: RegExp;
};

type Group = { name: string; members: Member[] };

export const SAME_PROBLEM: readonly Group[] = [
  {
    // A `${{ }}` expression with text an attacker controls, pasted into a
    // `run:` script.
    name: "workflow-untrusted-input-in-script",
    members: [
      { source: "semgrep", rule: "yaml.github-actions.security.run-shell-injection.run-shell-injection" },
      { source: "actionlint", rule: "expression", message: /potentially untrusted/i },
      { source: "zizmor", rule: "template-injection" },
    ],
  },
];

const matches = (m: Member, f: StaticFinding): boolean =>
  m.source === f.source &&
  (typeof m.rule === "string" ? m.rule === f.ruleId : m.rule.test(f.ruleId)) &&
  (m.message === undefined || m.message.test(f.message));

// "same:<group>" for a finding a group names, or null.
export function sameProblemClass(f: StaticFinding): string | null {
  for (const group of SAME_PROBLEM) {
    if (group.members.some((m) => matches(m, f))) return `same:${group.name}`;
  }
  return null;
}
