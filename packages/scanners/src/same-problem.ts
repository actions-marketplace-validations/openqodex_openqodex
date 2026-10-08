// Rules of different scanners that name one problem. When two of them report
// it on the same lines of one file, the report keeps one finding: the higher
// severity, or on a tie the scanner earlier in the ensemble
// (adapters/index.ts); the finding kept names the others. Findings on
// different lines never merge, even where their spans overlap: a wide span
// (a whole resource) must not hide a narrower finding it does not name.
//
// Each group was checked on a planted case through the real binaries at
// their pinned versions.

import type { BuiltinScanner, StaticFinding } from "@openqodex/core";

type Member = {
  source: BuiltinScanner;
  // The rule id, exactly or by pattern.
  rule: string | RegExp;
  // For a rule id that covers several problems (actionlint's `expression`),
  // the message that names this one, anchored to the scanner's own words: a
  // message can quote text from the repository.
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
      // actionlint 1.7.7 expr_insecure.go, its two messages for this check:
      // "%q is potentially untrusted. avoid using it directly in inline
      // scripts...", where %q escapes every quote and backslash inside the
      // property path, and "object filter extracts potentially untrusted
      // properties %s...", whose start no other check writes.
      { source: "actionlint", rule: "expression", message: /^"(?:[^"\\]|\\.)*" is potentially untrusted\. avoid using it directly in inline scripts\./ },
      { source: "actionlint", rule: "expression", message: /^object filter extracts potentially untrusted properties / },
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
