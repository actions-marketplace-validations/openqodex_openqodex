---
"openqodex": minor
---

- The GitHub Action runs the full review on a pull request when the workflow sets `ANTHROPIC_API_KEY` on its step from a secret: the scanners, the code graph and a Claude Code reviewer, with the report in the job summary and the findings in code scanning. Without a key it runs the scanners only, as before, and says in one line how to turn the review on. Each review spends the repository's own API credit.
- The new Action input `review` takes `auto` (the review with a key, the default), `off` or `required`, which fails the job without a complete review. The new input `claude-code-version` pins the Claude Code the Action installs. The new outputs `reviewed`, `review-status` and `reviewer` say what ran.
- In a pull request the Action's review reads the custom instructions from the base branch, like the config, so a pull request cannot write its own. The reviewer's web tools are off in the Action, the key reaches the review command alone, and the review never runs on `pull_request_target`.
- When the Action's review does not complete, the job also runs the scanners, so an incomplete review never hides a scanner finding: the summary shows the partial review and then the scan, code scanning gets the scan's findings, and a blocking finding from either fails the job.
- `openqodex review` takes `--block-on-severity`, as `scan` does, `--instructions <file>` to read the owners' instructions from another file, and `--report-dir <folder>` to write this run's report files to a folder of your choice as well. `openqodex scan` takes `--report-dir` too.
