---
"openqodex": minor
---

- The GitHub Action reads a pull request's OpenQodex config from its base branch, so the pull request cannot hide findings through its own config; when the base cannot be read it uses the built-in defaults, never the pull request's file. The new input `config-from: head` reads the pull request's config instead. A wrong `config-from` or `block-on-severity` value now fails the step.
- The GitHub Action handles a failed scanner install like a failed scan: a warning and `status: tool-failed`, and a failed job only with `fail-on-tool-error: true`. An incomplete review in SARIF is now a failed run that names what is missing.
- The push hooks check each range a push sends against the commit the remote holds, so a force push over work the review never saw is not covered by it. The agent hook checks your current work for a plain `git push` and says it cannot tell for any other push command (a deny when `block_on_severity` is set); the git pre-push hook stays the check that sees the exact commits. A pre-push that sends nothing passes.
- A review stops before the reviewer starts when a file name holds a secret the scanners found, and the reviewer's trace is redacted like the report.
- A review counts a changed file that was too large to map or brief as unread until the reviewer reads it.
- A finding must start on a changed line and end within the file and 200 lines.
- Ctrl-C during a review stops the reviewer and its children and removes the snapshot.
- The review `init` ends with now reviews your own earlier edits to files init writes, such as CLAUDE.md, without init's own section.
- A review from the older two-step protocol counts for the push hooks only when this machine ran its scan.
