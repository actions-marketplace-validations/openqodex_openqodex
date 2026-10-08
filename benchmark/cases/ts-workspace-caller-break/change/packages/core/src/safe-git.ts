import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export type GitResult = { code: number; stdout: string; stderr: string };

// Runs git with hooks and the pager off. A failing command no longer
// throws: the caller reads `code`.
export async function safeGit(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await run("git", ["-c", "core.hooksPath=/dev/null", "--no-pager", ...args], { cwd });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: unknown; stdout?: string; stderr?: string };
    return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}
