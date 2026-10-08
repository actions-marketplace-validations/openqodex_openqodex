import { safeGit } from "@acme/core";

// The paths with uncommitted changes, from `git status --porcelain`.
export async function changedFiles(root: string): Promise<string[]> {
  const out = await safeGit(root, ["status", "--porcelain"]);
  return out
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.slice(3));
}
