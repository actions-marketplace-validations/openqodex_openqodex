// Installs one pinned tool into the OpenQodex home folder. Runs inside the
// detached install process (`openqodex __install <tool>`), so a slow install
// finishes even when the run that started it has exited.
import { randomBytes } from "node:crypto";
import {
  accessSync,
  appendFileSync,
  chmodSync,
  constants,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import type { ResolvedTool } from "@openqodex/core";
import { InstallError, downloadVerified, extractArchive, isRegularFileInside, run, smallEnv, which } from "./fetch.js";
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

const INSTALL_TIMEOUT_MS = 20 * 60_000;
const PROBE_TIMEOUT_MS = 15_000;
// How long an install waits for another process's install of the same tool.
const LOCK_WAIT_MS = 40 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function isInstalled(home: string, tool: string, recipe: Recipe): boolean {
  return existsSync(markerPath(home, tool, recipe)) && existsSync(binaryPath(home, tool, recipe));
}

// ---------- the developer's runtimes (never installed by OpenQodex) ----------

type Runtime = { reason: string | null; env: Record<string, string> };

// Go never downloads a toolchain or a module and never sends a module path
// anywhere: not while probing, not while scanning.
const GO_OFFLINE = { GOTOOLCHAIN: "local", GOPROXY: "off" };

const runtimeNames: Record<string, string> = { ruby: "Ruby", go: "Go" };

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

// The full PATH a tool needs: its own folders first, then the current PATH.
// Scanners start from a small allowlisted environment and `env` is applied on
// top, so a PATH here replaces the whole value and must carry everything.
function pathWith(first: string[]): string {
  return [...first, process.env.PATH ?? ""].filter((p) => p !== "").join(delimiter);
}

// One probe per runtime: its version, plus what a scanner run needs from it.
// Probes run in the user's home folder, never the repo, so a repo's go.mod or
// .ruby-version cannot change what they do.
async function probe(runtime: string, file: string): Promise<{ version: string; env: Record<string, string> } | null> {
  const opts = { cwd: homedir(), timeoutMs: PROBE_TIMEOUT_MS };
  if (runtime === "go") {
    const out = await run(file, ["env", "GOVERSION", "GOPATH", "GOMODCACHE", "GOCACHE"], { ...opts, env: smallEnv(GO_OFFLINE) });
    if (out.code !== 0) return null;
    const [goversion = "", gopath = "", modcache = "", cache = ""] = out.stdout.split("\n");
    const env: Record<string, string> = { ...GO_OFFLINE, PATH: pathWith([dirname(file)]) };
    if (gopath) env.GOPATH = gopath;
    if (modcache) env.GOMODCACHE = modcache;
    if (cache) env.GOCACHE = cache;
    return { version: goversion.replace(/^go/, ""), env };
  }
  const args = runtime === "ruby" ? ["-e", "print RUBY_VERSION"] : ["--version"];
  const out = await run(file, args, { ...opts, env: smallEnv() });
  if (out.code !== 0) return null;
  return { version: /(\d+\.\d+(?:\.\d+)?)/.exec(out.stdout)?.[1] ?? "", env: { PATH: pathWith([dirname(file)]) } };
}

const runtimeChecks = new Map<string, Promise<Runtime>>();

// Whether the developer's runtime for this tool is here, and the environment
// the tool needs from it. Checked once per process.
export function checkRuntime(recipe: Recipe): Promise<Runtime> {
  const needs = parseNeeds(recipe.needs);
  if (!needs) return Promise.resolve({ reason: null, env: {} });
  const key = `${needs.runtime}>=${needs.minimum ?? ""}|${process.env.PATH ?? ""}`;
  let check = runtimeChecks.get(key);
  if (!check) {
    check = (async () => {
      const name = runtimeNames[needs.runtime] ?? needs.runtime;
      const reason = needs.minimum ? `needs ${name} ${needs.minimum} or newer` : `needs ${name}`;
      const file = which(needs.runtime);
      const found = file ? await probe(needs.runtime, file) : null;
      if (!found) return { reason, env: {} };
      if (needs.minimum && !(found.version && atLeast(found.version, needs.minimum))) return { reason, env: {} };
      return { reason: null, env: found.env };
    })();
    runtimeChecks.set(key, check);
  }
  return check;
}

export async function missingRuntime(recipe: Recipe): Promise<string | null> {
  return (await checkRuntime(recipe)).reason;
}

// The resolved tool, with the environment it needs to start from the small
// scanner environment.
export async function resolvedTool(home: string, tool: string, recipe: Recipe): Promise<ResolvedTool> {
  const dir = versionDir(home, tool, recipe);
  const runtime = await checkRuntime(recipe);
  let env: Record<string, string> = {};
  if (recipe.method === "uv") {
    // semgrep's launcher starts pysemgrep from PATH; the tool's bin folder holds it.
    env.PATH = pathWith([join(dir, "bin")]);
  } else if (recipe.method === "npm") {
    // The npm launcher is `#!/usr/bin/env node`: run it on the node running openqodex.
    env.PATH = pathWith([dirname(process.execPath)]);
  } else if (recipe.method === "gem") {
    const ruby = runtime.env.PATH ? [runtime.env.PATH.split(delimiter)[0]!] : [];
    env = { GEM_HOME: dir, GEM_PATH: dir, PATH: pathWith([join(dir, "bin"), ...ruby]) };
  } else {
    env = { ...runtime.env };
  }
  return { path: binaryPath(home, tool, recipe), version: recipe.version, env };
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
// The lock file holds "<pid> <token>". It is created atomically with its
// content (a hard link of a finished temp file), counts as stale only when its
// pid is no longer alive, and is released only by the holder of its token.
//
// Node has no kernel file lock, so one window remains: two takers that both
// re-checked the same dead holder can both rename over the lock, and the first
// may read back its own token before the second renames. Both then install.
// That cannot leave a half install that looks installed: every worker builds
// in a folder only it created and deletes only that folder, the version
// becomes visible through one atomic rename of a finished folder (with its
// marker already inside), and a worker that finds the version already in
// place, or no longer reads its own token before publishing, discards its own
// work. The cost of the window is a duplicated download, nothing more.

function lockPath(home: string, tool: string): string {
  return join(toolDir(home, tool), ".lock");
}

export function readLock(path: string): { pid: number; token: string } | null {
  try {
    const [pid = "", token = ""] = readFileSync(path, "utf8").trim().split(/\s+/);
    return Number.isInteger(Number(pid)) && Number(pid) > 0 ? { pid: Number(pid), token } : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// True while a live process holds the lock on this tool.
export function isLocked(home: string, tool: string): boolean {
  const holder = readLock(lockPath(home, tool));
  return holder !== null && isAlive(holder.pid);
}

export function holdsLock(home: string, tool: string, token: string): boolean {
  return readLock(lockPath(home, tool))?.token === token;
}

// Replaces a stale lock with the taker's own finished lock file. `observed` is
// the holder seen dead earlier; the lock is re-read right before the rename and
// the takeover goes ahead only if it is still that same dead holder. Returns
// true when the lock read back afterwards carries the taker's token.
export function takeOverStaleLock(lock: string, observed: { pid: number; token: string } | null, mine: string, token: string): boolean {
  const now = readLock(lock);
  const same = now === null ? observed === null : observed !== null && now.token === observed.token && now.pid === observed.pid;
  if (!same || (now !== null && isAlive(now.pid))) return false;
  try {
    renameSync(mine, lock);
  } catch {
    return false;
  }
  return readLock(lock)?.token === token;
}

export async function acquireLock(home: string, tool: string): Promise<string> {
  const dir = toolDir(home, tool);
  const lock = lockPath(home, tool);
  const token = randomBytes(8).toString("hex");
  const mine = join(dir, `.lock-${token}`);
  const giveUp = Date.now() + LOCK_WAIT_MS;
  try {
    for (;;) {
      writeFileSync(mine, `${process.pid} ${token}\n`);
      try {
        linkSync(mine, lock);
        return token;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new InstallError("not_installed", cannotWriteReason(home));
      }
      const holder = readLock(lock);
      if (holder === null || !isAlive(holder.pid)) {
        if (takeOverStaleLock(lock, holder, mine, token)) return token;
        continue;
      }
      if (Date.now() > giveUp) throw new InstallError("failed", `another install of ${tool} did not finish`);
      await sleep(250);
    }
  } finally {
    rmSync(mine, { force: true });
  }
}

export function releaseLock(home: string, tool: string, token: string): void {
  if (holdsLock(home, tool, token)) rmSync(lockPath(home, tool), { force: true });
}

async function withLock<T>(home: string, tool: string, fn: (token: string) => Promise<T>): Promise<T> {
  const token = await acquireLock(home, tool);
  try {
    return await fn(token);
  } finally {
    releaseLock(home, tool, token);
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

type Published = "published" | "already_installed" | "lost_lock";

// Makes `built` (a finished folder with its marker inside, created by this
// worker) the installed version with one atomic rename: the folder itself
// (`move`) or a link to it (`link`, for installs that cannot move). Before
// that, the worker must still read its own token in the lock; when it does
// not, or the version is already installed, it deletes its own folder and
// publishes nothing.
export function publishVersion(
  home: string,
  tool: string,
  recipe: Recipe,
  built: string,
  token: string,
  how: "move" | "link",
): Published {
  const final = versionDir(home, tool, recipe);
  const discard = (result: Published): Published => {
    rmSync(built, { recursive: true, force: true });
    return result;
  };
  if (isInstalled(home, tool, recipe)) return discard("already_installed");
  if (!holdsLock(home, tool, token)) return discard("lost_lock");
  // A version folder without its marker is debris from an install that died
  // under the earlier in-place layout; no live worker writes there any more.
  if (existsSync(final) || isSymlink(final)) rmSync(final, { recursive: true, force: true });
  try {
    if (how === "move") {
      renameSync(built, final);
    } else {
      const link = `${built}.link`;
      symlinkSync(basename(built), link);
      renameSync(link, final);
    }
  } catch (error) {
    if (isInstalled(home, tool, recipe)) return discard("already_installed");
    throw error;
  }
  return "published";
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

// Download, verify, unpack into this worker's own staging folder, then publish
// the finished version folder, so a half install never looks installed.
async function installRelease(
  home: string,
  tool: string,
  recipe: Extract<Recipe, { method: "github-release" }>,
  token: string,
): Promise<Published> {
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
      // Only bytes the checksum covered: a regular file inside the unpacked folder.
      if (!isRegularFileInside(source, unpacked)) {
        throw new InstallError("failed", `install failed: ${asset.binaryPath} is not a file in ${asset.name}`);
      }
    }
    const ready = join(staging, "version");
    mkdirSync(join(ready, "bin"), { recursive: true });
    const target = join(ready, "bin", recipe.binary);
    renameSync(source, target);
    chmodSync(target, 0o755);
    writeMarker(ready, recipe.version);
    return publishVersion(home, tool, recipe, ready, token, "move");
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

// Installers run with the small environment plus what OpenQodex sets, in the
// OpenQodex home folder, never the repo: a variable or a project config file
// cannot change where they read from or write to.
async function runInstaller(home: string, file: string, args: string[], extra: Record<string, string>): Promise<void> {
  const out = await run(file, args, { cwd: home, env: smallEnv(extra), timeoutMs: INSTALL_TIMEOUT_MS });
  if (out.timedOut) throw new InstallError("failed", "install failed: not finished after 20 minutes");
  if (out.code !== 0) throw new InstallError("failed", `install failed: ${lastLine(out.stderr) || `exit ${out.code}`}`);
}

// Tools installed by a package manager cannot be moved after install (absolute
// paths in scripts), so each worker installs into a folder of its own that
// stays where it is, writes the marker there, and publishes the version as a
// link to it.
async function installInPlace(home: string, tool: string, recipe: Recipe, table: Toolchain, token: string): Promise<Published> {
  const dir = mkdtempSync(join(toolDir(home, tool), `.build-${recipe.version}-`));
  chmodSync(dir, 0o755);
  try {
    if (recipe.method === "uv") {
      const uv = which("uv") ?? (await installTool("uv", { table })).path;
      const python = join(toolsDir(home), "uv-python");
      const args = [
        "tool",
        "install",
        "--python",
        recipe.python,
        ...(recipe.with ?? []).flatMap((pin) => ["--with", pin]),
        `${recipe.package}==${recipe.version}`,
      ];
      await runInstaller(home, uv, args, {
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
      const args = ["install", "--no-document", "--install-dir", dir, "--bindir", join(dir, "bin"), ...recipe.gems];
      await runInstaller(home, gem, args, {
        GEM_HOME: dir,
        GEM_PATH: dir,
        GEM_SPEC_CACHE: join(home, "cache", "gem-specs"),
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
      await runInstaller(home, npm.file, args, {});
    }
    const bin = recipe.method === "npm" ? join(dir, "node_modules", ".bin", recipe.binary) : join(dir, "bin", recipe.binary);
    if (!existsSync(bin)) throw new InstallError("failed", `install failed: ${recipe.binary} missing after install`);
    writeMarker(dir, recipe.version);
    return publishVersion(home, tool, recipe, dir, token, "link");
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
  const runtime = await missingRuntime(recipe);
  if (runtime) throw new InstallError("not_installed", runtime);
  if (isInstalled(home, tool, recipe)) return resolvedTool(home, tool, recipe);
  const unsupported = unsupportedReason(table, recipe);
  if (unsupported) throw new InstallError("not_installed", unsupported);
  const dir = ensureWritable(home, tool);
  // A worker that lost the lock to another installer goes back to waiting on
  // the lock, then finds the other's install in place.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await withLock(home, tool, async (token) => {
      if (isInstalled(home, tool, recipe)) return "already_installed" as const;
      opts.onProgress?.(`installing ${tool} ${recipe.version} (first run only)`);
      const published =
        recipe.method === "github-release"
          ? await installRelease(home, tool, recipe, token)
          : await installInPlace(home, tool, recipe, table, token);
      if (published === "published") {
        appendFileSync(join(dir, "install.log"), `${new Date().toISOString()} installed ${tool} ${recipe.version}\n`);
      }
      return published;
    });
    if (result !== "lost_lock" && isInstalled(home, tool, recipe)) return resolvedTool(home, tool, recipe);
  }
  throw new InstallError("failed", "install failed: another install kept taking the lock");
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
