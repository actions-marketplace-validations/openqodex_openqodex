---
"openqodex": patch
---

- The terminal report no longer prints a line reading only "agent" under a finding the reviewing agent raised from its own reading; a scanner finding the agent verified still names its scanner.
- The line `hook install` prints for husky or a pre-push hook of your own now passes git's hook arguments (`"$@"`), so a push to a remote other than origin is checked against that remote. The lefthook line passes none, because lefthook would put a remote URL into the command as raw shell text; with lefthook a push is still checked against origin.
- `docs/security.md` now lists the problem report among the network uses: what the issue holds, and that it is sent only when you choose it.
- The skill now says that two scanners go online: semgrep downloads its rule packs, and osv-scanner sends dependency names and versions to osv.dev. `--offline` skips both.
- A brief written by a local build of OpenQodex (run with `node <path>/dist/bin.js`) now names that same node and file in its finalize command, and in the fallback line when no reviewer can start, instead of `npx -y openqodex@<version>`. A run through npx or the launcher is unchanged.
- `init` and the first scan or review no longer tell you to commit a file that git ignores in your repository; they say it is ignored and not shared with your team.
