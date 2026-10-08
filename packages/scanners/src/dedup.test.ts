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
// when their spans overlap, since each scanner reports its own span: a
// whole `run:` block, one line, one expression.
describe("dedupByRuleClass, one problem named by several scanners", () => {
  const workflow = ".github/workflows/ci.yml";
  const semgrep = fakeFinding({ source: "semgrep", ruleId: "yaml.github-actions.security.run-shell-injection.run-shell-injection", filePath: workflow, lineStart: 14, lineEnd: 15, severity: "high" });
  const actionlint = fakeFinding({ source: "actionlint", ruleId: "expression", filePath: workflow, lineStart: 15, lineEnd: 15, severity: "high", message: '"github.event.pull_request.title" is potentially untrusted. avoid using it directly in inline scripts' });
  const zizmor = fakeFinding({ source: "zizmor", ruleId: "template-injection", filePath: workflow, lineStart: 15, lineEnd: 15, severity: "high" });

  it("keeps one finding for a workflow injection three scanners report on overlapping lines", () => {
    expect(dedupByRuleClass([semgrep, actionlint, zizmor])).toEqual([semgrep]);
  });

  it("keeps the higher severity across the group", () => {
    const critical = { ...zizmor, severity: "critical" as const };
    expect(dedupByRuleClass([semgrep, actionlint, critical])).toEqual([critical]);
  });

  it("does not merge a rule id that covers other problems when its message names another one", () => {
    const typeError = { ...actionlint, message: 'property "titel" is not defined in object type' };
    expect(dedupByRuleClass([typeError, zizmor])).toEqual([typeError, zizmor]);
  });

  it("keeps the group's findings apart on lines that do not overlap, or in another file", () => {
    const later = { ...zizmor, lineStart: 30, lineEnd: 30 };
    const elsewhere = { ...actionlint, filePath: "release.yml" };
    expect(dedupByRuleClass([semgrep, later, elsewhere])).toEqual([semgrep, later, elsewhere]);
  });

  it("merges a chain of overlapping spans into one", () => {
    const wide = { ...semgrep, lineStart: 10, lineEnd: 20 };
    const a = { ...actionlint, lineStart: 12, lineEnd: 12 };
    const b = { ...zizmor, lineStart: 19, lineEnd: 22 };
    expect(dedupByRuleClass([wide, a, b])).toEqual([wide]);
  });
});
