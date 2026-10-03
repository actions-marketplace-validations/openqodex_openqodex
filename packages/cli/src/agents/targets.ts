// What `init` writes for each agent, in which scope. The paths and their
// sources are listed in templates/README.md; this file follows it exactly.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assetPath } from "../assets.js";
import type { AgentId } from "./detect.js";

export type Scope = "user" | "project";

export type Target =
  // A whole file (rule or skill).
  | { kind: "file"; agent: AgentId; label: string; path: string; content: string; inRepo: boolean; usesLauncher?: boolean }
  // One hook group merged under hooks.PreToolUse of a JSON settings file.
  | { kind: "hook-json"; agent: AgentId; label: string; path: string; group: HookGroup; inRepo: boolean; usesLauncher: boolean }
  // A section between the openqodex markers in a markdown file.
  // `replaces`: other sections we write that this one may replace when one
  // is found exactly as written, recorded or not.
  | { kind: "md-section"; agent: AgentId; label: string; path: string; section: string; inRepo: boolean; replaces?: string[] }
  // Rules merged into permissions.allow of a Claude Code settings file.
  | { kind: "allow-rules"; agent: AgentId; label: string; path: string; rules: string[]; inRepo: boolean };

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

// The skill's one paragraph for a copy installed by `npx skills add`, which
// has no launcher of its own. Both copies init writes drop it: a user-scope
// skill's commands already call the launcher, and a project-scope skill keeps
// the version the team committed.
const LAUNCHER_PARAGRAPH = /^When the file `~\/\.openqodex\/bin\/openqodex` exists[^\n]*\n\n/m;
const PINNED_NPX = /npx -y openqodex@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g;

// The skill as shipped. In user scope every pinned `npx -y openqodex@<version>`
// becomes the quoted launcher, so the review runs whatever version the
// launcher points at; project scope keeps the pin a team commits.
function skill(version: string, user: boolean, runner: string): string {
  const text = fill(readFileSync(assetPath("skills", "openqodex", "SKILL.md"), "utf8"), version).replace(LAUNCHER_PARAGRAPH, "");
  return user ? text.replace(PINNED_NPX, () => runner) : text;
}

// The commands the skill tells the agent to run, allowed in Claude Code
// without a prompt. A Bash rule matches the command text as written, so each
// rule starts with the runner exactly as the skill writes it. Not `trust`
// (approving a custom scanner stays the developer's decision), `update`,
// `init` or `report`.
const ALLOWED_COMMANDS = ["review", "scan", "doctor", "guide", "hook check"];

export function allowRules(runner: string): string[] {
  return ALLOWED_COMMANDS.map((c) => `Bash(${runner} ${c} *)`);
}

function fileTarget(agent: AgentId, label: string, path: string, content: string, inRepo: boolean, usesLauncher = false): Target {
  return { kind: "file", agent, label, path, content, inRepo, usesLauncher };
}

// The section for the repo's own CLAUDE.md and AGENTS.md, written by a
// user-scope init so a teammate with nothing installed reviews too. It names
// only the pinned npx command, never the skill or the launcher.
export function teamSection(version: string): string {
  return fill(template("repo", "team-section.md"), version).trimEnd();
}

export function teamTargets(repoRoot: string, version: string): Target[] {
  const section = teamSection(version);
  return [
    { kind: "md-section", agent: "claude-code", label: "team review section", path: join(repoRoot, "CLAUDE.md"), section, inRepo: true, replaces: [instructionSection()] },
    { kind: "md-section", agent: "codex", label: "team review section", path: join(repoRoot, "AGENTS.md"), section, inRepo: true, replaces: [instructionSection()] },
  ];
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
  const skillText = skill(version, user, runner);
  // A user-scope skill calls the launcher, so the launcher stays while it is installed.
  const skillTarget = (label: string, path: string): Target => fileTarget(agent, label, path, skillText, !user, user);

  switch (agent) {
    case "claude-code":
      targets.push(skillTarget("Claude Code skill", at(".claude", "skills", "openqodex", "SKILL.md")));
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
      // After the hook: both change settings.json, and this one reads it at write time.
      targets.push({
        kind: "allow-rules",
        agent,
        label: "Claude Code permission rules",
        path: at(".claude", "settings.json"),
        rules: allowRules(runner),
        inRepo: !user,
      });
      break;
    case "codex":
      targets.push(skillTarget("Codex skill", at(".agents", "skills", "openqodex", "SKILL.md")));
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
      targets.push(skillTarget("Cursor skill", user ? at(".cursor", "skills", "openqodex", "SKILL.md") : at(".agents", "skills", "openqodex", "SKILL.md")));
      // Cursor has no user-level rule file: the rule always goes in the repo.
      const rule = fill(template("cursor", "openqodex.mdc"), version);
      if (repoRoot === null) skipped.push("Cursor rule: run openqodex init inside a git repository to add it there");
      else targets.push(fileTarget(agent, "Cursor rule", join(repoRoot, ".cursor", "rules", "openqodex.mdc"), rule, true));
      break;
    }
    case "cline":
      targets.push(skillTarget("Cline skill", at(".cline", "skills", "openqodex", "SKILL.md")));
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
