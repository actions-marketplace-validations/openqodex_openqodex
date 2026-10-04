---
"openqodex": minor
---

- `openqodex review <branch>` and `openqodex review '#42'` (or a pull request link) review a branch or a pull request that is not your current work. OpenQodex fetches it, checks it out in a temporary folder without running anything from it, and reviews what it added since it left its base. Your own settings and approvals apply, never the target's.
- The base of a branch or pull request review comes from `--base`, the pull request's base when `gh` is installed, `review.default_base`, or the remote's default branch, and the output says which.
- `review --finalize --run <id>` finalizes one run by name; the brief of a branch or pull request review prints it.
- A change to a scanner's own settings or ignore file, such as `.gitleaksignore` or `ruff.toml`, is raised as a candidate the reviewer must clear, since it can hide that scanner's findings.
- A change that only deletes code can now carry a finding that counts: the lines next to a deletion count as changed, and the brief lists each deletion point (issue #22).
