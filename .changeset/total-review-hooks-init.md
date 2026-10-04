---
"openqodex": minor
---

- `--reviewer` now takes `auto`, `claude`, `codex` or `cursor`, and `reviewer:` in `~/.openqodex/config.yaml` sets it for every review. Only Claude Code is enabled as a reviewer: Codex and Cursor say why they are not and the review exits 2.
- `reviewer_web: on` in `~/.openqodex/config.yaml` gives the reviewer Claude Code's web tools. It is off by default.
- `init` now ends with a review of your change, or asks what to review when there is none (the whole repository, a pull request, a branch, or not now). Without a terminal it prints the three commands. `--no-review` skips it, and a review that cannot run never fails `init`.
- The push hooks now look up the review of exactly what is pushed. A complete passing review is silent, a missing one asks for `openqodex review`, an incomplete one never blocks, and a review from the older two-step protocol counts, with a line naming who reviewed.
- The push hooks trust only the review record in your own `~/.openqodex/receipts/`, never report files a branch carries under `.openqodex/`. `init` and `update` remove records older than 30 days.
- The git pre-push hook no longer scans or prints scanner findings.
- The GitHub Action says first that it runs the scanners only. A tool failure (exit 2) no longer fails the job: it shows a warning annotation and a job summary line, and sets the new `status` output to `tool-failed`. The new input `fail-on-tool-error: true` fails the job instead, and the new input `block-on-severity` sets a gate that the pull request's own config cannot weaken.
- `scan --block-on-severity <severity>` wins over the config's `review.block_on_severity`.
- The skill, the agent rules and the team section now give the agent one command, `review`, and tell it to show the report exactly as printed. Claude Code is allowed to run `review` and `review --all` without asking; the older `review --agent` and `review --finalize` rules are removed.
- Progress shows one line for the scanner stage, such as "Scanners: 6 ran, 5 had nothing to check, 14 candidates to check", instead of a line per scanner.
