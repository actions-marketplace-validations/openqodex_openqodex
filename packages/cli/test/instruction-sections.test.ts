// Failures guarded: shipped sections leak into conventions, template changes
// leave the generated set stale, and init-only files trigger the review hint.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { stripInstructionSections } from "@openqodex/core";
import { instructionSection, PREVIOUS_INSTRUCTION_SECTIONS, teamSection } from "../src/agents/targets.js";
import { conventionHint } from "../src/instructions.js";

it("strips every shipped section while preserving owner edits and keeping the template set current", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  execFileSync(process.execPath, [join(root, "scripts/instruction-sections.mjs"), "--check"]);
  const templates = join(root, "packages/cli/templates");
  const sections = [instructionSection(), ...PREVIOUS_INSTRUCTION_SECTIONS, teamSection("0.12.0"), teamSection("99.1.2-beta.3")];
  for (const path of readdirSync(templates, { recursive: true }) as string[]) {
    if (!/\.(md|mdc)$/.test(path)) continue;
    const text = readFileSync(join(templates, path), "utf8").replaceAll("{{VERSION}}", "0.1.0").replaceAll("{{INSTRUCTIONS}}", instructionSection());
    for (const [section] of text.matchAll(/^<!-- openqodex:start -->\n[\s\S]*?^<!-- openqodex:end -->$/gm)) sections.push(section);
  }
  for (const section of sections) {
    expect(stripInstructionSections(`Owner rule.\n${section}\n`), section).toBe("Owner rule.\n\n");
    const edited = section.replace("<!-- openqodex:end -->", "Owner rule.\n<!-- openqodex:end -->");
    expect(stripInstructionSections(edited)).toBe(edited);
  }
});

it("does not prompt for init-only candidates but still lists an owner rule beside a shipped section", () => {
  const repo = mkdtempSync(join(tmpdir(), "oq-section-hint-"));
  try {
    writeFileSync(join(repo, "AGENTS.md"), instructionSection());
    writeFileSync(join(repo, "CLAUDE.md"), teamSection("0.12.0"));
    expect(conventionHint(repo, [])).toBeNull();
    writeFileSync(join(repo, "AGENTS.md"), `${instructionSection()}\nUse named constants.\n`);
    expect(conventionHint(repo, [])).toContain("AGENTS.md");
    expect(conventionHint(repo, [])).not.toContain("CLAUDE.md");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
