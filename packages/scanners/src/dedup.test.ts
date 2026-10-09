import { describe, expect, it } from "vitest";
import { dedupByRuleClass, ruleClassFor } from "./run.js";
import type { StaticFinding } from "@openqodex/core";

function fakeFinding(over: Partial<StaticFinding> = {}): StaticFinding {
  return {
    source: "semgrep",
    ruleId: "rule-id",
    filePath: "src/a.ts",
    lineStart: 10,
    lineEnd: 10,
    severity: "high",
    message: "msg",
    reference: null,
    ...over,
  };
}

describe("ruleClassFor", () => {
  it("classes every gitleaks finding as 'secret'", () => {
    expect(ruleClassFor(fakeFinding({ source: "gitleaks", ruleId: "any-rule" }))).toBe("secret");
  });

  it("classes semgrep secret-related rules as 'secret'", () => {
    for (const id of [
      "javascript.lang.security.audit.hardcoded-secret",
      "generic.secrets.gitleaks.aws-access-key",
      "go.lang.security.audit.credential-leak",
      "javascript.express.audit.api-key-in-source",
    ]) {
      expect(ruleClassFor(fakeFinding({ ruleId: id }))).toBe("secret");
    }
  });

  it("classes semgrep injection rules as 'injection'", () => {
    for (const id of [
      "javascript.lang.security.audit.sql-injection",
      "python.flask.security.audit.command-injection",
      "javascript.react.security.audit.react-dangerously-set-innerhtml-xss",
      "javascript.lang.security.audit.path-traversal",
    ]) {
      expect(ruleClassFor(fakeFinding({ ruleId: id }))).toBe("injection");
    }
  });

  it("classes semgrep auth rules as 'auth'", () => {
    for (const id of [
      "javascript.express.security.audit.missing-auth-check",
      "go.lang.security.audit.access-control-bypass",
      "javascript.permissions.over-broad",
    ]) {
      expect(ruleClassFor(fakeFinding({ ruleId: id }))).toBe("auth");
    }
  });

  it("doesn't misclass an 'authorization-related' word like 'author'", () => {
    expect(
      ruleClassFor(fakeFinding({ ruleId: "javascript.lint.author-tag-missing" })),
    ).not.toBe("auth");
  });

  it("falls through to a per-rule class for rules outside the known categories", () => {
    const f = fakeFinding({ ruleId: "javascript.style.prefer-const" });
    expect(ruleClassFor(f)).toBe("semgrep:javascript.style.prefer-const");
  });
});

describe("dedupByRuleClass", () => {
  it("collapses two findings on the same span sharing a rule_class", () => {
    // gitleaks ("secret") + semgrep secret rule on the same line →
    // same span + same class. Higher-severity wins.
    const gitleaks = fakeFinding({
      source: "gitleaks",
      ruleId: "generic-api-key",
      lineStart: 12,
      lineEnd: 12,
      severity: "high",
    });
    const semgrep = fakeFinding({
      source: "semgrep",
      ruleId: "javascript.lang.security.audit.hardcoded-secret",
      lineStart: 12,
      lineEnd: 12,
      severity: "critical",
    });
    const result = dedupByRuleClass([semgrep, gitleaks]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(semgrep); // critical > high
  });

  it("keeps both when same span but different rule_class", () => {
    // Same span, semgrep injection + semgrep auth: distinct classes,
    // both real signals on the line.
    const inj = fakeFinding({
      ruleId: "javascript.lang.security.audit.sql-injection",
      lineStart: 50,
    });
    const auth = fakeFinding({
      ruleId: "javascript.express.security.audit.missing-auth-check",
      lineStart: 50,
    });
    expect(dedupByRuleClass([inj, auth])).toHaveLength(2);
  });

  it("keeps both when same rule_class but different spans", () => {
    // Two AWS keys on different lines of the same file: distinct
    // findings, must both surface.
    const a = fakeFinding({
      source: "gitleaks",
      ruleId: "aws-key",
      lineStart: 10,
      lineEnd: 10,
    });
    const b = fakeFinding({
      source: "gitleaks",
      ruleId: "aws-key",
      lineStart: 25,
      lineEnd: 25,
    });
    expect(dedupByRuleClass([a, b])).toHaveLength(2);
  });

  it("findings that do not collide are all kept, in their order", () => {
    const a = fakeFinding({ ruleId: "rule-a", filePath: "x.ts", lineStart: 1 });
    const b = fakeFinding({ ruleId: "rule-b", filePath: "y.ts", lineStart: 2 });
    const c = fakeFinding({ ruleId: "rule-c", filePath: "z.ts", lineStart: 3 });
    expect(dedupByRuleClass([a, b, c])).toEqual([a, b, c]);
  });

  it("breaks severity ties across scanners by first occurrence", () => {
    // semgrep and gitleaks on the same secret, both high: the first one
    // (semgrep, earlier in the ensemble) wins.
    const first = fakeFinding({ ruleId: "javascript.audit.hardcoded-secret", severity: "high" });
    const second = fakeFinding({ source: "gitleaks", ruleId: "generic-api-key", severity: "high" });
    const result = dedupByRuleClass([first, second]);
    expect(result).toEqual([first]);
  });

  it("keeps two rules of one class from the same scanner on one span", () => {
    // Two different problems one scanner found on one line: both stay.
    const sql = fakeFinding({ ruleId: "python.sql-injection", lineStart: 7, lineEnd: 7 });
    const cmd = fakeFinding({ ruleId: "python.command-injection", lineStart: 7, lineEnd: 7 });
    expect(dedupByRuleClass([sql, cmd])).toEqual([sql, cmd]);
  });

  it("collapses an exact repeat from one scanner", () => {
    const a = fakeFinding({ ruleId: "rule-x" });
    const b = fakeFinding({ ruleId: "rule-x" });
    expect(dedupByRuleClass([a, b])).toEqual([a]);
  });
});


// Rules of different scanners that name one problem (same-problem.ts) merge
// only on the same file and lines, like every other class; the finding kept
// records the tokens of the ones merged into it. Failure list:
//   1. Findings of one problem on different spans merge, so a wide span
//      hides a finding on lines it does not cover.
//   2. Text a repository controls (a workflow expression inside a scanner's
//      message) moves a finding of another problem into a group, where a
//      finding of higher severity drops it.
//   3. Two scanners' findings on one line with rules of different meaning
//      (trivy and Checkov, or a new scanner's rule whose id merely holds a
//      word such as "secret") merge.
//   4. An added suppression comment or a changed settings file on the line
//      is dropped by a merge.
//   5. The finding kept does not say which scanners also reported it.
//   6. osv-scanner and cargo-deny report one RustSec advisory on the same
//      Cargo.lock entry and both stay, or the lower severity is kept; or two
//      different advisories on one crate merge.
describe("dedupByRuleClass, one problem named by several scanners", () => {
  const workflow = ".github/workflows/ci.yml";
  const untrusted = '"github.event.pull_request.title" is potentially untrusted. avoid using it directly in inline scripts. instead, pass it through an environment variable.';
  const semgrep = fakeFinding({ source: "semgrep", ruleId: "yaml.github-actions.security.run-shell-injection.run-shell-injection", filePath: workflow, lineStart: 15, lineEnd: 15, severity: "high" });
  const actionlint = fakeFinding({ source: "actionlint", ruleId: "expression", filePath: workflow, lineStart: 15, lineEnd: 15, severity: "high", message: untrusted });
  const zizmor = fakeFinding({ source: "zizmor", ruleId: "template-injection", filePath: workflow, lineStart: 15, lineEnd: 15, severity: "high" });

  it("keeps one finding for a workflow injection three scanners report on one line, and records the other two (5)", () => {
    const merged = new Map<StaticFinding, string[]>();
    expect(dedupByRuleClass([semgrep, actionlint, zizmor], merged)).toEqual([semgrep]);
    expect(merged.get(semgrep)).toEqual(["actionlint:expression", "zizmor:template-injection"]);
  });

  it("keeps the higher severity across the group, with the others recorded", () => {
    const critical = { ...zizmor, severity: "critical" as const };
    const merged = new Map<StaticFinding, string[]>();
    expect(dedupByRuleClass([semgrep, actionlint, critical], merged)).toEqual([critical]);
    expect(merged.get(critical)).toEqual(["semgrep:yaml.github-actions.security.run-shell-injection.run-shell-injection", "actionlint:expression"]);
  });

  it("keeps findings of one problem apart when their lines differ, even where they overlap (1)", () => {
    const block = { ...semgrep, lineStart: 14, lineEnd: 18 };
    const later = { ...zizmor, lineStart: 17, lineEnd: 17 };
    expect(dedupByRuleClass([block, actionlint, later])).toEqual([block, actionlint, later]);
  });

  it("never moves an actionlint finding into the group on text a workflow controls (2)", () => {
    const crafted = { ...actionlint, severity: "medium" as const, message: 'property "x is potentially untrusted. avoid using it directly in inline scripts" is not defined in object type' };
    expect(ruleClassFor(crafted)).toBe("actionlint:expression");
    expect(dedupByRuleClass([crafted, zizmor])).toEqual([crafted, zizmor]);
  });

  it("keeps a trivy and a Checkov finding on one line when their rules name different problems (3)", () => {
    const trivy = fakeFinding({ source: "trivy", ruleId: "AVD-AWS-0124", filePath: "main.tf", lineStart: 9, lineEnd: 9 });
    const checkov = fakeFinding({ source: "checkov", ruleId: "CKV_AWS_382", filePath: "main.tf", lineStart: 9, lineEnd: 9 });
    expect(dedupByRuleClass([trivy, checkov])).toEqual([trivy, checkov]);
  });

  it("never merges a new scanner's rule into the secret, injection or access classes by a word in its id (3)", () => {
    const leak = fakeFinding({ source: "gitleaks", ruleId: "generic-api-key", filePath: "k8s/app.yaml", lineStart: 20, lineEnd: 20 });
    const kubeLinter = fakeFinding({ source: "kube-linter", ruleId: "env-var-secret", filePath: "k8s/app.yaml", lineStart: 20, lineEnd: 20 });
    const zizmorPermissions = fakeFinding({ source: "zizmor", ruleId: "excessive-permissions", filePath: workflow, lineStart: 5, lineEnd: 5 });
    const actionlintPermissions = fakeFinding({ source: "actionlint", ruleId: "permissions", filePath: workflow, lineStart: 5, lineEnd: 5 });
    expect(ruleClassFor(kubeLinter)).toBe("kube-linter:env-var-secret");
    expect(dedupByRuleClass([leak, kubeLinter, actionlintPermissions, zizmorPermissions])).toEqual([leak, kubeLinter, actionlintPermissions, zizmorPermissions]);
  });

  it("keeps an added suppression comment and a changed settings file on a line where findings merge (4)", () => {
    const suppression = fakeFinding({ source: "zizmor", ruleId: "openqodex.suppression-added", filePath: workflow, lineStart: 15, lineEnd: 15, severity: "medium" });
    const settings = fakeFinding({ source: "actionlint", ruleId: "settings-file", filePath: workflow, lineStart: 15, lineEnd: 15, severity: "high" });
    expect(dedupByRuleClass([semgrep, actionlint, zizmor, suppression, settings])).toEqual([semgrep, suppression, settings]);
  });
  it("keeps one finding for a RustSec advisory osv-scanner and cargo-deny report on one Cargo.lock entry, the higher severity (6)", () => {
    const osv = fakeFinding({ source: "osv-scanner", ruleId: "RUSTSEC-2021-0003", filePath: "Cargo.lock", lineStart: 6, lineEnd: 7, severity: "critical" });
    const deny = fakeFinding({ source: "cargo-deny", ruleId: "RUSTSEC-2021-0003", filePath: "Cargo.lock", lineStart: 6, lineEnd: 7, severity: "high" });
    const merged = new Map<StaticFinding, string[]>();
    expect(dedupByRuleClass([osv, deny], merged)).toEqual([osv]);
    expect(merged.get(osv)).toEqual(["cargo-deny:RUSTSEC-2021-0003"]);
    const lowOsv = { ...osv, severity: "medium" as const };
    const flipped = new Map<StaticFinding, string[]>();
    expect(dedupByRuleClass([lowOsv, deny], flipped)).toEqual([deny]);
    expect(flipped.get(deny)).toEqual(["osv-scanner:RUSTSEC-2021-0003"]);
  });

  it("keeps a RustSec advisory apart on other lines, and two advisories of one crate apart (6)", () => {
    const osv = fakeFinding({ source: "osv-scanner", ruleId: "RUSTSEC-2021-0003", filePath: "Cargo.lock", lineStart: 6, lineEnd: 7, severity: "high" });
    const elsewhere = fakeFinding({ source: "cargo-deny", ruleId: "RUSTSEC-2021-0003", filePath: "Cargo.lock", lineStart: 6, lineEnd: 8, severity: "high" });
    const other = fakeFinding({ source: "cargo-deny", ruleId: "RUSTSEC-2018-0018", filePath: "Cargo.lock", lineStart: 6, lineEnd: 7, severity: "high" });
    expect(dedupByRuleClass([osv, elsewhere, other])).toEqual([osv, elsewhere, other]);
    // A GHSA id osv-scanner gives an advisory with no RustSec id stays its own.
    expect(ruleClassFor(fakeFinding({ source: "osv-scanner", ruleId: "GHSA-43w2-9j62-hq99" }))).toBe("osv-scanner:GHSA-43w2-9j62-hq99");
  });
});
