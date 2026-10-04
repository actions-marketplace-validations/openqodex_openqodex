---
"openqodex": patch
---

- The terminal report no longer prints a line reading only "agent" under a finding the reviewing agent raised from its own reading; a scanner finding the agent verified still names its scanner.
- The line `hook install` prints for husky, lefthook or a pre-push hook of your own now passes git's hook arguments (`"$@"`, or `'{1}' '{2}'` for lefthook), so a push to a remote other than origin is checked against that remote.
