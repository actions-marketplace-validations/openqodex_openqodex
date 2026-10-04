import { mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import "./global-setup.js";
import { baseline, git, inventory, run } from "./support.js";

// `hook pre-push` looks up the review of a pushed commit from the run state
// in .openqodex/. A pushed commit or the work tree can carry symbolic links
// where that state goes; the hook must never write, delete or hang through them.
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

// Run state under .openqodex (the receipts, the folder's .gitignore) is read
// by every scan; a link there to an endless file would hang the push.
const BOUNDED = 20_000;

describe("pre-push hook with links in the run state", () => {
  it("does not hang reading a pushed commit's .openqodex/latest.json that links to an endless file", () => {
    const { dir, sha } = repoWithPushedCommit((d) => {
      mkdirSync(join(d, ".openqodex"));
      symlinkSync("/dev/zero", join(d, ".openqodex/latest.json"));
      writeFileSync(join(d, "app/added.py"), "def added():\n    return 1\n");
    });
    const push = run("hook-links-pushed-latest", dir, ["hook", "pre-push", "origin"], { input: `refs/heads/pushed ${sha} refs/heads/pushed ${ZERO}\n`, timeout: BOUNDED });
    expect(push.status).toBe(0);
  });

  it("leaves the target of a .openqodex/.gitignore that links outside alone", () => {
    const outside = outsideFolder();
    const before = inventory(outside, true);
    const dir = baseline();
    mkdirSync(join(dir, ".openqodex"));
    symlinkSync(join(outside, ".gitignore"), join(dir, ".openqodex/.gitignore"));
    const push = run("hook-links-checkout-gitignore", dir, ["hook", "pre-push"], { input: "", timeout: BOUNDED });
    expect(push.status).toBe(0);
    expect(inventory(outside, true)).toEqual(before);
  });

  it("does not hang reading a .openqodex/latest.json in the checkout that links to an endless file", () => {
    const dir = baseline();
    mkdirSync(join(dir, ".openqodex"));
    symlinkSync("/dev/zero", join(dir, ".openqodex/latest.json"));
    writeFileSync(join(dir, "app/added.py"), "def added():\n    return 1\n");
    const push = run("hook-links-checkout-latest", dir, ["hook", "pre-push"], { input: "", timeout: BOUNDED });
    expect(push.status).toBe(0);
  });
});
