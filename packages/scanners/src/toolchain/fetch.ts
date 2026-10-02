// Download with a checksum, unpack with the system tar, find a program on PATH.
// General on purpose: the custom scanner install reuses these.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, createWriteStream, rmSync } from "node:fs";
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

// A download that sends no data for this long is abandoned.
const IDLE_MS = 60_000;

function shortCause(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "no data for 60 seconds";
  const cause = error instanceof Error ? (error.cause as { code?: string; message?: string } | undefined) : undefined;
  if (cause?.code) return cause.code;
  if (cause?.message) return cause.message;
  return error instanceof Error ? error.message : String(error);
}

// Streams a URL to `dest`, returns its sha256, throws when `sha256` is given and differs.
export async function downloadVerified(url: string, sha256: string | null, dest: string): Promise<{ sha256: string }> {
  const controller = new AbortController();
  let idle = setTimeout(() => controller.abort(), IDLE_MS);
  const hash = createHash("sha256");
  try {
    const response = await fetch(url, { redirect: "follow", signal: controller.signal });
    if (!response.ok || !response.body) throw new InstallError("failed", `download failed: HTTP ${response.status}`);
    await pipeline(
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>),
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          clearTimeout(idle);
          idle = setTimeout(() => controller.abort(), IDLE_MS);
          hash.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(dest, { mode: 0o644 }),
    );
  } catch (error) {
    rmSync(dest, { force: true });
    if (error instanceof InstallError) throw error;
    throw new InstallError("failed", `download failed: ${shortCause(error)}`);
  } finally {
    clearTimeout(idle);
  }
  const actual = hash.digest("hex");
  if (sha256 !== null && actual !== sha256.toLowerCase()) {
    rmSync(dest, { force: true });
    throw new InstallError("failed", "checksum mismatch");
  }
  return { sha256: actual };
}

type RunResult = { code: number | null; stdout: string; stderr: string; missing: boolean };

export function run(
  file: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((done) => {
    // A binary for another CPU (an Intel Ruby on Apple Silicon) throws here
    // instead of failing in the callback.
    const cannotStart = (error: unknown) =>
      done({ code: null, stdout: "", stderr: error instanceof Error ? error.message : String(error), missing: true });
    try {
      execFile(
        file,
        args,
        { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
        (error, stdout, stderr) => {
          const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
          const missing = Boolean(error && typeof error.code === "string");
          done({ code, stdout: String(stdout), stderr: String(stderr), missing });
        },
      );
    } catch (error) {
      cannotStart(error);
    }
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

// Unpacks a tar.gz, tar.xz or zip into `destDir`, refusing members that escape it.
// Members are listed and checked before anything is written.
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
  const out =
    kind === "zip"
      ? await run("unzip", ["-q", "-o", archive, "-d", root])
      : await run("tar", [`-x${tarFlag[kind]}f`, archive, "-C", root, "--no-same-owner"]);
  if (out.code !== 0) throw new InstallError("failed", `could not unpack: ${lastLine(out.stderr)}`);
}
