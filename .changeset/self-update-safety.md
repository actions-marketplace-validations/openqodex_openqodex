---
"openqodex": minor
---

`init` lets Claude Code run the review commands the skill names (`review`, `scan`, `doctor`, `guide`, `hook check`) without a permission prompt, so a review can run unattended; `trust`, `update`, `init` and `report` still ask. `init --uninstall` removes exactly the rules it added.
The skill `init` writes in project scope keeps the committed `npx -y openqodex@<version>` commands and no longer tells an agent to prefer the launcher.
`init` skips the team review section for a `CLAUDE.md` or `AGENTS.md` the repository's git ignore rules hide, and says why.
`init --uninstall` removes the update state, and `~/.openqodex/config.yaml` when `openqodex update` created it and it is unchanged.
`openqodex update --rollback` turns updates off before anything else and changes nothing when it cannot.
