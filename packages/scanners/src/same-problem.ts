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
  // trivy config 0.75.0 and Checkov 3.3.22 on the same resource and lines:
  // each pair names one missing setting (adapters-iac.subprocess.test.ts).
  // trivy splits the S3 public access block into four checks; Checkov has one.
  { name: "s3-public-access-block", members: [...["AWS-0086", "AWS-0087", "AWS-0091", "AWS-0093"].map((rule) => ({ source: "trivy" as const, rule })), { source: "checkov", rule: "CKV2_AWS_6" }] },
  { name: "s3-versioning", members: [{ source: "trivy", rule: "AWS-0090" }, { source: "checkov", rule: "CKV_AWS_21" }] },
  { name: "s3-access-logging", members: [{ source: "trivy", rule: "AWS-0089" }, { source: "checkov", rule: "CKV_AWS_18" }] },
  { name: "s3-customer-managed-key", members: [{ source: "trivy", rule: "AWS-0132" }, { source: "checkov", rule: "CKV_AWS_145" }] },
  { name: "rds-publicly-accessible", members: [{ source: "trivy", rule: "AWS-0180" }, { source: "checkov", rule: "CKV_AWS_17" }] },
  { name: "rds-iam-authentication", members: [{ source: "trivy", rule: "AWS-0176" }, { source: "checkov", rule: "CKV_AWS_161" }] },
  { name: "kubernetes-cpu-limit", members: [{ source: "trivy", rule: "KSV-0011" }, { source: "checkov", rule: "CKV_K8S_11" }] },
  { name: "kubernetes-cpu-request", members: [{ source: "trivy", rule: "KSV-0015" }, { source: "checkov", rule: "CKV_K8S_10" }] },
  { name: "kubernetes-memory-request", members: [{ source: "trivy", rule: "KSV-0016" }, { source: "checkov", rule: "CKV_K8S_12" }] },
  { name: "kubernetes-memory-limit", members: [{ source: "trivy", rule: "KSV-0018" }, { source: "checkov", rule: "CKV_K8S_13" }] },
];

// A RustSec advisory id. osv-scanner (through osv.dev) and cargo-deny
// (through the RustSec database) both report a Rust advisory under it, on the
// crate's Cargo.lock entry: one problem, so the two merge on the same lines.
export const RUSTSEC_ID = /^RUSTSEC-\d{4}-\d{4,}$/;
const ADVISORY_SCANNERS: ReadonlySet<string> = new Set<BuiltinScanner>(["osv-scanner", "cargo-deny"]);

const matches = (m: Member, f: StaticFinding): boolean =>
  m.source === f.source &&
  (typeof m.rule === "string" ? m.rule === f.ruleId : m.rule.test(f.ruleId)) &&
  (m.message === undefined || m.message.test(f.message));

// "same:<group>" for a finding a group names, "same:advisory:<id>" for a
// RustSec advisory, or null.
export function sameProblemClass(f: StaticFinding): string | null {
  for (const group of SAME_PROBLEM) {
    if (group.members.some((m) => matches(m, f))) return `same:${group.name}`;
  }
  if (ADVISORY_SCANNERS.has(f.source) && RUSTSEC_ID.test(f.ruleId)) return `same:advisory:${f.ruleId}`;
  return null;
}
