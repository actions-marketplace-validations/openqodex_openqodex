import { safeGit } from "@acme/core";

// The current branch name, or null outside a repository.
export async function currentBranch(root: string): Promise<string | null> {
  try {
    const name = await safeGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return name.trim();
  } catch {
    return null;
  }
}
