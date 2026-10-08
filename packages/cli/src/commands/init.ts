// `openqodex init`: installs OpenQodex into the developer's coding agents in
// one step. User scope by default, so one install works in every repo and the
// agent files stay out of the repo's git status; `--project` writes them into
// the repo for a team to commit. Inside a repo the plan also holds the git
// pre-push hook, the two team files in `.openqodex/` and the team review
// section, each on by default (--hook none and --no-repo leave them out). It
// prints the whole plan, for the developer and for the team, and asks once.
// It ends with a review (init-review.ts) unless --no-review is given.
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { FOLDER_CONFIG, INSTRUCTIONS_FILE, STATE_DIR, repoStat } from "@openqodex/core";
import { AGENT_NAMES, AGENTS, detectAgents, type AgentId } from "../agents/detect.js";
import { readText } from "../agents/files.js";
import { excludeLine, gitDirs, gitPath, inWorkTree, planExclude, planUnexclude, repoRootOf, trackedFiles } from "../agents/git.js";
import { planInstall, planUninstall, type Action, type Ctx } from "../agents/plan.js";
import { withBoundary } from "../agents/lock.js";
import { loadRecord, saveRecord, serialize, type InstallRecord } from "../agents/record.js";
import { commitLines, INSTRUCTIONS_LINE, planRepoFiles, planRepoFilesRemoval, ROOT_CONFIG_NOTE } from "../agents/repo-folder.js";
import { targetsFor, teamSection, teamTargets, type Scope, type Target } from "../agents/targets.js";
import { EXIT_OK, EXIT_TOOL_FAILED } from "../exit-codes.js";
import { hostAgent } from "../reviewers/driver.js";
import { launcherPath, launcherRunner, launcherUsers, openqodexHomeDir, planRuntime, planRuntimeRemoval, pruneRuntimes, removeOldLocks } from "../launcher.js";
import { planGitHook, planGitHookRemoval, setHookChoice } from "./hook.js";
import { reviewAfterInit } from "./init-review.js";
import { pruneHomeReceipts } from "../receipts.js";

type HookChoice = "pre-push" | "none";

type Flags = { agents: AgentId[]; project: boolean; yes: boolean; uninstall: boolean; dryRun: boolean; hook: HookChoice | null; noRepo: boolean; noReview: boolean };

const USAGE =
  "usage: openqodex init [--agent <claude-code|cursor|codex|cline|all>]... [--project] [--hook <pre-push|none>] [--no-repo] [--no-review] [--yes] [--uninstall] [--dry-run]";

// The one question init asks, after the whole plan.
const WRITE_QUESTION = "Write these files?";

const HOST_NAMES: Record<NonNullable<ReturnType<typeof hostAgent>>, string> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor" };

function parseFlags(args: string[]): Flags | string {
  const flags: Flags = { agents: [], project: false, yes: false, uninstall: false, dryRun: false, hook: null, noRepo: false, noReview: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--project") flags.project = true;
    else if (arg === "--no-repo") flags.noRepo = true;
    else if (arg === "--no-review") flags.noReview = true;
    else if (arg === "--yes" || arg === "-y") flags.yes = true;
    else if (arg === "--uninstall") flags.uninstall = true;
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--hook" || arg.startsWith("--hook=")) {
      const value = arg === "--hook" ? args[++i] : arg.slice("--hook=".length);
      if (value !== "pre-push" && value !== "none") return `unknown hook: ${value ?? "(missing)"}. Choose pre-push or none.`;
      flags.hook = value;
    }    else if (arg === "--agent" || arg.startsWith("--agent=")) {
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

// The agents to install into when detection found none; null when the
// developer cancels.
async function chooseAgents(): Promise<AgentId[] | null> {
  const prompts = await import("@clack/prompts");
  const answer = await prompts.multiselect<AgentId>({
    message: "No coding agent found on this machine. Which ones should OpenQodex install into?",
    options: AGENTS.map((a) => ({ value: a, label: AGENT_NAMES[a] })),
    required: true,
  });
  return prompts.isCancel(answer) ? null : AGENTS.filter((a) => answer.includes(a));
}

// Whether this repo gets the git pre-push hook: --hook, then the choice this
// repo made before, then yes. `earlier`: the choice came from the record.
function hookChoiceFor(s: Setup, record: InstallRecord): { hook: HookChoice; earlier: boolean } {
  if (s.flags.hook !== null) return { hook: s.flags.hook, earlier: false };
  const before = record.hookChoices.find((c) => c.repo === s.repoRoot);
  return before ? { hook: before.hook, earlier: true } : { hook: "pre-push", earlier: false };
}

// Whether this repo gets the team review section: --no-repo, then --yes,
// which adds it even where this repo said no before, then that earlier
// choice, then yes.
function teamChoiceFor(s: Setup, record: InstallRecord): { write: boolean; earlier: boolean } {
  if (s.flags.noRepo) return { write: false, earlier: false };
  if (s.flags.yes) return { write: true, earlier: false };
  const before = record.teamChoices.find((c) => c.repo === s.repoRoot);
  return before ? { write: before.write, earlier: true } : { write: true, earlier: false };
}

function setTeamChoice(record: InstallRecord, repo: string, write: boolean): void {
  record.teamChoices = record.teamChoices.filter((c) => c.repo !== repo);
  record.teamChoices.push({ repo, write });
}

// The team section in the repo's CLAUDE.md and AGENTS.md, planned apart from
// the agents: it is the team's, not one agent's. A link on the way refuses
// both files with the reason.
// True when the repo's git ignore rules hide this untracked path: a section
// written there would never show in git status to be committed.
function ignoredByGit(repoRoot: string, path: string): boolean {
  return spawnSync("git", ["check-ignore", "-q", "--", path], { cwd: repoRoot }).status === 0;
}

function planTeam(s: Setup, record: InstallRecord): Action[] {
  const ctx: Ctx = { record, scope: s.scope, repoRoot: s.repoRoot };
  try {
    const actions: Action[] = [];
    for (const t of teamTargets(s.repoRoot!, s.version)) {
      if (!s.flags.uninstall && ignoredByGit(s.repoRoot!, t.path)) {
        actions.push({ verb: "skip", path: t.path, note: `team review section not written: ${relative(s.repoRoot!, t.path)} is in this repo's git ignore rules, so it could not be committed` });
        continue;
      }
      const a = s.flags.uninstall ? planUninstall(t, ctx) : planInstall(t, ctx);
      if (a) actions.push({ ...a, agent: undefined });
    }
    return actions;
  } catch (error) {
    return [{ verb: "refuse", failed: true, path: "-", note: `team review section not ${s.flags.uninstall ? "removed" : "written"}: ${message(error)}` }];
  }
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

type Setup = {
  flags: Flags;
  agents: AgentId[];
  scope: Scope;
  home: string;
  oqHome: string;
  repoRoot: string | null;
  version: string;
  // Files this run wrote, so the closing review does not take init's own
  // files for the developer's change.
  written: string[];
  // Each written path's text before init wrote it, null when it was not there.
  before: Map<string, string | null>;
};

function collectTargets(s: Setup): { targets: Target[]; notes: string[] } {
  const runner = s.flags.project ? `npx -y openqodex@${s.version}` : launcherRunner(launcherPath(s.oqHome));
  const targets: Target[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  for (const agent of s.agents) {
    const r = targetsFor({ agent, scope: s.scope, home: s.home, repoRoot: s.repoRoot, version: s.version, runner });
    notes.push(...r.skipped);
    for (const t of r.targets) {
      // Two agents can share a project skill path (.agents/skills); the hook
      // and the permission rules share settings.json.
      const key = `${t.kind} ${t.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
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

// The section each agent's own instruction file gets, as it will be written.
function printSection(actions: Action[], targets: Target[]): void {
  const writes = new Set(actions.filter((a) => a.apply).map((a) => a.path));
  const sections = targets.flatMap((t) => (t.kind === "md-section" && writes.has(t.path) ? [t] : []));
  if (sections.length === 0) return;
  out(`The instruction section init writes into ${sections.map((t) => t.label).join(" and ")}:`);
  for (const line of sections[0].section.split("\n")) out(`    ${line}`);
}

// The install plan, every file under the one it is for: the developer, on
// this machine (user-scope agent files, the launcher, the git hook, which
// lives in this clone only), or the team, in the repo to commit.
function printInstallPlan(s: Setup, mine: Action[], team: Action[], notes: string[], targets: Target[], teamActions: Action[]): void {
  out(`OpenQodex ${s.version} install plan (${s.scope} scope):`);
  if (mine.length > 0) {
    out("For you, on this machine:");
    printPlan(mine, []);
  }
  if (team.length > 0) {
    out("For the team, in this repo (commit these):");
    printPlan(team, []);
  }
  printPlan([], notes);
  printSection([...mine, ...team], targets);
  if (teamActions.some((a) => a.apply)) {
    out("The review section init writes into the repo's CLAUDE.md and AGENTS.md:");
    for (const line of teamSection(s.version).split("\n")) out(`    ${line}`);
  }
  if (s.repoRoot !== null) {
    out(s.flags.project ? "To leave out the git pre-push hook: --hook none." : "To leave out the git pre-push hook: --hook none. To leave out the team review section: --no-repo.");
  }
}

// How the install step ended, beside its exit code. Only "written" and
// "unchanged" go on to the review: a declined plan ("cancelled") stops there.
type Outcome = { code: number; ended: "written" | "unchanged" | "cancelled" | "stopped" | "dry-run" | "removed" };

async function runLocked(s: Setup): Promise<Outcome> {
  const record = loadRecord(s.oqHome);
  const recordBefore = serialize(record);
  const { targets, notes } = collectTargets(s);
  if (!s.flags.uninstall && s.agents.includes("cursor") && s.repoRoot !== null) {
    notes.push("Cursor has no global instruction file: its rule in this repo carries the same section");
  }
  const actions: Action[] = [];
  const runtimeActions = new Set<Action>();
  // The install plan by whom each file is for (printInstallPlan).
  const mine: Action[] = [];
  const team: Action[] = [];
  const teamActions: Action[] = [];
  let failed = false;

  const agentActions = await planAgents(s, record, targets);
  let rootConfig = false;
  let hookChoice: HookChoice | null = null;
  if (s.flags.uninstall) {
    actions.push(...agentActions);
    if (s.repoRoot !== null) {
      actions.push(...(await planRepoFilesRemoval(s.repoRoot, record)));
      const hook = await planGitHookRemoval(s.repoRoot, record, s.oqHome);
      if (hook) actions.push(hook);
      record.hookChoices = record.hookChoices.filter((c) => c.repo !== s.repoRoot);
      if (!s.flags.project) {
        actions.push(...planTeam(s, record));
        record.teamChoices = record.teamChoices.filter((c) => c.repo !== s.repoRoot);
      }
    }
  } else {
    // Every user-scope install gets the runtime and the launcher: the skill
    // calls it even where no hook does.
    const needsLauncher = s.scope === "user" || targets.some((t) => t.kind === "hook-json" && t.usesLauncher);
    const runtime = needsLauncher ? planRuntime(record, s.version, s.oqHome) : [];
    for (const a of runtime) runtimeActions.add(a);
    mine.push(...runtime);
    // Project-scope agent files are committed: the team's.
    (s.flags.project ? team : mine).push(...agentActions);
    if (s.repoRoot !== null) {
      const repo = planRepoFiles(s.repoRoot, record);
      rootConfig = repo.rootConfig;
      team.push(...repo.actions);
      const hook = hookChoiceFor(s, record);
      hookChoice = hook.hook;
      if (!s.flags.dryRun) setHookChoice(record, s.repoRoot, hookChoice);
      if (hookChoice === "pre-push") {
        if (runtimeActions.size === 0) {
          const more = planRuntime(record, s.version, s.oqHome);
          for (const a of more) runtimeActions.add(a);
          // The runtime goes first: the hook calls it.
          mine.unshift(...more);
        }
        mine.push((await planGitHook(s.repoRoot, record, s.oqHome, false)).action);
      } else notes.push(`git pre-push hook: left out${hook.earlier ? ", as this repo chose before" : ""}; --hook pre-push adds it`);
      // Project scope writes its own section into the same two files.
      if (!s.flags.project) {
        const choice = teamChoiceFor(s, record);
        if (!s.flags.dryRun) setTeamChoice(record, s.repoRoot, choice.write);
        if (choice.write) {
          teamActions.push(...planTeam(s, record));
          team.push(...teamActions);
        } else notes.push(`team review section: left out${choice.earlier ? ", as this repo chose before" : ""}; run init --yes without --no-repo to add it`);
      }
    }
    actions.push(...mine, ...team);
    if ([...runtimeActions].some((a) => a.failed)) {
      printInstallPlan(s, mine, team, notes, targets, teamActions);
      process.stderr.write("openqodex init: nothing was written; the launcher hooks call cannot be set up (see above)\n");
      return { code: EXIT_TOOL_FAILED, ended: "stopped" };
    }
  }

  if (s.flags.uninstall && !s.flags.project) {
    // Hook files this run leaves alone (another agent, a file that could not
    // be parsed) still call the launcher.
    const touched = new Set(actions.filter((a) => a.apply).map((a) => a.path));
    const willStay = launcherUsers(record).filter((p) => !touched.has(p));
    actions.push(...planRuntimeRemoval(record, s.oqHome, willStay));
  }

  if (s.flags.uninstall) {
    out("OpenQodex uninstall plan:");
    printPlan(actions, notes);
  } else printInstallPlan(s, mine, team, notes, targets, teamActions);

  if (actions.some((a) => a.failed)) failed = true;
  const work = actions.filter((a) => a.apply !== undefined);

  if (s.flags.dryRun) {
    out(work.length === 0 ? "Nothing to change." : "Dry run: nothing was written.");
    return { code: failed ? EXIT_TOOL_FAILED : EXIT_OK, ended: "dry-run" };
  }
  if (work.length === 0) {
    saveRecord(s.oqHome, record, recordBefore);
    out(s.flags.uninstall ? "Nothing to remove." : "Nothing to change: OpenQodex is already installed.");
    if (!s.flags.uninstall) closingRepoLines(s, rootConfig);
    return { code: failed ? EXIT_TOOL_FAILED : EXIT_OK, ended: s.flags.uninstall ? "removed" : "unchanged" };
  }
  // One consent for the whole plan: --yes, else the answer in a terminal,
  // else the agent this runs inside (its shell has no terminal, and the
  // agent ran init on purpose), else none: exit 2 with the plan shown.
  if (!s.flags.yes) {
    const host = hostAgent();
    if (interactive()) {
      if (!(await confirm(s.flags.uninstall ? "Remove these?" : WRITE_QUESTION))) {
        out("Nothing was written.");
        return { code: EXIT_OK, ended: "cancelled" };
      }
    } else if (host !== null && !s.flags.uninstall) {
      out(`Running inside ${HOST_NAMES[host]} with no terminal to ask in: writing the plan above.`);
    } else {
      process.stderr.write(
        s.flags.uninstall
          ? "openqodex init: no terminal to confirm in; run again with --yes\n"
          : "openqodex init: no terminal to confirm in, and no agent to act for; nothing was written.\n" +
              "Run it again with --yes to write the plan above. To change the plan: --hook none (no git pre-push hook), --no-repo (no team review section), --project (everything inside the repo, for the team to commit), --agent <name> (only that agent).\n",
      );
      return { code: EXIT_TOOL_FAILED, ended: "stopped" };
    }
  }

  const failedPaths = new Set<string>();
  // Only a file git could stage is part of the change: never one in the git
  // folder (the pre-push hook, the exclude file), wherever that folder is.
  const gitFolders = s.repoRoot !== null ? await gitDirs(s.repoRoot) : [];
  try {
    const brokenAgents = new Set<AgentId>();
    for (const a of work) {
      if (a.agent && brokenAgents.has(a.agent)) continue;
      try {
        if (a.guard && readText(a.guard.path) !== a.guard.before) {
          throw new Error(`changed while init was running, nothing written to ${a.guard.path}`);
        }
        // The text before init's first write, so the review after init
        // takes the developer's own edits and not init's.
        if (s.repoRoot !== null && !s.before.has(a.path) && inWorkTree(s.repoRoot, gitFolders, a.path)) {
          try {
            s.before.set(a.path, readText(a.path));
          } catch {
            // not a text file: the review takes it as it is on disk
          }
        }
        await a.apply!();
        s.written.push(a.path);
      } catch (error) {
        process.stderr.write(`openqodex init: ${a.path}: ${message(error)}\n`);
        failed = true;
        failedPaths.add(a.path);
        // A hook must never point at a launcher that does not work.
        if (runtimeActions.has(a) && !s.flags.uninstall) return { code: EXIT_TOOL_FAILED, ended: "stopped" };
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
    return { code: failed ? EXIT_TOOL_FAILED : EXIT_OK, ended: "removed" };
  }

  if (s.repoRoot !== null) await startScannerInstalls(s.repoRoot);
  out(`OpenQodex is set up for ${s.agents.map((a) => AGENT_NAMES[a]).join(", ")}.`);
  out('Say this to your agent: "review my change with openqodex". Each agent\'s instructions now say to run the review when a feature or fix is done.');
  if (s.agents.includes("codex")) out("Codex: run /hooks once inside Codex and trust the new OpenQodex hook, or Codex will not run it.");
  closingRepoLines(s, rootConfig);
  const teamChanged = teamActions.filter((a) => a.apply && !failedPaths.has(a.path)).map((a) => relative(s.repoRoot!, a.path));
  if (teamChanged.length > 0) {
    out(`Changed ${teamChanged.join(" and ")}: a review section your teammates' agents follow before they push.`);
    for (const line of commitLines(s.repoRoot!, teamChanged)) out(line);
  }
  if (s.repoRoot !== null && hookChoice === "pre-push") out("Every push from this repo is now checked for a review through the git pre-push hook.");
  out(`To undo: npx openqodex init --uninstall${s.flags.project ? " --project" : ""}`);
  return { code: failed ? EXIT_TOOL_FAILED : EXIT_OK, ended: "written" };
}

// Names the two team files in the repo and what to do with them.
function closingRepoLines(s: Setup, rootConfig: boolean): void {
  if (s.repoRoot === null) return;
  const repoRoot = s.repoRoot;
  const files = [`${STATE_DIR}/${FOLDER_CONFIG}`, `${STATE_DIR}/${INSTRUCTIONS_FILE}`].filter((f) => repoStat(repoRoot, f) !== null);
  for (const line of commitLines(repoRoot, files)) out(line);
  if (files.includes(`${STATE_DIR}/${INSTRUCTIONS_FILE}`)) out(INSTRUCTIONS_LINE);
  if (rootConfig) out(ROOT_CONFIG_NOTE);
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
  // None found: a terminal can ask which ones (an agent installed where no
  // check looks, or one about to be installed); a shell without one gets the list.
  if (agents.length === 0 && interactive() && !flags.yes && !flags.dryRun) {
    const chosen = await chooseAgents();
    if (chosen === null) {
      out("Nothing was written.");
      return EXIT_OK;
    }
    agents = chosen;
  }
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
    written: [],
    before: new Map(),
  };
  try {
    // A dry run writes nothing and takes no lock. Otherwise everything runs
    // inside the commit boundary, so no update switches versions meanwhile.
    if (flags.dryRun) return (await runLocked(setup)).code;
    const outcome = await withBoundary(setup.oqHome, { wait: 60_000 }, async () => {
      removeOldLocks(setup.oqHome);
      const outcome = await runLocked(setup);
      if (!flags.uninstall) pruneRuntimes(setup.oqHome);
      pruneHomeReceipts(setup.oqHome);
      return outcome;
    });
    // After the boundary is released, so the review holds no install lock.
    // A declined or stopped install reviews nothing.
    const installed = outcome.ended === "written" || outcome.ended === "unchanged";
    if (outcome.code === EXIT_OK && installed && !flags.noReview && repoRoot !== null) {
      const runner = flags.project ? `npx -y openqodex@${setup.version}` : launcherRunner(launcherPath(setup.oqHome));
      await reviewAfterInit({ repoRoot, runner, interactive: interactive() && !flags.yes, initFiles: setup.before });
    }
    return outcome.code;
  } catch (error) {
    process.stderr.write(`openqodex init: ${message(error)}\n`);
    return EXIT_TOOL_FAILED;
  }
}
