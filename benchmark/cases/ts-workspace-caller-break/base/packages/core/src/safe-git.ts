import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// Runs git with hooks and the pager off and returns its standard output.
// A failing command throws.
export async function safeGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-c", "core.hooksPath=/dev/null", "--no-pager", ...args], { cwd });
  return stdout;
}
