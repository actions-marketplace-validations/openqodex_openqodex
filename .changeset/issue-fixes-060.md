---
"openqodex": patch
---

- The terminal report no longer prints a line reading only "agent" under a finding the reviewing agent raised from its own reading; a scanner finding the agent verified still names its scanner.
- The line `hook install` prints for husky, lefthook or a pre-push hook of your own now passes git's hook arguments (`"$@"`, or `'{1}' '{2}'` for lefthook), so a push to a remote other than origin is checked against that remote.
- `docs/security.md` now lists the problem report among the network uses: what the issue holds, and that it is sent only when you choose it.
- The skill now says that two scanners go online: semgrep downloads its rule packs, and osv-scanner sends dependency names and versions to osv.dev. `--offline` skips both.
