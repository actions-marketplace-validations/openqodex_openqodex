// The toolchain: finds each pinned scanner, installing it on first use into
// ~/.openqodex/tools/<tool>/<version>/. A builtin scanner is never taken from
// PATH, so two machines report the same findings.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BuiltinScanner, ResolveTool, ToolResolution, ToolStatus } from "@openqodex/core";
import { InstallError } from "./fetch.js";
import {
  ensureWritable,
  isInstalled,
  isLocked,
  lastInstallError,
  missingRuntime,
  resolvedTool,
  unsupportedReason,
} from "./install.js";
import { loadToolchain, openqodexHome, type Recipe } from "./table.js";

export { downloadVerified, extractArchive, InstallError } from "./fetch.js";
export { installTool, runInstallWorker } from "./install.js";
export { openqodexHome, toolchainHash } from "./table.js";
export type { Recipe, ReleaseAsset, Toolchain } from "./table.js";

// Every builtin scanner, checked against the type so a new one is not missed.
const builtins: Record<BuiltinScanner, true> = {
  semgrep: true,
  gitleaks: true,
  sqllint: true,
  "osv-scanner": true,
  actionlint: true,
  hadolint: true,
  shellcheck: true,
  ruff: true,
  brakeman: true,
  rubocop: true,
  bandit: true,
  oxlint: true,
  golangci: true,
  zizmor: true,
  trivy: true,
  squawk: true,
  "kube-linter": true,
  tflint: true,
  kubeconform: true,
  "cargo-deny": true,
  checkov: true,
  sqlfluff: true,
};
const ALL_SCANNERS = Object.keys(builtins) as BuiltinScanner[];

// ---------- the detached install process ----------

// The hidden CLI command that runs one install: `openqodex __install <tool>`.
export const INSTALL_WORKER_COMMAND = "__install";

let workerOverride: string | null = null;

// For tests: the program to start as the install process.
export function setInstallWorkerEntry(path: string): void {
  workerOverride = path;
}

// The running program itself. In the published package that is the one
// bundled CLI file, whose hidden `__install <tool>` command runs runInstallWorker.
function workerEntry(): string {
  if (workerOverride) return workerOverride;
  return process.argv[1] ? resolve(process.argv[1]) : fileURLToPath(import.meta.url);
}

// The arguments after the node executable for one install process.
export function installWorkerArgv(tool: string): string[] {
  return [workerEntry(), INSTALL_WORKER_COMMAND, tool];
}

// The worker runs in another folder, so it gets this process's absolute home:
// a relative OPENQODEX_HOME would otherwise name a different place there.
function startWorker(tool: string) {
  return spawn(process.execPath, installWorkerArgv(tool), {
    cwd: homedir(),
    detached: true,
    stdio: "ignore",
    env: { ...process.env, OPENQODEX_HOME: openqodexHome() },
  });
}

const STILL_INSTALLING: ToolResolution = {
  ok: false,
  status: "installing",
  reason: "first run only, still installing; it will be included next run",
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const remaining = (deadline: number) => Math.max(0, deadline - Date.now());
const TIMED_OUT = Symbol("timed out");

// Waits for the promise for at most `ms`. The timer is cleared as soon as the
// race settles, so it never keeps the process alive after the work is done.
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function installedResolution(home: string, tool: string, recipe: Recipe): Promise<ToolResolution> {
  return { ok: true, tool: await resolvedTool(home, tool, recipe) };
}

function failedResolution(home: string, tool: string): ToolResolution {
  const failure = lastInstallError(home, tool);
  return failure ? { ok: false, ...failure } : { ok: false, status: "failed", reason: "install failed" };
}

// Starts the install in a detached process, so it keeps going if this process
// exits, and waits for it until `deadline` (null: no limit).
function installDetached(tool: string, recipe: Recipe, home: string, deadline: number | null): Promise<ToolResolution> {
  return new Promise((done) => {
    let timer: NodeJS.Timeout | undefined;
    const child = startWorker(tool);
    child.once("error", (error) => {
      clearTimeout(timer);
      done({ ok: false, status: "failed", reason: `could not start the install: ${error.message}` });
    });
    child.once("exit", () => {
      clearTimeout(timer);
      done(isInstalled(home, tool, recipe) ? installedResolution(home, tool, recipe) : failedResolution(home, tool));
    });
    if (deadline !== null) {
      timer = setTimeout(() => {
        child.unref();
        done(STILL_INSTALLING);
      }, Math.max(0, deadline - Date.now()));
    }
  });
}

type ResolverOptions = { allowInstall: boolean; installBudgetMs: number | null; onProgress?: (line: string) => void };

async function resolveOne(scanner: BuiltinScanner, opts: ResolverOptions): Promise<ToolResolution> {
  // The budget covers everything below, the runtime probes included.
  const deadline = opts.installBudgetMs === null ? null : Date.now() + opts.installBudgetMs;
  const table = loadToolchain();
  const recipe = table.tools[scanner];
  if (!recipe) return { ok: false, status: "failed", reason: "runs inside openqodex, no tool to resolve" };
  const home = openqodexHome();
  // The probe is shared and may finish in the background; this caller waits
  // for it only as long as its budget allows.
  const probe = missingRuntime(recipe);
  const runtime = deadline === null ? await probe : await withDeadline(probe, remaining(deadline));
  if (runtime === TIMED_OUT) return { ok: false, status: "not_installed", reason: "still checking for the runtime; it will be included next run" };
  if (runtime) return { ok: false, status: "not_installed", reason: runtime };
  if (isInstalled(home, scanner, recipe)) return installedResolution(home, scanner, recipe);
  const unsupported = unsupportedReason(table, recipe);
  if (unsupported) return { ok: false, status: "not_installed", reason: unsupported };
  if (!opts.allowInstall) return { ok: false, status: "not_installed", reason: "not installed (installs are off)" };
  try {
    ensureWritable(home, scanner);
  } catch (error) {
    if (error instanceof InstallError) return { ok: false, status: error.status, reason: error.message };
    throw error;
  }
  // Another process is installing it: wait on that one instead of starting another.
  if (isLocked(home, scanner)) {
    while (isLocked(home, scanner)) {
      if (deadline !== null && Date.now() >= deadline) return STILL_INSTALLING;
      await sleep(deadline === null ? 250 : Math.min(250, remaining(deadline)));
    }
    if (isInstalled(home, scanner, recipe)) return installedResolution(home, scanner, recipe);
    if (lastInstallError(home, scanner)) return failedResolution(home, scanner);
  }
  opts.onProgress?.(`installing ${scanner} ${recipe.version} (first run only)`);
  return installDetached(scanner, recipe, home, deadline);
}

// installBudgetMs null means wait for every install to finish.
export function createToolResolver(opts: ResolverOptions): ResolveTool {
  const seen = new Map<BuiltinScanner, Promise<ToolResolution>>();
  return (scanner) => {
    let resolution = seen.get(scanner);
    if (!resolution) {
      resolution = resolveOne(scanner, opts);
      seen.set(scanner, resolution);
    }
    return resolution;
  };
}

async function statusOf(scanner: BuiltinScanner): Promise<ToolStatus> {
  const table = loadToolchain();
  const recipe = table.tools[scanner];
  if (!recipe) return { scanner, state: "ready", version: "built in", detail: "runs inside openqodex" };
  const home = openqodexHome();
  const version = recipe.version;
  const runtime = await missingRuntime(recipe);
  if (runtime) return { scanner, state: "needs_runtime", version, detail: runtime };
  if (isInstalled(home, scanner, recipe)) {
    return { scanner, state: "ready", version, detail: (await resolvedTool(home, scanner, recipe)).path };
  }
  const unsupported = unsupportedReason(table, recipe);
  if (unsupported) return { scanner, state: "unsupported", version, detail: unsupported };
  if (isLocked(home, scanner)) return { scanner, state: "installing", version, detail: null };
  const failure = lastInstallError(home, scanner);
  return { scanner, state: "will_install", version, detail: failure ? `last attempt: ${failure.reason}` : null };
}

export function toolStatuses(): Promise<ToolStatus[]> {
  return Promise.all(ALL_SCANNERS.map(statusOf));
}

// Installs the named scanners (default: every one this machine supports) and waits.
export async function installTools(
  scanners: BuiltinScanner[] | null,
  onProgress?: (line: string) => void,
): Promise<ToolStatus[]> {
  const list = scanners ?? ALL_SCANNERS;
  const resolveTool = createToolResolver({ allowInstall: true, installBudgetMs: null, onProgress });
  await Promise.all(list.map((scanner) => resolveTool(scanner)));
  return Promise.all(list.map(statusOf));
}

// Starts the same install in a detached process and returns at once.
export function installToolsDetached(scanners: BuiltinScanner[] | null): void {
  const table = loadToolchain();
  const home = openqodexHome();
  for (const scanner of scanners ?? ALL_SCANNERS) {
    const recipe = table.tools[scanner];
    if (!recipe || isInstalled(home, scanner, recipe) || isLocked(home, scanner) || unsupportedReason(table, recipe)) continue;
    // The install process checks the runtime itself and records why it stopped.
    const child = startWorker(scanner);
    child.once("error", () => undefined);
    child.unref();
  }
}
