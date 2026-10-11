import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
const { parse } = createRequire(new URL("packages/core/package.json", root))("yaml");
const plantedPaths = ["benchmark/cases/", "examples/demo-repo/", "packages/scanners/test/fixtures/"];
const label = "The cases are test data for the review benchmark, not code anyone runs. Do not report them as vulnerabilities.";
const read = (file) => readFileSync(new URL(file, root), "utf8");

describe("a planted folder loses its label or an ignore entry, and a whole-repo scanner lists the planted bugs again", () => {
  it.each([
    ["benchmark/README.md", `Every bug in this folder is planted on purpose. ${label}`],
    ["examples/README.md", `Every bug in demo-repo/ is planted on purpose. ${label}`],
  ])("keeps the planted label on the first line of %s", (file, firstLine) => {
    expect(read(file).split("\n")[0]).toBe(firstLine);
  });

  it("keeps all three planted paths out of the security policy's scope", () => {
    const scope = read("SECURITY.md").split("## Scope\n")[1]?.split("\n## ")[0];
    expect(scope).toContain("Out of scope: the bugs in benchmark/cases/, examples/demo-repo/ and packages/scanners/test/fixtures/. They are planted on purpose to test the scanners and the review.");
  });

  it("excludes all three planted paths from Aikido with trailing slashes", () => {
    const aikido = parse(read(".aikido"));
    expect(aikido?.exclude?.paths).toEqual(plantedPaths);
  });

  it("excludes all three planted paths from Semgrep and includes the gitignore defaults", () => {
    const lines = read(".semgrepignore").split("\n");
    expect(lines).toContain(":include .gitignore");
    for (const path of plantedPaths) expect(lines).toContain(path);
  });

  it("excludes all three planted paths from GitHub secret scanning", () => {
    expect(read(".github/secret_scanning.yml")).toContain(`paths-ignore:\n${plantedPaths.map((path) => `  - ${path}**`).join("\n")}`);
  });

  it("excludes all three planted paths globally from Snyk", () => {
    expect(read(".snyk")).toContain(`exclude:\n  global:\n${plantedPaths.map((path) => `    - ${path}**`).join("\n")}`);
  });

  it("marks all three planted paths as vendored without collapsing their diffs", () => {
    const files = [
      "benchmark/cases/express-route-param/case.json",
      "examples/demo-repo/expected.json",
      "packages/scanners/test/fixtures/checkov/report.json",
    ];
    const attributes = execFileSync("git", ["check-attr", "linguist-vendored", "--", ...files], {
      cwd: root,
      encoding: "utf8",
    });
    expect(attributes.trim().split("\n")).toEqual(files.map((file) => `${file}: linguist-vendored: set`));
    expect(read(".gitattributes")).not.toContain("linguist-generated");
  });
});
