---
"openqodex": minor
---

- `init` follows `CLAUDE_CONFIG_DIR` and `CODEX_HOME`: it finds Claude Code and Codex by those folders and writes the skill, the instructions and the push hook where each agent reads them, never half in the default folder.
- Inside Cursor's agent, `review` tries Cursor first among the reviewers, as it does for Claude Code and Codex, and `init` knows it runs inside an agent.
- `init` replaces a skill file that holds the skill exactly as some version shipped it, such as the copy `npx skills add` writes, with the skill it keeps up to date. Before, it kept that copy as yours and it never updated. A copy you edited is still left alone.
- `init` asks one question, "Write these files?", after a plan that lists every file under "For you, on this machine" or "For the team, in this repo". The git pre-push hook and the team review section are lines of that plan, on by default; `--hook none` and `--no-repo` leave them out. Before, it asked up to three questions.
- Inside Claude Code, Codex or Cursor with no terminal, `init` writes its plan without `--yes`. With no terminal and no agent it still exits 2, now after printing the plan and the flags that change it.
