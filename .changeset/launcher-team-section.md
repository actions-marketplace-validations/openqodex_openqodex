---
"openqodex": minor
---

`init` inside a repository adds a short review section to the repository's `CLAUDE.md` and `AGENTS.md`, so a teammate's agent reviews before pushing with nothing installed; the files show in `git status` to be committed. `--no-repo` skips it, and `--uninstall` removes exactly that section.
Every user-scope install gets the launcher in `~/.openqodex/bin/`, even for Cursor or Cline alone, and the installed skill's commands call it instead of `npx -y openqodex@<version>`.
The launcher runs the version named in `~/.openqodex/runtime/current`, and the version `init` installed when that file is missing, malformed or names a copy that is gone.
The skill installed with `npx skills add` uses `~/.openqodex/bin/openqodex` when it exists.
