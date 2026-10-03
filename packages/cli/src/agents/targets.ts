// What `init` writes for each agent, in which scope. The paths and their
// sources are listed in templates/README.md; this file follows it exactly.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assetPath } from "../assets.js";
import type { AgentId } from "./detect.js";

export type Scope = "user" | "project";

export type Target =
  // A whole file (rule or skill).
  | { kind: "file"; agent: AgentId; label: string; path: string; content: string; inRepo: boolean }
  // One hook group merged under hooks.PreToolUse of a JSON settings file.
  | { kind: "hook-json"; agent: AgentId; label: string; path: string; group: HookGroup; inRepo: boolean; usesLauncher: boolean }
  // A section between the openqodex markers in a markdown file.
  | { kind: "md-section"; agent: AgentId; label: string; path: string; section: string; inRepo: boolean };

export type HookHandler = { type: string; command: string; [key: string]: unknown };
export type HookGroup = { matcher: string; hooks: HookHandler[]; [key: string]: unknown };

export const SECTION_START = "<!-- openqodex:start -->";
export const SECTION_END = "<!-- openqodex:end -->";

function template(...segments: string[]): string {
  return readFileSync(assetPath("templates", ...segments), "utf8");
}

function fill(text: string, version: string): string {
  return text.replaceAll("{{VERSION}}", () => version).replaceAll("{{INSTRUCTIONS}}", () => instructionSection());
}

// The marked section that tells an agent to review with openqodex when a
// feature or fix is done. The same text goes into every agent's global
// instruction file, the project CLAUDE.md and AGENTS.md, and the Cursor and
// Cline rules.
export function instructionSection(): string {
  return template("instructions-section.md").trimEnd();
}

function sectionTarget(agent: AgentId, label: string, path: string, inRepo: boolean): Target {
  return { kind: "md-section", agent, label, path, section: instructionSection(), inRepo };
}

// Codex reads its home folder from CODEX_HOME, ~/.codex by default.
function codexHome(home: string): string {
  const fromEnv = process.env.CODEX_HOME;
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : join(home, ".codex");
}

// The hook group from a JSON template, with the command put in after
// parsing so no path can break the JSON.
function hookGroup(file: string, runner: string): HookGroup {
  const parsed = JSON.parse(template(file)) as { hooks: { PreToolUse: HookGroup[] } };
  const group = parsed.hooks.PreToolUse[0];
  for (const h of group.hooks) h.command = h.command.replace("{{LAUNCHER}}", () => runner);
  return group;
}

function skill(version: string): string {
  return fill(readFileSync(assetPath("skills", "openqodex", "SKILL.md"), "utf8"), version);
}

function fileTarget(agent: AgentId, label: string, path: string, content: string, inRepo: boolean): Target {
  return { kind: "file", agent, label, path, content, inRepo };
}

export function targetsFor(args: {
  agent: AgentId;
  scope: Scope;
  home: string;
  repoRoot: string | null;
  version: string;
  // The quoted launcher, or `npx -y openqodex@<version>` for project files.
  runner: string;
}): { targets: Target[]; skipped: string[] } {
  const { agent, scope, home, repoRoot, version, runner } = args;
  const targets: Target[] = [];
  const skipped: string[] = [];
  const user = scope === "user";
  // Project scope always needs the repo; user scope needs it only for the Cursor rule.
  const base = user ? home : repoRoot;
  if (base === null) return { targets, skipped: [`${agent}: run init --project inside a git repository`] };
  const at = (...p: string[]): string => join(base, ...p);
  const skillText = skill(version);

  switch (agent) {
    case "claude-code":
      targets.push(fileTarget(agent, "Claude Code skill", at(".claude", "skills", "openqodex", "SKILL.md"), skillText, !user));
      targets.push(
        user
          ? sectionTarget(agent, "Claude Code global instructions", at(".claude", "CLAUDE.md"), false)
          : sectionTarget(agent, "Claude Code project instructions", at("CLAUDE.md"), true),
      );
      targets.push({
        kind: "hook-json",
        agent,
        label: "Claude Code push hook",
        path: at(".claude", "settings.json"),
        group: hookGroup("claude-code/settings-hook.json", runner),
        inRepo: !user,
        usesLauncher: user,
      });
      break;
    case "codex":
      targets.push(fileTarget(agent, "Codex skill", at(".agents", "skills", "openqodex", "SKILL.md"), skillText, !user));
      targets.push(
        user
          ? sectionTarget(agent, "Codex global instructions", join(codexHome(home), "AGENTS.md"), false)
          : sectionTarget(agent, "Codex instructions", at("AGENTS.md"), true),
      );
      targets.push({
        kind: "hook-json",
        agent,
        label: "Codex push hook",
        path: at(".codex", "hooks.json"),
        group: hookGroup("codex/hooks.json", runner),
        inRepo: !user,
        usesLauncher: user,
      });
      break;
    case "cursor": {
      targets.push(
        fileTarget(
          agent,
          "Cursor skill",
          user ? at(".cursor", "skills", "openqodex", "SKILL.md") : at(".agents", "skills", "openqodex", "SKILL.md"),
          skillText,
          !user,
        ),
      );
      // Cursor has no user-level rule file: the rule always goes in the repo.
      const rule = fill(template("cursor", "openqodex.mdc"), version);
      if (repoRoot === null) skipped.push("Cursor rule: run openqodex init inside a git repository to add it there");
      else targets.push(fileTarget(agent, "Cursor rule", join(repoRoot, ".cursor", "rules", "openqodex.mdc"), rule, true));
      break;
    }
    case "cline":
      targets.push(fileTarget(agent, "Cline skill", at(".cline", "skills", "openqodex", "SKILL.md"), skillText, !user));
      targets.push(
        fileTarget(
          agent,
          "Cline rule",
          user ? at("Documents", "Cline", "Rules", "openqodex.md") : at(".clinerules", "openqodex.md"),
          fill(template("cline", "openqodex.md"), version),
          !user,
        ),
      );
      break;
  }
  return { targets, skipped };
}
