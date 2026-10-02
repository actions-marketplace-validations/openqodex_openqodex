import { afterAll, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  groupGoPackagesByModule,
  nearestGoModuleRoot,
  parseGolangciJson,
} from "./golangci.js";

describe("parseGolangciJson", () => {
  it("returns empty array on blank, Issues-null, or non-object input", () => {
    expect(parseGolangciJson("")).toEqual([]);
    expect(parseGolangciJson(JSON.stringify({ Issues: null }))).toEqual([]);
    expect(parseGolangciJson(JSON.stringify({ Issues: "nope" }))).toEqual([]);
  });

  it("normalizes a typical gosec issue with FromLinter token and Pos", () => {
    const report = {
      Issues: [
        {
          FromLinter: "gosec",
          Text: "G401: Use of weak cryptographic primitive",
          Severity: "",
          Pos: { Filename: "internal/auth/hash.go", Offset: 0, Line: 17, Column: 5 },
        },
      ],
      Report: { Linters: [{ Name: "gosec", Enabled: true }] },
    };
    const out = parseGolangciJson(JSON.stringify(report));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      source: "golangci",
      ruleId: "gosec",
      filePath: "internal/auth/hash.go",
      lineStart: 17,
      lineEnd: 17,
      severity: "high",
      reference: null,
    });
    expect(out[0].message).toContain("gosec: G401");
  });

  it("maps gosec/govet/staticcheck/errcheck/ineffassign to high/medium/medium/medium/low", () => {
    const report = {
      Issues: [
        { FromLinter: "gosec", Text: "t", Pos: { Filename: "a.go", Line: 1 } },
        { FromLinter: "govet", Text: "t", Pos: { Filename: "a.go", Line: 2 } },
        { FromLinter: "staticcheck", Text: "t", Pos: { Filename: "a.go", Line: 3 } },
        { FromLinter: "errcheck", Text: "t", Pos: { Filename: "a.go", Line: 4 } },
        { FromLinter: "ineffassign", Text: "t", Pos: { Filename: "a.go", Line: 5 } },
      ],
    };
    const out = parseGolangciJson(JSON.stringify(report));
    expect(out.map((f) => f.severity)).toEqual(["high", "medium", "medium", "medium", "low"]);
  });

  it("trims a leading non-JSON log line, defaults the rule id, and skips rows with no file or line", () => {
    const report = {
      Issues: [
        { Text: "unnamed linter", Pos: { Filename: "a.go", Line: 8 } },
        { FromLinter: "govet", Text: "t", Pos: { Filename: "", Line: 1 } },
        { FromLinter: "govet", Text: "t", Pos: { Filename: "a.go", Line: 0 } },
        { FromLinter: "govet", Text: "t" },
      ],
    };
    const noisy = `level=warning msg="running with deprecated flag"\n${JSON.stringify(report)}`;
    const out = parseGolangciJson(noisy);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ ruleId: "golangci", filePath: "a.go", lineStart: 8 });
  });
});

// Module-root discovery. The bug these cover: the adapter used to run
// golangci-lint at the directory it was handed and pass package args
// relative to it, assuming go.mod lived there. A repo is free to put
// go.mod deeper, such as `backend/src/factors/go.mod` in a monorepo. Go
// then exits 5 in package loading without analyzing anything, and the
// adapter reported raw=0 next to the error, so from the outside it
// looked like a clean scan rather than a scan that never happened.

const tmpRoots: string[] = [];

function repo(layout: { modules: string[] }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openqodex-golangci-"));
  tmpRoots.push(dir);
  for (const m of layout.modules) {
    const abs = m === "." ? dir : path.join(dir, ...m.split("/"));
    fs.mkdirSync(abs, { recursive: true });
    fs.writeFileSync(path.join(abs, "go.mod"), "module example.com/x\n");
  }
  return dir;
}

afterAll(() => {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
});

describe("nearestGoModuleRoot", () => {
  it("finds go.mod at the run dir itself", () => {
    const dir = repo({ modules: ["."] });
    expect(nearestGoModuleRoot(dir, "internal/auth")).toBe(".");
  });

  it("walks up to a module nested several levels below the run dir", () => {
    const dir = repo({ modules: ["src/factors"] });
    expect(nearestGoModuleRoot(dir, "src/factors/model/model")).toBe("src/factors");
  });

  it("returns null when no module exists above the changed dir", () => {
    const dir = repo({ modules: [] });
    expect(nearestGoModuleRoot(dir, "src/factors/model")).toBeNull();
  });

  it("prefers the nearest module when modules nest", () => {
    const dir = repo({ modules: [".", "tools/gen"] });
    expect(nearestGoModuleRoot(dir, "tools/gen/internal")).toBe("tools/gen");
    expect(nearestGoModuleRoot(dir, "cmd/server")).toBe(".");
  });
});

describe("groupGoPackagesByModule", () => {
  it("expresses package args relative to the module root, not the run dir", () => {
    const dir = repo({ modules: ["src/factors"] });

    const { groups, orphans } = groupGoPackagesByModule(dir, [
      "src/factors/model/model/billing.go",
      "src/factors/handler/auth.go",
    ]);

    expect(orphans).toEqual([]);
    expect(groups).toHaveLength(1);
    expect(groups[0].moduleRoot).toBe("src/factors");
    // Relative to src/factors -- NOT "./src/factors/model/model", which
    // is what the old code passed and what Go could not resolve.
    expect(groups[0].packages.sort()).toEqual(["./handler", "./model/model"]);
  });

  it("splits a diff that spans two modules and orders the heavier first", () => {
    const dir = repo({ modules: ["a", "b"] });

    const { groups } = groupGoPackagesByModule(dir, [
      "b/one.go",
      "a/x/1.go",
      "a/x/2.go",
      "a/y/3.go",
    ]);

    expect(groups.map((g) => g.moduleRoot)).toEqual(["a", "b"]);
    expect(groups[0].fileCount).toBe(3);
    expect(groups[0].packages.sort()).toEqual(["./x", "./y"]);
    expect(groups[1].packages).toEqual(["."]);
  });

  it("reports directories with no module above them instead of linting them", () => {
    const dir = repo({ modules: ["backend"] });

    const { groups, orphans } = groupGoPackagesByModule(dir, [
      "backend/svc/a.go",
      "scripts/tool.go",
    ]);

    expect(groups.map((g) => g.moduleRoot)).toEqual(["backend"]);
    expect(orphans).toEqual(["scripts"]);
  });

  it("keeps the run-dir-rooted shape when go.mod is at the run dir", () => {
    const dir = repo({ modules: ["."] });

    const { groups } = groupGoPackagesByModule(dir, ["internal/auth/hash.go", "main.go"]);

    expect(groups).toHaveLength(1);
    expect(groups[0].moduleRoot).toBe(".");
    expect(groups[0].packages.sort()).toEqual([".", "./internal/auth"]);
  });
});
