// Contract stub. The owning stream replaces this file; the exported names and
// signatures are frozen (see packages/core/src/types.ts).


const notBuilt = (name: string): never => {
  throw new Error(`${name} is not built yet`);
};

// The small environment every scanner process gets: PATH, HOME, TMPDIR, LANG,
// LC_*, proxy variables, plus `extra`. Never the whole process.env.
export function scannerEnv(_extra?: Record<string, string>): NodeJS.ProcessEnv {
  return notBuilt("scannerEnv");
}

export type ExecResult = {
  stdout: string;
  stderr: string;
  // The numeric exit code, or null when the process was killed or never started.
  exitCode: number | null;
  // Set when the process could not start, timed out or overflowed its buffer.
  failure: "not_found" | "timeout" | "overflow" | "killed" | null;
};

// execFile, never a shell. Never rejects: the caller reads the result.
export function execTool(
  _file: string,
  _args: string[],
  _opts: { cwd: string; timeoutMs: number; maxBytes: number; env?: Record<string, string> },
): Promise<ExecResult> {
  return notBuilt("execTool");
}
