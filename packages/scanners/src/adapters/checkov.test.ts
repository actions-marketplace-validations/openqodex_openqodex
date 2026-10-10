// The Checkov report parser, on a report the 3.3.22 binary wrote for
// test/fixtures/trivy/repo (saved as test/fixtures/checkov/report.json, its
// local paths replaced). Where a finding is anchored from its evaluated keys
// is iac.test.ts's.
//
// Failure list, written before the code:
//   1. A failed check of one of the three frameworks is dropped, or names a
//      path other than the repository's (checkov writes "/infra/main.tf").
//   2. The evaluated keys are lost, so a finding cannot be anchored to the
//      attributes it names.
//   3. A finding gets a severity Checkov never gave (it gives none without
//      its platform): every one is medium.
//   4. The reference does not name the check: a Python check's source at the
//      pinned version, a graph check's policy index for its framework.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCheckovJson } from "./checkov.js";

const report = readFileSync(new URL("../../test/fixtures/checkov/report.json", import.meta.url), "utf8");

describe("parseCheckovJson", () => {
  const findings = parseCheckovJson(report, "3.3.22");

  it("keeps every failed check of the three frameworks on the repository's path and the resource's lines (1, 3)", () => {
    expect(findings).toHaveLength(30);
    const rows = findings.map((f) => [f.ruleId, f.filePath, f.lineStart, f.lineEnd, f.severity]);
    expect(rows).toContainEqual(["CKV_AWS_24", "infra/main.tf", 1, 12, "medium"]);
    expect(rows).toContainEqual(["CKV2_AWS_6", "infra/main.tf", 14, 16, "medium"]);
    expect(rows).toContainEqual(["CKV_AWS_24", "cfn/stack.yaml", 3, 12, "medium"]);
    expect(rows).toContainEqual(["CKV_K8S_16", "k8s/pod.yaml", 1, 10, "medium"]);
    expect(new Set(findings.map((f) => f.severity))).toEqual(new Set(["medium"]));
  });

  it("links a Python check's source at the pinned version and a graph check's policy index (4)", () => {
    const sg = findings.find((f) => f.ruleId === "CKV_AWS_24" && f.filePath === "infra/main.tf");
    expect(sg).toMatchObject({
      source: "checkov",
      message: "Ensure no security groups allow ingress from 0.0.0.0:0 to port 22",
      reference: "https://github.com/bridgecrewio/checkov/blob/3.3.22/checkov/terraform/checks/resource/aws/SecurityGroupUnrestrictedIngress22.py",
    });
    expect(findings.find((f) => f.ruleId === "CKV2_AWS_6")?.reference).toBe("https://www.checkov.io/5.Policy%20Index/terraform.html");
    expect(findings.find((f) => f.ruleId === "CKV_K8S_16")?.reference).toBe(
      "https://github.com/bridgecrewio/checkov/blob/3.3.22/checkov/kubernetes/checks/resource/k8s/PrivilegedContainers.py",
    );
  });

  it("reads a report of one framework, not a list, and an empty run", () => {
    const one = JSON.stringify({ check_type: "kubernetes", results: { failed_checks: [{ check_id: "CKV_K8S_1", check_name: "x", file_path: "/a.yaml", file_line_range: [2, 5], check_class: "checkov.kubernetes.checks.resource.k8s.X", check_result: { evaluated_keys: [] } }] } });
    expect(parseCheckovJson(one, "3.3.22").map((f) => [f.ruleId, f.filePath, f.lineStart, f.lineEnd])).toEqual([["CKV_K8S_1", "a.yaml", 2, 5]]);
    expect(parseCheckovJson(JSON.stringify({ passed: 0, failed: 0, skipped: 0, parsing_errors: 0, resource_count: 0, checkov_version: "3.3.22" }), "3.3.22")).toEqual([]);
  });
});
