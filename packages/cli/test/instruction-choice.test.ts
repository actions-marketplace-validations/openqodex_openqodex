// Failures guarded: init creates conflicting review blocks, or discards
// retained YAML nodes, their comments and anchors when choices change.
import { expect, it } from "vitest";
import { parse } from "yaml";
import { parseConfig } from "@openqodex/core";
import { writeInstructionChoice } from "../src/instructions.js";

it("does not create a review block beside the hosted pr_review spelling", () => {
  const text = writeInstructionChoice("pr_review:\n  instructions_files: [AGENTS.md]\n", ["AGENTS.md", "CONTRIBUTING.md"]);
  expect(parse(text).review).toBeUndefined();
  expect(parse(text).pr_review.instructions_files).toEqual(["AGENTS.md", "CONTRIBUTING.md"]);
  expect(parseConfig(text).config.instructionsFiles).toEqual(["AGENTS.md", "CONTRIBUTING.md"]);
});

it("keeps comments and referenced anchors on retained convention entries", () => {
  const before = `review:
  instructions_files: &rules # chosen rules
    # keep the first rule
    - &first AGENTS.md # owner comment
    - CONTRIBUTING.md # deselected
  paths:
    exclude: [*first]
`;
  const text = writeInstructionChoice(before, ["AGENTS.md", "docs/*.md"]);
  const parsed = parse(text);
  expect(parsed.review.instructions_files).toEqual(["AGENTS.md", "docs/*.md"]);
  expect(parsed.review.paths.exclude).toEqual(["AGENTS.md"]);
  for (const kept of ["&rules", "&first", "# chosen rules", "# keep the first rule", "# owner comment", "*first"]) expect(text).toContain(kept);
  expect(text).not.toContain("CONTRIBUTING.md");
  expect(text).not.toContain("# deselected");
  expect(parseConfig(text).config.instructionsFiles).toEqual(["AGENTS.md", "docs/*.md"]);
});

it("keeps an anchor on the convention sequence when another config key references it", () => {
  const text = writeInstructionChoice("review:\n  instructions_files: &rules [AGENTS.md]\n  paths:\n    exclude: *rules\n", ["AGENTS.md", "CONTRIBUTING.md"]);
  expect(text).toContain("&rules");
  expect(text).toContain("*rules");
  expect(parseConfig(text).config.exclude).toContain("CONTRIBUTING.md");
});
