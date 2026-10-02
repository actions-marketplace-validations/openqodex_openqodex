// `openqodex init`: installs OpenQodex into the developer's coding agents in
// one step. User scope by default, so one install works in every repo and the
// repo's git status does not change; `--project` writes the files into the
// repo for a team to commit.
import { homedir } from "node:os";
import { join } from "node:path";
import { AGENT_NAMES, AGENTS, detectAgents, type AgentId } from "../agents/detect.js";
import { readText } from "../agents/files.js";
import { excludeLine, gitPath, planExclude, planUnexclude, repoRootOf, trackedFiles } from "../agents/git.js";
import { planInstall, planUninstall, type Action, type Ctx } from "../agents/plan.js";
import { loadRecord, saveRecord, serialize, withLock, type InstallRecord } from "../agents/record.js";
import { targetsFor, type Scope, type Target } from "../agents/targets.js";
import { EXIT_OK, EXIT_TOOL_FAILED } from "../exit-codes.js";
import { launcherPath, launcherUsers, openqodexHomeDir, planRuntime, planRuntimeRemoval, shQuote } from "../launcher.js";

type Flags = { agents: AgentId[]; project: boolean; yes: boolean; uninstall: boolean; dryRun: boolean };

const USAGE = "usage: openqodex init [--agent <claude-code|cursor|codex|cline|all>]... [--project] [--yes] [--uninstall] [--dry-run]";

function parseFlags(args: string[]): Flags | string {
  const flags: Flags = { agents: [], project: false, yes: false, uninstall: false, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--project") flags.project = true;
    else if (arg === "--yes" || arg === "-y") flags.yes = true;
    else if (arg === "--uninstall") flags.uninstall = true;
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--agent" || arg.startsWith("--agent=")) {
      const value = arg === "--agent" ? args[++i] : arg.slice("--agent=".length);
      if (value === "all") flags.agents.push(...AGENTS);
      else if ((AGENTS as readonly string[]).includes(value)) flags.agents.push(value as AgentId);
      else return `unknown agent: ${value ?? "(missing)"}. Choose claude-code, cursor, codex, cline or all.`;
    } else return `unknown argument: ${arg}`;
  }
  flags.agents = AGENTS.filter((a) => flags.agents.includes(a));
  return flags;
}

function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function interactive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function confirm(question: string): Promise<boolean> {
  const prompts = await import("@clack/prompts");
  const answer = await prompts.confirm({ message: question, initialValue: true });
  return !prompts.isCancel(answer) && answer === true;
}

// Starts the scanner installs this repo will need, outside any agent sandbox.
// Never fails init: the review installs on first use anyway.
async function startScannerInstalls(repoRoot: string): Promise<void> {
  try {
    const { ADAPTERS, installToolsDetached } = await import("@openqodex/scanners");
    const files = await trackedFiles(repoRoot);
    const wanted = ADAPTERS.filter((a) => a.wants(files, repoRoot)).map((a) => a.source);
    if (wanted.length === 0) return;
    installToolsDetached(wanted);
    out(`Installing the scanners this repo needs in the background: ${wanted.join(", ")}.`);
  } catch (error) {
    process.stderr.write(`openqodex: could not start the scanner installs (${message(error)}); they install on first review instead\n`);
  }
}

async function blocksOnFindings(repoRoot: string): Promise<boolean> {
  try {
    const { loadConfig } = await import("@openqodex/core");
    return loadConfig(repoRoot).config.blockOnSeverity !== null;
  } catch {
    return false;
  }
}

type Setup = {
  flags: Flags;
  agents: AgentId[];
  scope: Scope;
  home: string;
  oqHome: string;
  repoRoot: string | null;
  version: string;
};

function collectTargets(s: Setup): { targets: Target[]; notes: string[] } {
  const runner = s.flags.project ? `npx -y openqodex@${s.version}` : shQuote(launcherPath(s.oqHome));
  const targets: Target[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  for (const agent of s.agents) {
    const r = targetsFor({ agent, scope: s.scope, home: s.home, repoRoot: s.repoRoot, version: s.version, runner });
    notes.push(...r.skipped);
    for (const t of r.targets) {
      // Two agents can share a project skill path (.agents/skills).
      if (seen.has(t.path)) continue;
      seen.add(t.path);
      targets.push(t);
    }
  }
  return { targets, notes };
}

// Plans one agent's targets. A file that cannot be read, or a repo path
// through a symlink, stops that agent with the reason.
async function planAgents(s: Setup, record: InstallRecord, targets: Target[]): Promise<Action[]> {
  const ctx: Ctx = { record, scope: s.scope, repoRoot: s.repoRoot };
  const excludeFile = s.repoRoot !== null && !s.flags.project ? await gitPath(s.repoRoot, "info/exclude") : null;
  const actions: Action[] = [];
  for (const agent of s.agents) {
    const mine = targets.filter((t) => t.agent === agent);
    const planned: Action[] = [];
    try {
      for (const t of mine) {
        if (s.flags.uninstall) {
          const a = planUninstall(t, ctx);
          if (a) planned.push(a);
        } else planned.push(planInstall(t, ctx));
        // A repo file written in user scope is hidden from git status.
        if (excludeFile !== null && t.kind === "file" && t.inRepo) {
          const line = excludeLine(s.repoRoot!, t.path);
          const last = planned[planned.length - 1];
          // A rule the developer edited or owns stays, and so does its exclude line.
          const stays = last !== undefined && (last.verb === "keep" || last.verb === "refuse");
          if (stays) continue;
          if (s.flags.uninstall) {
            const a = planUnexclude(excludeFile, line, s.repoRoot!, record);
            if (a) planned.push(a);
          } else planned.push(planExclude(excludeFile, line, s.repoRoot!, record));
        }
      }
    } catch (error) {
      actions.push({ verb: "refuse", failed: true, path: "-", agent, note: `${AGENT_NAMES[agent]} not ${s.flags.uninstall ? "removed" : "installed"}: ${message(error)}` });
      continue;
    }
    actions.push(...planned);
  }
  return actions;
}

function printPlan(actions: Action[], notes: string[]): void {
  for (const a of actions) out(`  ${a.verb.padEnd(8)} ${a.path}  (${a.note})`);
  for (const note of notes) out(`  note     ${note}`);
}

async function runLocked(s: Setup): Promise<number> {
  const record = loadRecord(s.oqHome);
  const recordBefore = serialize(record);
  const { targets, notes } = collectTargets(s);
  const actions: Action[] = [];
  let failed = false;

  const agentActions = await planAgents(s, record, targets);
  if (s.flags.uninstall) {
    actions.push(...agentActions);
  } else {
    const needsLauncher = targets.some((t) => t.kind === "hook-json" && t.usesLauncher);
    const runtime = needsLauncher ? planRuntime(record, s.version, s.oqHome) : [];
    actions.push(...runtime, ...agentActions);
    if (runtime.some((a) => a.failed)) {
      out(`OpenQodex ${s.version} install plan (${s.scope} scope):`);
      printPlan(actions, notes);
      process.stderr.write("openqodex init: nothing was written; the launcher hooks call cannot be set up (see above)\n");
      return EXIT_TOOL_FAILED;
    }
  }

  if (s.flags.uninstall && !s.flags.project) {
    // Hook files this run leaves alone (another agent, a file that could not
    // be parsed) still call the launcher.
    const touched = new Set(agentActions.filter((a) => a.apply).map((a) => a.path));
    const willStay = launcherUsers(record).filter((p) => !touched.has(p));
    actions.push(...planRuntimeRemoval(record, s.oqHome, willStay));
  }

  if (actions.some((a) => a.failed)) failed = true;
  const work = actions.filter((a) => a.apply !== undefined);
  out(s.flags.uninstall ? "OpenQodex uninstall plan:" : `OpenQodex ${s.version} install plan (${s.scope} scope):`);
  printPlan(actions, notes);

  if (s.flags.dryRun) {
    out(work.length === 0 ? "Nothing to change." : "Dry run: nothing was written.");
    return failed ? EXIT_TOOL_FAILED : EXIT_OK;
  }
  if (work.length === 0) {
    saveRecord(s.oqHome, record, recordBefore);
    out(s.flags.uninstall ? "Nothing to remove." : "Nothing to change: OpenQodex is already installed.");
    return failed ? EXIT_TOOL_FAILED : EXIT_OK;
  }
  if (!s.flags.yes) {
    if (!interactive()) {
      process.stderr.write("openqodex init: no terminal to confirm in; run again with --yes\n");
      return EXIT_TOOL_FAILED;
    }
    if (!(await confirm(s.flags.uninstall ? "Remove these?" : "Write these files?"))) {
      out("Nothing was written.");
      return EXIT_OK;
    }
  }

  try {
    const brokenAgents = new Set<AgentId>();
    for (const a of work) {
      if (a.agent && brokenAgents.has(a.agent)) continue;
      try {
        if (a.guard && readText(a.guard.path) !== a.guard.before) {
          throw new Error(`changed while init was running, nothing written to ${a.guard.path}`);
        }
        await a.apply!();
      } catch (error) {
        process.stderr.write(`openqodex init: ${a.path}: ${message(error)}\n`);
        failed = true;
        // A hook must never point at a launcher that does not work.
        if (!a.agent && !s.flags.uninstall) return EXIT_TOOL_FAILED;
        if (a.agent) brokenAgents.add(a.agent);
      }
    }
  } finally {
    saveRecord(s.oqHome, record, recordBefore);
  }

  out();
  if (s.flags.uninstall) {
    out("OpenQodex was removed from the files above.");
    out(`Scanners stay in ${join(s.oqHome, "tools")}; delete that folder to remove them too.`);
    return failed ? EXIT_TOOL_FAILED : EXIT_OK;
  }

  if (s.repoRoot !== null) await startScannerInstalls(s.repoRoot);
  out(`OpenQodex is set up for ${s.agents.map((a) => AGENT_NAMES[a]).join(", ")}.`);
  out('Say this to your agent: "review my change with openqodex"');
  if (s.agents.includes("codex")) out("Codex: run /hooks once inside Codex and trust the new OpenQodex hook, or Codex will not run it.");
  out(`To undo: npx openqodex init --uninstall${s.flags.project ? " --project" : ""}`);
  if (s.repoRoot !== null && (await blocksOnFindings(s.repoRoot))) {
    out("This repo sets block_on_severity: run npx openqodex hook install so a git pre-push hook checks every push, from any tool.");
  } else out("Optional, for pushes from any tool: npx openqodex hook install (adds a git pre-push hook to this repo)");
  return failed ? EXIT_TOOL_FAILED : EXIT_OK;
}

export async function run(args: string[]): Promise<number> {
  const parsed = parseFlags(args);
  if (typeof parsed === "string") {
    process.stderr.write(`openqodex init: ${parsed}\n${USAGE}\n`);
    return EXIT_TOOL_FAILED;
  }
  const flags = parsed;
  const repoRoot = await repoRootOf(process.cwd());
  if (flags.project && repoRoot === null) {
    process.stderr.write("openqodex init --project: run it inside a git repository\n");
    return EXIT_TOOL_FAILED;
  }
  const home = homedir();
  let agents = flags.agents;
  if (agents.length === 0) agents = flags.uninstall ? [...AGENTS] : detectAgents(home);
  if (agents.length === 0) {
    process.stderr.write(
      "openqodex init: no coding agent found on this machine. Name one with --agent:\n" +
        AGENTS.map((a) => `  --agent ${a}    ${AGENT_NAMES[a]}\n`).join("") +
        "  --agent all\n",
    );
    return EXIT_TOOL_FAILED;
  }
  const setup: Setup = {
    flags,
    agents,
    scope: flags.project ? "project" : "user",
    home,
    oqHome: openqodexHomeDir(),
    repoRoot,
    version: __OPENQODEX_VERSION__,
  };
  try {
    // A dry run writes nothing, not even the lock.
    return flags.dryRun ? await runLocked(setup) : await withLock(setup.oqHome, () => runLocked(setup));
  } catch (error) {
    process.stderr.write(`openqodex init: ${message(error)}\n`);
    return EXIT_TOOL_FAILED;
  }
}
