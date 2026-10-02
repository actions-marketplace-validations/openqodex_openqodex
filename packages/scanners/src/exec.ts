// The one way a scanner process is started: execFile with an argument array
// (never a shell), a small allowlisted environment, a timeout and an output
// cap. It never rejects; the caller reads the result.

import { execFile } from "node:child_process";

// Variables a scanner may see from the developer's environment. Everything
// else (tokens, cloud credentials, tool settings) stays out of the process.
const PASSED_VARIABLES = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);

// The small environment every scanner process gets: PATH, HOME, TMPDIR, LANG,
// LC_*, proxy variables, plus `extra`. Never the whole process.env.
export function scannerEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (PASSED_VARIABLES.has(key) || key.startsWith("LC_")) env[key] = value;
  }
  return { ...env, ...extra };
}

export type ExecResult = {
  stdout: string;
  stderr: string;
  // The numeric exit code, or null when the process was killed or never started.
  exitCode: number | null;
  // Set when the process could not start, timed out or overflowed its buffer.
  failure: "not_found" | "timeout" | "overflow" | "killed" | null;
};

type ExecError = Error & { code?: unknown; killed?: boolean; signal?: unknown };

// execFile, never a shell. Never rejects: the caller reads the result.
export function execTool(
  file: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; maxBytes: number; env?: Record<string, string> },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    try {
      execFile(
        file,
        args,
        {
          cwd: opts.cwd,
          timeout: opts.timeoutMs,
          maxBuffer: opts.maxBytes,
          env: scannerEnv(opts.env),
          encoding: "utf8",
          windowsHide: true,
        },
        (err, stdout, stderr) => {
          const out = stdout ?? "";
          const errText = stderr ?? "";
          if (!err) {
            resolve({ stdout: out, stderr: errText, exitCode: 0, failure: null });
            return;
          }
          const e = err as ExecError;
          if (typeof e.code === "number") {
            resolve({ stdout: out, stderr: errText, exitCode: e.code, failure: null });
            return;
          }
          if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            resolve({ stdout: out, stderr: errText, exitCode: null, failure: "overflow" });
            return;
          }
          // Node sets `killed` only when it ended the process itself, and the
          // buffer case is handled above, so this is the timeout.
          if (e.killed) {
            resolve({ stdout: out, stderr: errText, exitCode: null, failure: "timeout" });
            return;
          }
          if (typeof e.signal === "string") {
            resolve({ stdout: out, stderr: errText, exitCode: null, failure: "killed" });
            return;
          }
          // ENOENT, EACCES and the like: the process never started.
          resolve({ stdout: out, stderr: e.message, exitCode: null, failure: "not_found" });
        },
      );
    } catch (err) {
      // execFile throws synchronously on an argument it cannot pass (a NUL byte).
      const message = err instanceof Error ? err.message : String(err);
      resolve({ stdout: "", stderr: message, exitCode: null, failure: "not_found" });
    }
  });
}

// One line for a run that left nothing to read, or null when it ran.
export function describeFailure(name: string, result: ExecResult, timeoutMs: number): string | null {
  switch (result.failure) {
    case "not_found":
      return `${name} could not start: ${result.stderr.trim().slice(0, 200)}`;
    case "timeout":
      return `${name} timed out after ${Math.round(timeoutMs / 1000)}s`;
    case "overflow":
      return `${name} printed more output than the limit allows`;
    case "killed":
      return `${name} was killed`;
    default:
      return null;
  }
}

// The end of stderr, for an error line.
export function stderrTail(result: ExecResult): string {
  return result.stderr.trim().slice(-300);
}
