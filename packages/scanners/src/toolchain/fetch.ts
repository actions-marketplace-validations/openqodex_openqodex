// Download with a checksum, unpack with the system tar, run a program with a
// hard deadline, find a program on PATH. General on purpose: the custom
// scanner install reuses these.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, createWriteStream, lstatSync, readdirSync, rmSync } from "node:fs";
import type { WriteStream } from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ArchiveKind } from "./table.js";

// An install problem with the one plain line the developer sees.
export class InstallError extends Error {
  constructor(
    readonly status: "not_installed" | "failed",
    message: string,
  ) {
    super(message);
    this.name = "InstallError";
  }
}

const PROXY_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY"];

// The small environment every child gets: PATH, HOME, TMPDIR, LANG, LC_*, the
// proxy variables, plus `extra`. Never the whole environment, so a variable
// such as TAR_OPTIONS, npm_config_registry or UV_INDEX_URL cannot change what
// an installer reads or where it writes. The developer's own config files
// (~/.npmrc, uv's config) still apply.
export function smallEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const keep =
      key === "PATH" ||
      key === "HOME" ||
      key === "TMPDIR" ||
      key === "LANG" ||
      key.startsWith("LC_") ||
      PROXY_VARS.includes(key.toUpperCase());
    if (keep) env[key] = value;
  }
  return { ...env, ...extra };
}

// A download that sends no data for this long is abandoned.
const IDLE_MS = 60_000;
// Whatever the pace, a download ends by this deadline and below this size.
const DEADLINE_MS = 15 * 60_000;
const MAX_BYTES = 500 * 1024 * 1024;

function shortCause(error: unknown): string {
  const cause = error instanceof Error ? (error.cause as { code?: string; message?: string } | undefined) : undefined;
  if (cause?.code) return cause.code;
  if (cause?.message) return cause.message;
  return error instanceof Error ? error.message : String(error);
}

// Streams a URL to `dest`, returns its sha256, throws when `sha256` is given and differs.
// `limits` exists for tests; callers use the defaults.
export async function downloadVerified(
  url: string,
  sha256: string | null,
  dest: string,
  limits: { deadlineMs?: number; maxBytes?: number } = {},
): Promise<{ sha256: string }> {
  const deadlineMs = limits.deadlineMs ?? DEADLINE_MS;
  const maxBytes = limits.maxBytes ?? MAX_BYTES;
  const controller = new AbortController();
  let stopped: string | null = null;
  const stop = (why: string) => {
    stopped ??= why;
    controller.abort();
  };
  let idle = setTimeout(() => stop("no data for 60 seconds"), IDLE_MS);
  const deadline = setTimeout(() => stop(`not finished after ${Math.round(deadlineMs / 1000)} seconds`), deadlineMs);
  const hash = createHash("sha256");
  let bytes = 0;
  let out: WriteStream | null = null;
  try {
    const response = await fetch(url, { redirect: "follow", signal: controller.signal });
    if (!response.ok || !response.body) throw new InstallError("failed", `download failed: HTTP ${response.status}`);
    await pipeline(
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>),
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          clearTimeout(idle);
          idle = setTimeout(() => stop("no data for 60 seconds"), IDLE_MS);
          bytes += chunk.length;
          if (bytes > maxBytes) {
            stop(`larger than ${Math.round(maxBytes / (1024 * 1024))} MB`);
            throw new Error("too large");
          }
          hash.update(chunk);
          yield chunk;
        }
      },
      (out = createWriteStream(dest, { mode: 0o644 })),
      { signal: controller.signal },
    );
  } catch (error) {
    // The file is opened in the background: wait until the stream has closed,
    // or a late open would put the file back after it was removed.
    const stream = out as WriteStream | null;
    if (stream !== null && !stream.closed) await new Promise<void>((done) => stream.once("close", () => done()));
    rmSync(dest, { force: true });
    if (error instanceof InstallError) throw error;
    throw new InstallError("failed", `download failed: ${stopped ?? shortCause(error)}`);
  } finally {
    clearTimeout(idle);
    clearTimeout(deadline);
  }
  const actual = hash.digest("hex");
  if (sha256 !== null && actual !== sha256.toLowerCase()) {
    rmSync(dest, { force: true });
    throw new InstallError("failed", "checksum mismatch");
  }
  return { sha256: actual };
}

export type RunResult = { code: number | null; stdout: string; stderr: string; missing: boolean; timedOut: boolean };

const MAX_OUTPUT = 64 * 1024 * 1024;

// Runs a program without a shell, in its own process group, with the small
// environment unless `env` is given. At the deadline the whole group gets
// SIGKILL, so a child that ignores SIGTERM or leaves a descendant holding its
// output open cannot hang the caller.
export function run(
  file: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((done) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, { cwd: opts.cwd, env: opts.env ?? smallEnv(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      // A binary for another CPU (an Intel Ruby on Apple Silicon) throws here.
      finish({ code: null, stdout: "", stderr: error instanceof Error ? error.message : String(error), missing: true, timedOut: false });
      return;
    }
    timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      finish({ code: null, stdout, stderr, missing: false, timedOut: true });
    }, opts.timeoutMs ?? 120_000);
    child.stdout?.setEncoding("utf8").on("data", (d: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += d;
    });
    child.stderr?.setEncoding("utf8").on("data", (d: string) => {
      if (stderr.length < MAX_OUTPUT) stderr += d;
    });
    child.once("error", (error) => {
      finish({ code: null, stdout, stderr: stderr || error.message, missing: true, timedOut: false });
    });
    child.once("close", (code) => finish({ code, stdout, stderr, missing: false, timedOut: false }));
  });
}

// The first executable named `name` on PATH, or null.
export function which(name: string, path = process.env.PATH ?? ""): string | null {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

function lastLine(text: string): string {
  const lines = text.trim().split("\n");
  return (lines[lines.length - 1] ?? "").trim().slice(0, 200);
}

const tarFlag: Record<"tar.gz" | "tar.xz", string> = { "tar.gz": "z", "tar.xz": "J" };

// Every path under `dir` that is a symlink, so nothing outside is reached through it.
function findLinks(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) found.push(path);
    else if (entry.isDirectory()) found.push(...findLinks(path));
  }
  return found;
}

// Unpacks a tar.gz, tar.xz or zip into `destDir`. Members are listed and
// checked before anything is written: a member whose path escapes the folder,
// or that is a symlink or hardlink, is refused, because a link would select
// bytes the checksum never covered.
export async function extractArchive(archive: string, kind: ArchiveKind, destDir: string): Promise<void> {
  const list =
    kind === "zip" ? await run("unzip", ["-Z1", archive]) : await run("tar", [`-t${tarFlag[kind]}f`, archive]);
  if (list.code !== 0) {
    if (kind === "zip" && list.missing) throw new InstallError("not_installed", "unzip missing");
    if (list.missing) throw new InstallError("not_installed", "tar missing");
    if (kind === "tar.xz" && which("xz") === null) throw new InstallError("not_installed", "xz missing");
    throw new InstallError("failed", `could not unpack: ${lastLine(list.stderr)}`);
  }
  const root = resolve(destDir);
  for (const raw of list.stdout.split("\n")) {
    const name = raw.replace(/\r$/, "");
    if (name === "") continue;
    const rel = relative(root, resolve(root, name));
    if (isAbsolute(name) || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new InstallError("failed", `archive member ${name} escapes the destination`);
    }
  }
  // The long listing shows each member's type in its first column: l for a
  // symlink, h for a hardlink (tar and zipinfo alike).
  const long = kind === "zip" ? await run("unzip", ["-Z", archive]) : await run("tar", [`-tv${tarFlag[kind]}f`, archive]);
  if (long.code !== 0) throw new InstallError("failed", `could not unpack: ${lastLine(long.stderr)}`);
  for (const line of long.stdout.split("\n")) {
    if (/^[lh][rwxsStT-]{9}/.test(line) || / link to /.test(line)) {
      throw new InstallError("failed", `archive member is a link: ${line.trim().slice(0, 200)}`);
    }
  }
  const out =
    kind === "zip"
      ? await run("unzip", ["-q", "-o", archive, "-d", root])
      : await run("tar", [`-x${tarFlag[kind]}f`, archive, "-C", root, "--no-same-owner"]);
  if (out.code !== 0) throw new InstallError("failed", `could not unpack: ${lastLine(out.stderr)}`);
  // A second check after unpacking, in case a listing format hid a link.
  const links = findLinks(root);
  if (links.length > 0) {
    for (const entry of readdirSync(root)) rmSync(join(root, entry), { recursive: true, force: true });
    throw new InstallError("failed", `archive member is a link: ${relative(root, links[0]!)}`);
  }
}

// True when `path` is a regular file inside `dir`, neither a symlink nor a hardlink.
export function isRegularFileInside(path: string, dir: string): boolean {
  const rel = relative(resolve(dir), resolve(path));
  if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) return false;
  try {
    const stat = lstatSync(path);
    return stat.isFile() && stat.nlink === 1;
  } catch {
    return false;
  }
}
