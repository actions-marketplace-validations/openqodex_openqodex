// The one decision every part of a scoped review asks: is this repository
// path admitted (inside a scope folder, and not excluded by
// review.paths.exclude)?
//
// Ways it could fail, written before the code:
//  1. A sibling folder that only shares the scope's spelling as a prefix
//     ("services/api-old" for the scope "services/api") is admitted.
//  2. A file inside an admitted folder that review.paths.exclude names is
//     admitted.
//  3. A root file is admitted when a scope is given.
//  4. A scope spelled "./services/api/" admits nothing, or a scope that
//     climbs out ("../x", "a/../../b") or is absolute is taken as given.
//  5. An empty scope list silently admits nothing (or everything) instead of
//     being refused.
//  6. A path that climbs out of the repository, is absolute, or has an
//     empty, "." or ".." part is admitted (a tool call's path).
//  7. No scopes: a path that is not excluded is refused, so a review with no
//     scope given loses files.
//  8. The tool's own folder (.openqodex/) is admitted, though the change
//     never counts it.
//  9. A path is matched case-insensitively, though git paths are not.
import { describe, expect, it } from "vitest";
import { admitted } from "../src/scopes.js";

describe("admitted", () => {
  it("1. a sibling folder that shares the scope's spelling is not admitted", () => {
    const admit = admitted(["services/api"], []);
    expect(admit("services/api/x.ts")).toBe(true);
    expect(admit("services/api/deep/y.ts")).toBe(true);
    expect(admit("services/api-old/x.ts")).toBe(false);
    expect(admit("services/apix")).toBe(false);
  });

  it("2. a file review.paths.exclude names is not admitted inside an admitted folder", () => {
    const admit = admitted(["services/api"], ["**/generated/**", "**/*.snap"]);
    expect(admit("services/api/generated/x.ts")).toBe(false);
    expect(admit("services/api/a.snap")).toBe(false);
    expect(admit("services/api/a.ts")).toBe(true);
  });

  it("3. a root file is not admitted when a scope is given", () => {
    const admit = admitted(["services/api"], []);
    expect(admit("canary.txt")).toBe(false);
    expect(admit("services")).toBe(false);
    expect(admit("services/x.ts")).toBe(false);
  });

  it("4. a scope is read in its plain form, and a scope that climbs out or is absolute is refused", () => {
    const admit = admitted(["./services/api/", "web//app"], []);
    expect(admit("services/api/x.ts")).toBe(true);
    expect(admit("web/app/x.ts")).toBe(true);
    for (const bad of ["../x", "a/../../b", "/etc", "a/./b", ".", "", "a\0b"]) {
      expect(() => admitted([bad], []), bad).toThrow(/scope/);
    }
  });

  it("5. an empty scope list is refused, never read as everything or nothing", () => {
    expect(() => admitted([], [])).toThrow(/leave scopes out to review the whole repository/);
  });

  it("6. a path that climbs out, is absolute or has an empty, . or .. part is never admitted", () => {
    for (const admit of [admitted(["services/api"], []), admitted(undefined, [])]) {
      for (const bad of ["services/api/../../canary.txt", "/services/api/x.ts", "services/api//x.ts", "services/api/./x.ts", "", ".", "..", "services/api/"]) {
        expect(admit(bad), bad).toBe(false);
      }
    }
  });

  it("7. with no scopes, every path that is not excluded is admitted", () => {
    const admit = admitted(undefined, ["**/generated/**"]);
    expect(admit("canary.txt")).toBe(true);
    expect(admit("services/api/x.ts")).toBe(true);
    expect(admit("services/api/generated/x.ts")).toBe(false);
  });

  it("8. the tool's own folder is never admitted, as the change never counts it", () => {
    expect(admitted(undefined, [])(".openqodex/config.yaml")).toBe(false);
    expect(admitted(undefined, [])(".openqodex")).toBe(false);
    expect(admitted(undefined, [])(".openqodex-other/x")).toBe(true);
  });

  it("9. paths are matched case-sensitively, as git spells them", () => {
    const admit = admitted(["services/api"], []);
    expect(admit("Services/api/x.ts")).toBe(false);
    expect(admit("services/API/x.ts")).toBe(false);
  });
});
