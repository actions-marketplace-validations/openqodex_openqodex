// Failure guarded: a rule edit between finalize's two checks is treated as
// an unverified receipt while a complete report is still written.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveInstructionFiles } from "@openqodex/core";
import { checkInstructionsBinding } from "../src/commands/review.js";

it("refuses a rule edit by name at the second finalize binding check", async () => {
  const repo = mkdtempSync(join(tmpdir(), "oq-second-binding-"));
  try {
    writeFileSync(join(repo, "rules.md"), "Original rule.\n");
    const resolved = await resolveInstructionFiles({ repoRoot: repo, paths: ["rules.md"] });
    const manifest = { instructions_hash: resolved.hash, instruction_files: resolved.provenance };
    expect(resolved.files).toHaveLength(1);
    await expect(checkInstructionsBinding(repo, manifest)).resolves.toBe(resolved.hash);
    writeFileSync(join(repo, "rules.md"), "Changed after the first binding check.\n");
    await expect(checkInstructionsBinding(repo, manifest)).rejects.toThrow(
      "rules.md changed since the brief, was deleted, linked or could not be read; run review again (openqodex review --agent)",
    );
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
