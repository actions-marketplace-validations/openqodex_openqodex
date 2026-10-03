import { mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import "./global-setup.js";
import { baseline, git, inventory, run } from "./support.js";

// `hook pre-push` scans a pushed commit that is not the clean HEAD in a
// temporary checkout and copies the work tree's settings into it. A pushed
// commit can carry symbolic links where those settings go; the copy must
// never write or delete through them.
const ZERO = "0".repeat(40);

// A clean repo whose branch `pushed` holds one commit made by `plant`, with
// HEAD back on the first branch and real settings files in the work tree.
function repoWithPushedCommit(plant: (dir: string) => void): { dir: string; sha: string } {
  const dir = baseline();
  git(dir, "checkout", "-q", "-b", "pushed");
  plant(dir);
  git(dir, "add", "-A"); git(dir, "commit", "-qm", "Settings as a link");
  const sha = git(dir, "rev-parse", "HEAD").trim();
  git(dir, "checkout", "-q", "-");
  mkdirSync(join(dir, ".openqodex"), { recursive: true });
  writeFileSync(join(dir, ".openqodex/config.yaml"), "# the work tree's config\n");
  writeFileSync(join(dir, ".openqodex/custom-instructions.md"), "The work tree's instructions.\n");
  writeFileSync(join(dir, ".openqodex.yaml"), "# the work tree's root config\n");
  return { dir, sha };
}

function outsideFolder(): string {
  const outside = mkdtempSync(join(tmpdir(), "oq-hook-outside-"));
  writeFileSync(join(outside, "config.yaml"), "outside config\n");
  writeFileSync(join(outside, "custom-instructions.md"), "outside instructions\n");
  writeFileSync(join(outside, ".gitignore"), "outside gitignore\n");
  return outside;
}

describe("pre-push hook settings copy", () => {
  it("never writes into a folder outside the checkout when the pushed .openqodex is a link to it", () => {
    const outside = outsideFolder();
    const before = inventory(outside, true);
    const { dir, sha } = repoWithPushedCommit((d) => symlinkSync(outside, join(d, ".openqodex")));
    const push = run("hook-links-folder", dir, ["hook", "pre-push", "origin"], { input: `refs/heads/pushed ${sha} refs/heads/pushed ${ZERO}\n` });
    expect(push.status).toBe(0);
    expect(inventory(outside, true)).toEqual(before);
    expect(readdirSync(outside).sort()).toEqual([".gitignore", "config.yaml", "custom-instructions.md"]);
  });

  it("never writes to a file outside the checkout when the pushed .openqodex/config.yaml is a link to it", () => {
    const outside = outsideFolder();
    const before = inventory(outside, true);
    const { dir, sha } = repoWithPushedCommit((d) => {
      mkdirSync(join(d, ".openqodex"));
      symlinkSync(join(outside, "config.yaml"), join(d, ".openqodex/config.yaml"));
    });
    const push = run("hook-links-file", dir, ["hook", "pre-push", "origin"], { input: `refs/heads/pushed ${sha} refs/heads/pushed ${ZERO}\n` });
    expect(push.status).toBe(0);
    expect(inventory(outside, true)).toEqual(before);
    expect(readdirSync(outside).sort()).toEqual([".gitignore", "config.yaml", "custom-instructions.md"]);
  });
});
