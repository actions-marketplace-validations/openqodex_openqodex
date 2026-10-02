// Ways the glob matcher could fail:
// 1. "*" crosses a slash, so "vendor/*" excludes nested folders it should not.
// 2. "**" stops at a slash.
// 3. A pattern matches a prefix or a suffix instead of the whole path.
// 4. A regex metacharacter in the pattern throws or matches something else.
// 5. "?" matches a slash or more than one character.
import { describe, expect, it } from "vitest";
import { matchesGlob } from "./glob.js";

describe("matchesGlob", () => {
  it("stops * at a path separator and lets ** cross it", () => {
    expect(matchesGlob("release/1.4", "release/*")).toBe(true);
    expect(matchesGlob("release/1.4/hotfix", "release/*")).toBe(false);
    expect(matchesGlob("release/1.4/hotfix", "release/**")).toBe(true);
    expect(matchesGlob("master", "release/*")).toBe(false);
  });

  it("anchors at both ends", () => {
    expect(matchesGlob("release/1.4", "release")).toBe(false);
    expect(matchesGlob("src/vendor/a.js", "vendor/**")).toBe(false);
  });

  it("matches a prefix family and a whole linter in rule tokens", () => {
    expect(matchesGlob("lens:react-state-set-in-render", "lens:react-*")).toBe(true);
    expect(matchesGlob("lens:async-floating-promise", "lens:react-*")).toBe(false);
    expect(matchesGlob("semgrep:javascript.lang.security.audit.sql-injection", "semgrep:*")).toBe(true);
    expect(matchesGlob("gitleaks:generic-api-key", "semgrep:*")).toBe(false);
  });

  it("treats regex metacharacters literally and never throws", () => {
    expect(() => matchesGlob("x", "release/[v1")).not.toThrow();
    expect(matchesGlob("x", "release/[v1")).toBe(false);
    expect(matchesGlob("release/[v1", "release/[v1")).toBe(true);
    expect(matchesGlob("aXmin.js", "a.min.js")).toBe(false);
  });

  it("matches one non-slash character with ?", () => {
    expect(matchesGlob("a1.ts", "a?.ts")).toBe(true);
    expect(matchesGlob("a/.ts", "a?.ts")).toBe(false);
    expect(matchesGlob("a12.ts", "a?.ts")).toBe(false);
  });
});
