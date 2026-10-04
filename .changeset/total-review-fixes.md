---
"openqodex": minor
---

- The GitHub Action reads a pull request's OpenQodex config from its base commit, so the pull request cannot hide findings through its own config. The new input `config-from: head` reads the pull request's config instead.
- The GitHub Action handles a failed scanner install like a failed scan: a warning and `status: tool-failed`, and a failed job only with `fail-on-tool-error: true`. An incomplete review in SARIF is now a failed run that names what is missing.
- The push hooks check each range a push sends against the commit the remote holds, so a force push over work the review never saw is not covered by it. The agent hook reads the branches the push command names; a push it cannot follow (such as `--mirror` or a URL remote) counts as unreviewed.
- A review stops before the reviewer starts when a file name holds a secret the scanners found, and the reviewer's trace is redacted like the report.
- A review counts a changed file that was too large to map or brief as unread until the reviewer reads it.
- A finding must start on a changed line and end within the file and 200 lines.
- Ctrl-C during a review stops the reviewer and its children and removes the snapshot.
- The review `init` ends with now reviews your own earlier edits to files init writes, such as CLAUDE.md, without init's own section.
- A review from the older two-step protocol counts for the push hooks only when this machine ran its scan.
