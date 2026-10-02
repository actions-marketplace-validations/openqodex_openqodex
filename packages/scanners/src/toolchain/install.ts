// Installs one pinned tool into the OpenQodex home folder. Runs inside the
// detached install process (`openqodex __install <tool>`), so a slow install
// finishes even when the run that started it has exited.
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, writeSync, accessSync, constants } from "node:fs";
import { dirname, join } from "node:path";
import type { ResolvedTool } from "@openqodex/core";
import { InstallError, downloadVerified, extractArchive, run, which } from "./fetch.js";
import {
  binaryPath,
  currentPlatform,
  loadToolchain,
  markerPath,
  openqodexHome,
  toolDir,
  toolsDir,
  versionDir,
  type Recipe,
  type Toolchain,
} from "./table.js";

const LOCK_STALE_MS = 10 * 60_000;
const HEARTBEAT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 20 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function isInstalled(home: string, tool: string, recipe: Recipe): boolean {
  return existsSync(markerPath(home, tool, recipe)) && existsSync(binaryPath(home, tool, recipe));
}

export function resolvedTool(home: string, tool: string, recipe: Recipe): ResolvedTool {
  const env: Record<string, string> = {};
  if (recipe.method === "gem") {
    env.GEM_HOME = versionDir(home, tool, recipe);
    env.GEM_PATH = versionDir(home, tool, recipe);
  }
  // A scanned go.mod must never make Go download a toolchain.
  if (parseNeeds(recipe.needs)?.runtime === "go") env.GOTOOLCHAIN = "local";
  return { path: binaryPath(home, tool, recipe), version: recipe.version, env };
}

// ---------- the developer's runtimes (never installed by OpenQodex) ----------

const runtimeNames: Record<string, string> = { ruby: "Ruby", go: "Go" };
const versionArgs: Record<string, string[]> = { ruby: ["-e", "print RUBY_VERSION"], go: ["version"] };

function parseNeeds(needs: string | undefined): { runtime: string; minimum: string | null } | null {
  if (!needs) return null;
  const match = /^([a-z]+)(?:>=([0-9.]+))?$/.exec(needs);
  if (!match) throw new Error(`toolchain.json: cannot read needs "${needs}"`);
  return { runtime: match[1]!, minimum: match[2] ?? null };
}

function atLeast(version: string, minimum: string): boolean {
  const a = version.split(".").map(Number);
  const b = minimum.split(".").map(Number);
  for (let i = 0; i < b.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

const runtimeChecks = new Map<string, Promise<string | null>>();

// The plain reason a tool cannot run here because a runtime is missing, or null.
export function missingRuntime(recipe: Recipe): Promise<string | null> {
  const needs = parseNeeds(recipe.needs);
  if (!needs) return Promise.resolve(null);
  const key = `${needs.runtime}>=${needs.minimum ?? ""}|${process.env.PATH ?? ""}`;
  let check = runtimeChecks.get(key);
  if (!check) {
    check = (async () => {
      const name = runtimeNames[needs.runtime] ?? needs.runtime;
      const reason = needs.minimum ? `needs ${name} ${needs.minimum} or newer` : `needs ${name}`;
      const file = which(needs.runtime);
      if (!file) return reason;
      const out = await run(file, versionArgs[needs.runtime] ?? ["--version"], { timeoutMs: 15_000 });
      if (out.code !== 0) return reason;
      if (!needs.minimum) return null;
      const version = /(\d+\.\d+(?:\.\d+)?)/.exec(out.stdout)?.[1];
      return version && atLeast(version, needs.minimum) ? null : reason;
    })();
    runtimeChecks.set(key, check);
  }
  return check;
}

// The plain reason this machine has no way to get the tool, or null.
export function unsupportedReason(table: Toolchain, recipe: Recipe): string | null {
  const platform = currentPlatform();
  if (recipe.method === "github-release") {
    return platform && recipe.assets[platform] ? null : "no download for this platform";
  }
  if (recipe.method === "uv") {
    if (which("uv")) return null;
    const uv = table.tools.uv;
    return platform && uv?.method === "github-release" && uv.assets[platform] ? null : "no download for this platform";
  }
  if (recipe.method === "npm") return npmCommand() ? null : "needs npm";
  return null;
}

export function cannotWriteReason(home: string): string {
  return `cannot write ${home} here: run \`npx openqodex doctor --install\` in your own terminal`;
}

// Creates the tool folder, or throws the plain reason it cannot be written.
export function ensureWritable(home: string, tool: string): string {
  const dir = toolDir(home, tool);
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
  } catch {
    throw new InstallError("not_installed", cannotWriteReason(home));
  }
  return dir;
}

// ---------- the per-tool lock ----------

function lockPath(home: string, tool: string): string {
  return join(toolDir(home, tool), ".lock");
}

function isStale(lock: string): boolean {
  try {
    return Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

// True while another process holds a fresh lock on this tool.
export function isLocked(home: string, tool: string): boolean {
  const lock = lockPath(home, tool);
  return existsSync(lock) && !isStale(lock);
}

async function withLock<T>(home: string, tool: string, fn: () => Promise<T>): Promise<T> {
  const lock = lockPath(home, tool);
  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new InstallError("not_installed", cannotWriteReason(home));
      if (isStale(lock)) rmSync(lock, { force: true });
      else await sleep(250);
    }
  }
  // The holder touches the lock while it works, so only a dead holder's lock goes stale.
  const heartbeat = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(lock, now, now);
    } catch {
      // the next beat tries again
    }
  }, HEARTBEAT_MS);
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    rmSync(lock, { force: true });
  }
}

// ---------- install methods ----------

function lastLine(text: string): string {
  const lines = text.trim().split("\n");
  return (lines[lines.length - 1] ?? "").trim().slice(0, 200);
}

function writeMarker(dir: string, version: string): void {
  writeFileSync(join(dir, ".installed"), `${JSON.stringify({ version, installedAt: new Date().toISOString() })}\n`);
}

// Download, verify, unpack, then rename the finished version folder into place
// so a half install never looks installed.
async function installRelease(home: string, tool: string, recipe: Extract<Recipe, { method: "github-release" }>): Promise<void> {
  const platform = currentPlatform();
  const asset = platform ? recipe.assets[platform] : null;
  if (!asset) throw new InstallError("not_installed", "no download for this platform");
  const dir = toolDir(home, tool);
  const staging = mkdtempSync(join(dir, ".staging-"));
  try {
    const download = join(staging, "download");
    await downloadVerified(asset.url, asset.sha256, download);
    let source = download;
    if (asset.archive !== "none") {
      const unpacked = join(staging, "unpacked");
      mkdirSync(unpacked);
      await extractArchive(download, asset.archive, unpacked);
      source = join(unpacked, asset.binaryPath);
      if (!existsSync(source)) throw new InstallError("failed", `install failed: ${asset.binaryPath} is not in ${asset.name}`);
    }
    const ready = join(staging, "version");
    mkdirSync(join(ready, "bin"), { recursive: true });
    const target = join(ready, "bin", recipe.binary);
    renameSync(source, target);
    chmodSync(target, 0o755);
    writeMarker(ready, recipe.version);
    const final = versionDir(home, tool, recipe);
    rmSync(final, { recursive: true, force: true });
    renameSync(ready, final);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// npm next to the running node, so no PATH lookup decides which npm runs.
export function npmCommand(): { file: string; args: string[] } | null {
  const beside = join(dirname(process.execPath), "npm");
  if (!existsSync(beside)) return null;
  const real = realpathSync(beside);
  return /\.c?js$/.test(real) ? { file: process.execPath, args: [real] } : { file: real, args: [] };
}

async function runInstaller(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const out = await run(file, args, { env, timeoutMs: INSTALL_TIMEOUT_MS });
  if (out.code !== 0) throw new InstallError("failed", `install failed: ${lastLine(out.stderr) || `exit ${out.code}`}`);
}

// Tools installed by a package manager cannot be moved after install (absolute
// paths in scripts), so they install in place and the marker, written last, is
// what makes them count as installed.
async function installInPlace(home: string, tool: string, recipe: Recipe, table: Toolchain): Promise<void> {
  const dir = versionDir(home, tool, recipe);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    if (recipe.method === "uv") {
      const uv = which("uv") ?? (await installTool("uv", { table })).path;
      const python = join(toolsDir(home), "uv-python");
      await runInstaller(uv, ["tool", "install", "--python", recipe.python, `${recipe.package}==${recipe.version}`], {
        ...process.env,
        UV_PYTHON_INSTALL_DIR: python,
        UV_PYTHON_BIN_DIR: join(python, "bin"),
        UV_PYTHON_PREFERENCE: "only-managed",
        UV_TOOL_DIR: join(dir, "uv-tools"),
        UV_TOOL_BIN_DIR: join(dir, "bin"),
        UV_CACHE_DIR: join(home, "cache", "uv"),
        UV_NO_PROGRESS: "1",
      });
    } else if (recipe.method === "gem") {
      const ruby = which("ruby");
      const gem = ruby && existsSync(join(dirname(ruby), "gem")) ? join(dirname(ruby), "gem") : which("gem");
      if (!gem) throw new InstallError("not_installed", "needs RubyGems");
      await runInstaller(gem, ["install", "--no-document", "--install-dir", dir, "--bindir", join(dir, "bin"), ...recipe.gems], {
        ...process.env,
        GEM_HOME: dir,
        GEM_PATH: dir,
      });
    } else if (recipe.method === "npm") {
      const npm = npmCommand();
      if (!npm) throw new InstallError("not_installed", "needs npm");
      const args = [
        ...npm.args,
        "install",
        "--prefix",
        dir,
        "--no-save",
        "--no-package-lock",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
        "--cache",
        join(home, "cache", "npm"),
        `${recipe.package}@${recipe.version}`,
      ];
      await runInstaller(npm.file, args, process.env);
    }
    if (!existsSync(binaryPath(home, tool, recipe))) {
      throw new InstallError("failed", `install failed: ${recipe.binary} missing after install`);
    }
    writeMarker(dir, recipe.version);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

// Installs one tool from the table and returns it. Throws InstallError with the
// plain reason. Safe to call from several processes at once: one installs, the
// others wait on the lock and then find it installed.
export async function installTool(
  tool: string,
  opts: { table?: Toolchain; onProgress?: (line: string) => void } = {},
): Promise<ResolvedTool> {
  const table = opts.table ?? loadToolchain();
  const recipe = table.tools[tool];
  if (!recipe) throw new InstallError("failed", `${tool} is not in the toolchain table`);
  const home = openqodexHome();
  if (isInstalled(home, tool, recipe)) return resolvedTool(home, tool, recipe);
  const runtime = await missingRuntime(recipe);
  if (runtime) throw new InstallError("not_installed", runtime);
  const unsupported = unsupportedReason(table, recipe);
  if (unsupported) throw new InstallError("not_installed", unsupported);
  const dir = ensureWritable(home, tool);
  return withLock(home, tool, async () => {
    if (isInstalled(home, tool, recipe)) return resolvedTool(home, tool, recipe);
    opts.onProgress?.(`installing ${tool} ${recipe.version} (first run only)`);
    // Leftovers of an install whose process died; we hold the lock, so none is live.
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".staging-")) rmSync(join(dir, name), { recursive: true, force: true });
    }
    if (recipe.method === "github-release") await installRelease(home, tool, recipe);
    else await installInPlace(home, tool, recipe, table);
    appendFileSync(join(dir, "install.log"), `${new Date().toISOString()} installed ${tool} ${recipe.version}\n`);
    return resolvedTool(home, tool, recipe);
  });
}

// ---------- the detached install process ----------

function errorPath(home: string, tool: string): string {
  return join(toolDir(home, tool), ".error");
}

// The reason the last install of this tool failed, if it did.
export function lastInstallError(home: string, tool: string): { status: "not_installed" | "failed"; reason: string } | null {
  try {
    return JSON.parse(readFileSync(errorPath(home, tool), "utf8")) as { status: "not_installed" | "failed"; reason: string };
  } catch {
    return null;
  }
}

// The body of `openqodex __install <tool>`. Returns the exit code: 0 installed,
// 1 failed with the reason saved for the run that started it.
export async function runInstallWorker(tool: string): Promise<number> {
  const home = openqodexHome();
  rmSync(errorPath(home, tool), { force: true });
  try {
    await installTool(tool);
    return 0;
  } catch (error) {
    const failure =
      error instanceof InstallError
        ? error
        : new InstallError("failed", `install failed: ${error instanceof Error ? error.message : String(error)}`);
    try {
      mkdirSync(toolDir(home, tool), { recursive: true });
      writeFileSync(errorPath(home, tool), JSON.stringify({ status: failure.status, reason: failure.message }));
    } catch {
      // the home folder cannot be written; the caller already reports that
    }
    process.stderr.write(`${tool}: ${failure.message}\n`);
    return 1;
  }
}
