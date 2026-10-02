// The toolchain: finds each pinned scanner, installing it on first use into
// ~/.openqodex/tools/<tool>/<version>/. A builtin scanner is never taken from
// PATH, so two machines report the same findings.
import { spawn } from "node:child_process";
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
export { openqodexHome } from "./table.js";
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
};
const ALL_SCANNERS = Object.keys(builtins) as BuiltinScanner[];

// ---------- the detached install process ----------

// The hidden CLI command that runs one install: `openqodex __install <tool>`.
export const INSTALL_WORKER_COMMAND = "__install";

// In the published package this file is bundled into the CLI's bin.js, so the
// install process is the CLI itself. Tests point it at a small script instead.
let workerEntry = fileURLToPath(import.meta.url);

export function setInstallWorkerEntry(path: string): void {
  workerEntry = path;
}

// The arguments after the node executable for one install process.
export function installWorkerArgv(tool: string): string[] {
  return [workerEntry, INSTALL_WORKER_COMMAND, tool];
}

function startWorker(tool: string) {
  return spawn(process.execPath, installWorkerArgv(tool), { detached: true, stdio: "ignore" });
}

const STILL_INSTALLING: ToolResolution = {
  ok: false,
  status: "installing",
  reason: "first run only, still installing; it will be included next run",
};

// Runs the install in a detached process from the start, so it keeps going if
// this process exits, and waits for it up to the budget.
function installDetached(tool: string, recipe: Recipe, home: string, budgetMs: number | null): Promise<ToolResolution> {
  return new Promise((done) => {
    let timer: NodeJS.Timeout | undefined;
    const child = startWorker(tool);
    child.once("error", (error) => {
      clearTimeout(timer);
      done({ ok: false, status: "failed", reason: `could not start the install: ${error.message}` });
    });
    child.once("exit", () => {
      clearTimeout(timer);
      if (isInstalled(home, tool, recipe)) {
        done({ ok: true, tool: resolvedTool(home, tool, recipe) });
        return;
      }
      const failure = lastInstallError(home, tool);
      done(failure ? { ok: false, ...failure } : { ok: false, status: "failed", reason: "install failed" });
    });
    if (budgetMs !== null) {
      timer = setTimeout(() => {
        child.unref();
        done(STILL_INSTALLING);
      }, budgetMs);
    }
  });
}

type ResolverOptions = { allowInstall: boolean; installBudgetMs: number | null; onProgress?: (line: string) => void };

async function resolveOne(scanner: BuiltinScanner, opts: ResolverOptions): Promise<ToolResolution> {
  const table = loadToolchain();
  const recipe = table.tools[scanner];
  if (!recipe) return { ok: false, status: "failed", reason: "runs inside openqodex, no tool to resolve" };
  const home = openqodexHome();
  if (isInstalled(home, scanner, recipe)) return { ok: true, tool: resolvedTool(home, scanner, recipe) };
  const blocked = (await missingRuntime(recipe)) ?? unsupportedReason(table, recipe);
  if (blocked) return { ok: false, status: "not_installed", reason: blocked };
  if (!opts.allowInstall) return { ok: false, status: "not_installed", reason: "not installed (installs are off)" };
  try {
    ensureWritable(home, scanner);
  } catch (error) {
    if (error instanceof InstallError) return { ok: false, status: error.status, reason: error.message };
    throw error;
  }
  opts.onProgress?.(`installing ${scanner} ${recipe.version} (first run only)`);
  return installDetached(scanner, recipe, home, opts.installBudgetMs);
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
  if (isInstalled(home, scanner, recipe)) {
    return { scanner, state: "ready", version, detail: resolvedTool(home, scanner, recipe).path };
  }
  const runtime = await missingRuntime(recipe);
  if (runtime) return { scanner, state: "needs_runtime", version, detail: runtime };
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
  const resolve = createToolResolver({ allowInstall: true, installBudgetMs: null, onProgress });
  await Promise.all(list.map((scanner) => resolve(scanner)));
  return Promise.all(list.map(statusOf));
}

// Starts the same install in a detached process and returns at once.
export function installToolsDetached(scanners: BuiltinScanner[] | null): void {
  const table = loadToolchain();
  const home = openqodexHome();
  for (const scanner of scanners ?? ALL_SCANNERS) {
    const recipe = table.tools[scanner];
    if (!recipe || isInstalled(home, scanner, recipe) || unsupportedReason(table, recipe)) continue;
    // The install process checks the runtime itself and records why it stopped.
    const child = startWorker(scanner);
    child.once("error", () => undefined);
    child.unref();
  }
}
