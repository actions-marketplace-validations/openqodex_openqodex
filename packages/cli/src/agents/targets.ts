// What `init` writes for each agent, in which scope. The paths and their
// sources are listed in templates/README.md; this file follows it exactly.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assetPath } from "../assets.js";
import type { AgentId } from "./detect.js";
import { withMarker } from "./files.js";

export type Scope = "user" | "project";

export type Target =
  // A whole file we own (rule or skill). `content` carries our marker;
  // `plain` is the same text without it, which counts as already present.
  | { kind: "file"; agent: AgentId; label: string; path: string; content: string; plain: string; inRepo: boolean }
  // One handler merged under hooks.PreToolUse of a JSON settings file.
  | { kind: "hook-json"; agent: AgentId; label: string; path: string; group: HookGroup; command: string }
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
  return text.replaceAll("{{VERSION}}", version);
}

// The hook group from a JSON template, with the command put in after
// parsing so no path can break the JSON.
function hookGroup(file: string, runner: string): HookGroup {
  const parsed = JSON.parse(template(file)) as { hooks: { PreToolUse: HookGroup[] } };
  const group = parsed.hooks.PreToolUse[0];
  for (const h of group.hooks) h.command = h.command.replace("{{LAUNCHER}}", runner);
  return group;
}

function skill(version: string): string {
  return fill(readFileSync(assetPath("skills", "openqodex", "SKILL.md"), "utf8"), version);
}

function fileTarget(agent: AgentId, label: string, path: string, plain: string, inRepo: boolean): Target {
  return { kind: "file", agent, label, path, content: withMarker(plain), plain, inRepo };
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
  const hookCommand = `${runner} hook check`;
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
      targets.push({
        kind: "hook-json",
        agent,
        label: "Claude Code push hook",
        path: at(".claude", "settings.json"),
        group: hookGroup("claude-code/settings-hook.json", runner),
        command: hookCommand,
      });
      break;
    case "codex":
      targets.push(fileTarget(agent, "Codex skill", at(".agents", "skills", "openqodex", "SKILL.md"), skillText, !user));
      if (!user) {
        targets.push({
          kind: "md-section",
          agent,
          label: "Codex instructions",
          path: at("AGENTS.md"),
          section: fill(template("codex", "AGENTS-section.md"), version).trimEnd(),
          inRepo: true,
        });
      }
      targets.push({
        kind: "hook-json",
        agent,
        label: "Codex push hook",
        path: at(".codex", "hooks.json"),
        group: hookGroup("codex/hooks.json", runner),
        command: hookCommand,
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
