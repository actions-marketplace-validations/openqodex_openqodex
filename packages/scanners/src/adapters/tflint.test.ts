// The TFLint report parser and OpenQodex's TFLint config, on a report the
// 0.64.0 binary wrote for test/fixtures/tflint/repo (saved as report.json).
//
// Failure list, written before the code:
//   1. An issue is dropped, or lands on another file or line than TFLint
//      names; a warning ranks above low.
//   2. A file TFLint could not read is lost: its error never reaches the
//      scanner's status.
//   3. The config names a plugin other than the bundled terraform ruleset,
//      has no plugin folder of its own (so `.tflint.d` in the repository or
//      the home could stand in for the ruleset), or calls modules.
// Added after the security check of the first version:
//   4. A value TFLint evaluated reaches the report: the duplicate map keys
//      rule prints an evaluated key, and a key can be file() of any file the
//      user can read; an evaluation error's detail names a path and whether
//      it exists. The real-binary guard is in adapters-iac.subprocess.test.ts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTflintJson, tflintConfig } from "./tflint.js";

const report = readFileSync(new URL("../../test/fixtures/tflint/report.json", import.meta.url), "utf8");

describe("parseTflintJson", () => {
  it("keeps every issue on the file and lines TFLint names, warnings as low (1)", () => {
    const { findings, errors } = parseTflintJson(report);
    expect(findings.map((f) => [f.ruleId, f.filePath, f.lineStart, f.lineEnd, f.severity])).toEqual([
      ["terraform_unused_declarations", "infra/main.tf", 1, 1, "low"],
      ["terraform_required_version", "infra/main.tf", 1, 1, "low"],
      ["terraform_module_version", "infra/main.tf", 5, 5, "low"],
      ["terraform_required_providers", "infra/main.tf", 9, 9, "low"],
      ["terraform_deprecated_interpolation", "infra/main.tf", 13, 13, "low"],
    ]);
    expect(findings[0]).toMatchObject({
      source: "tflint",
      message: 'variable "region" is declared but not used',
      reference: "https://github.com/terraform-linters/tflint-ruleset-terraform/blob/v0.15.0/docs/rules/terraform_unused_declarations.md",
    });
    expect(errors).toEqual([]);
  });

  it("names each file TFLint could not read, by TFLint's fixed summary and never its detail (2, 4)", () => {
    const json = JSON.stringify({
      issues: [],
      errors: [
        { summary: "Invalid block definition", message: "Either a quoted string block label or an opening brace is expected.", severity: "error", range: { filename: "infra/broken.tf" } },
        { summary: "Invalid function argument", message: 'Invalid value for "path" parameter: no file exists at "/home/dev/.aws/credentials".', severity: "error", range: { filename: "infra/keys.tf" } },
        { message: "Failed to load configurations" },
      ],
    });
    expect(parseTflintJson(json).errors).toEqual(["infra/broken.tf: Invalid block definition", "infra/keys.tf: Invalid function argument", "TFLint error"]);
  });
});

describe("tflintConfig", () => {
  it("enables the bundled terraform ruleset only, from an empty plugin folder, with module calls off (3)", () => {
    const config = tflintConfig("/tmp/run/plugins");
    expect(config).toContain('plugin_dir       = "/tmp/run/plugins"');
    expect(config).toContain('call_module_type = "none"');
    expect(config.match(/^plugin "/gm)).toEqual(['plugin "']);
    expect(config).toContain('plugin "terraform" {');
    expect(config).toContain('preset  = "recommended"');
    expect(config).not.toMatch(/source|version/);
  });

  it("switches off the one recommended rule whose message prints an evaluated value (4)", () => {
    expect(tflintConfig("/tmp/run/plugins")).toMatch(/rule "terraform_map_duplicate_keys" \{\n {2}enabled = false\n\}/);
  });
});
