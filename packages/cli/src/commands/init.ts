// `openqodex init`: installs OpenQodex into the developer's coding agents in
// one step. User scope by default, so one install works in every repo and the
// repo's git status does not change; `--project` writes the files into the
// repo for a team to commit.
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGENT_NAMES, AGENTS, detectAgents, type AgentId } from "../agents/detect.js";
import { excludeLine, gitPath, planExclude, planUnexclude, repoRootOf, trackedFiles } from "../agents/git.js";
import { hasOurHook, planInstall, planUninstall, type Action } from "../agents/plan.js";
import { targetsFor, type Scope, type Target } from "../agents/targets.js";
import { EXIT_OK, EXIT_TOOL_FAILED } from "../exit-codes.js";
import {
  installRuntime,
  launcherIsCurrent,
  launcherIsOurs,
  launcherPath,
  openqodexHomeDir,
  runtimeDir,
  runtimeIsCurrent,
  shQuote,
  writeLauncher,
} from "../launcher.js";

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

function printPlan(actions: Action[]): void {
  for (const a of actions) out(`  ${a.verb.padEnd(8)} ${a.path}  (${a.note})`);
}

function interactive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function confirm(message: string): Promise<boolean> {
  const prompts = await import("@clack/prompts");
  const answer = await prompts.confirm({ message, initialValue: true });
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
    process.stderr.write(
      `openqodex: could not start the scanner installs (${error instanceof Error ? error.message : String(error)}); they install on first review instead\n`,
    );
  }
}

export async function run(args: string[]): Promise<number> {
  const parsed = parseFlags(args);
  if (typeof parsed === "string") {
    process.stderr.write(`openqodex init: ${parsed}\n${USAGE}\n`);
    return EXIT_TOOL_FAILED;
  }
  const flags = parsed;
  const version = __OPENQODEX_VERSION__;
  const home = homedir();
  const oqHome = openqodexHomeDir();
  const scope: Scope = flags.project ? "project" : "user";
  const repoRoot = await repoRootOf(process.cwd());

  if (flags.project && repoRoot === null) {
    process.stderr.write("openqodex init --project: run it inside a git repository\n");
    return EXIT_TOOL_FAILED;
  }

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

  // Hooks in user files call the launcher by absolute path. Project files are
  // committed for a team, where that path would not exist, so they use npx.
  const launcher = launcherPath(oqHome);
  const runner = flags.project ? `npx -y openqodex@${version}` : shQuote(launcher);

  const targets: Target[] = [];
  const skippedNotes: string[] = [];
  const seen = new Set<string>();
  for (const agent of agents) {
    const { targets: ts, skipped } = targetsFor({ agent, scope, home, repoRoot, version, runner });
    skippedNotes.push(...skipped);
    for (const t of ts) {
      // Two agents can share a project skill path (.agents/skills).
      if (seen.has(t.path)) continue;
      seen.add(t.path);
      targets.push(t);
    }
  }

  const excludeFile = repoRoot !== null && !flags.project ? await gitPath(repoRoot, "info/exclude") : null;
  const repoFilesToHide = (ts: Target[]): Target[] =>
    excludeFile === null ? [] : ts.filter((t) => t.kind !== "hook-json" && t.inRepo);

  const actions: Action[] = [];
  let failed = false;

  if (flags.uninstall) {
    for (const t of targets) {
      const a = planUninstall(t);
      if (a) actions.push(a);
    }
    for (const t of repoFilesToHide(targets)) {
      const a = planUnexclude(excludeFile!, excludeLine(repoRoot!, t.path));
      if (a) actions.push(a);
    }
    if (!flags.project) {
      // Keep the launcher while a hook of an agent not being removed still calls it.
      const stillUsed = (["claude-code", "codex"] as const).some(
        (a) => !agents.includes(a) && hasOurHook(join(home, a === "claude-code" ? ".claude/settings.json" : ".codex/hooks.json")),
      );
      if (!stillUsed && launcherIsOurs(oqHome)) {
        actions.push({ verb: "remove", path: launcher, note: "launcher", apply: () => rmSync(launcher, { force: true }) });
      }
      const runtimes = join(oqHome, "runtime");
      if (!stillUsed && existsSync(runtimes)) {
        actions.push({
          verb: "remove",
          path: runtimes,
          note: "runtime copies of openqodex",
          apply: () => rmSync(runtimes, { recursive: true, force: true }),
        });
      }
    }
  } else {
    const needsLauncher = !flags.project && targets.some((t) => t.kind === "hook-json");
    if (needsLauncher) {
      const rt = runtimeDir(version, oqHome);
      actions.push(
        runtimeIsCurrent(version, oqHome)
          ? { verb: "skip", path: rt, note: "runtime already present" }
          : {
              verb: existsSync(rt) ? "update" : "create",
              path: rt,
              note: "a copy of this openqodex that the hooks run",
              apply: () => installRuntime(version, oqHome),
            },
      );
      actions.push(
        launcherIsCurrent(version, oqHome)
          ? { verb: "skip", path: launcher, note: "launcher already present" }
          : {
              verb: existsSync(launcher) ? "update" : "create",
              path: launcher,
              note: "launcher the hooks call",
              apply: () => writeLauncher(version, oqHome),
            },
      );
    }
    const planned = targets.map((t) => ({ t, a: planInstall(t) }));
    actions.push(...planned.map((p) => p.a));
    const written = planned.filter((p) => p.a.verb !== "refuse").map((p) => p.t);
    for (const t of repoFilesToHide(written)) actions.push(planExclude(excludeFile!, excludeLine(repoRoot!, t.path)));
  }
  if (actions.some((a) => a.failed)) failed = true;

  const work = actions.filter((a) => a.apply !== undefined);
  out(flags.uninstall ? "OpenQodex uninstall plan:" : `OpenQodex ${version} install plan (${scope} scope):`);
  printPlan(actions);
  for (const note of skippedNotes) out(`  note     ${note}`);

  if (work.length === 0) {
    out(flags.uninstall ? "Nothing to remove: OpenQodex is not installed here." : "Nothing to change: OpenQodex is already installed.");
    return failed ? EXIT_TOOL_FAILED : EXIT_OK;
  }
  if (flags.dryRun) {
    out("Dry run: nothing was written.");
    return EXIT_OK;
  }
  if (!flags.yes) {
    if (!interactive()) {
      process.stderr.write("openqodex init: no terminal to confirm in; run again with --yes\n");
      return EXIT_TOOL_FAILED;
    }
    if (!(await confirm(flags.uninstall ? "Remove these?" : "Write these files?"))) {
      out("Nothing was written.");
      return EXIT_OK;
    }
  }

  for (const a of work) {
    try {
      await a.apply!();
    } catch (error) {
      process.stderr.write(`openqodex init: ${a.path}: ${error instanceof Error ? error.message : String(error)}\n`);
      // A hook must never point at a launcher that does not work.
      if (a.path === launcher || a.path === runtimeDir(version, oqHome)) return EXIT_TOOL_FAILED;
      failed = true;
    }
  }

  out();
  if (flags.uninstall) {
    out("OpenQodex was removed from the files above.");
    out(`Scanners stay in ${join(oqHome, "tools")}; delete that folder to remove them too.`);
    return failed ? EXIT_TOOL_FAILED : EXIT_OK;
  }

  if (repoRoot !== null) await startScannerInstalls(repoRoot);
  out(`OpenQodex is set up for ${agents.map((a) => AGENT_NAMES[a]).join(", ")}.`);
  out('Say this to your agent: "review my change with openqodex"');
  if (agents.includes("codex")) out("Codex: run /hooks once inside Codex and trust the new OpenQodex hook, or Codex will not run it.");
  out(`To undo: npx openqodex init --uninstall${flags.project ? " --project" : ""}`);
  out("Optional, for pushes from any tool: npx openqodex hook install (adds a git pre-push hook to this repo)");
  return failed ? EXIT_TOOL_FAILED : EXIT_OK;
}
