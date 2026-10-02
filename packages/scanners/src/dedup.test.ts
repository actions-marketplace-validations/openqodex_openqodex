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
  it("returns the input unchanged when nothing collides", () => {
    const a = fakeFinding({ ruleId: "rule-a", filePath: "x.ts", lineStart: 1 });
    const b = fakeFinding({ ruleId: "rule-b", filePath: "y.ts", lineStart: 2 });
    expect(dedupByRuleClass([a, b])).toEqual([a, b]);
  });

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

  it("preserves input order for survivors", () => {
    const a = fakeFinding({ ruleId: "rule-a", filePath: "x.ts", lineStart: 1 });
    const b = fakeFinding({ ruleId: "rule-b", filePath: "y.ts", lineStart: 2 });
    const c = fakeFinding({ ruleId: "rule-c", filePath: "z.ts", lineStart: 3 });
    expect(dedupByRuleClass([a, b, c])).toEqual([a, b, c]);
  });

  it("breaks severity ties by first occurrence", () => {
    // Two semgrep secret rules on same span, both medium: first one
    // wins (preserves whichever the adapter listed first).
    const first = fakeFinding({
      ruleId: "javascript.audit.hardcoded-secret-one",
      severity: "medium",
    });
    const second = fakeFinding({
      ruleId: "javascript.audit.hardcoded-secret-two",
      severity: "medium",
    });
    const result = dedupByRuleClass([first, second]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(first);
  });
});
