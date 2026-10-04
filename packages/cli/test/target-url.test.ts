// Which remote a GitHub pull request link belongs to. Ways it could fail,
// written before the code:
//  1. A host that only contains "github.com" (notgithub.com, github.com.evil.io,
//     a path or a user part holding it) is taken for GitHub.
//  2. The same repository name under another owner is taken for the link's.
//  3. One of the remote forms git accepts for GitHub (https with or without
//     .git, ssh scp-like, ssh:// with a port) is not recognised.
import { describe, expect, it } from "vitest";
import { githubRepoOf } from "../src/target.js";

describe("githubRepoOf", () => {
  it("reads the forms git accepts for a GitHub remote (failure 3)", () => {
    for (const url of [
      "https://github.com/Acme/Widget.git",
      "https://github.com/acme/widget",
      "https://user@github.com/acme/widget.git/",
      "git@github.com:acme/widget.git",
      "ssh://git@github.com/acme/widget.git",
      "ssh://git@github.com:22/acme/widget",
    ]) {
      expect(githubRepoOf(url), url).toBe("acme/widget");
    }
  });
  it("refuses a host that only contains github.com (failure 1)", () => {
    for (const url of [
      "https://notgithub.com/acme/widget.git",
      "https://github.com.evil.io/acme/widget.git",
      "https://evil.io/github.com/acme/widget.git",
      "https://github.com@evil.io/acme/widget.git",
      "git@evil.io:github.com/acme/widget.git",
      "ssh://git@notgithub.com/acme/widget.git",
      "/srv/git/github.com/acme/widget.git",
    ]) {
      expect(githubRepoOf(url), url).toBeNull();
    }
  });
  it("keeps the owner, so another owner's repository of the same name does not match (failure 2)", () => {
    expect(githubRepoOf("https://github.com/other/widget.git")).toBe("other/widget");
    expect(githubRepoOf("https://github.com/acme/widget/extra")).toBeNull();
  });
});
