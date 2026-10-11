---
"openqodex": minor
---

- A review now stops its reviewer after 30 minutes for a change, a branch or a pull request, and after 2 hours for the whole repository (`--all`), up from 10 minutes for both. `--timeout <seconds>` still sets any other cap.
- A review stopped at its cap says which cap it hit and how to raise it, on the terminal and in the report: `the reviewer timed out and was stopped at the 30 minute cap; pass --timeout <seconds> to allow more`.
- A `--timeout` above 2147483 seconds (about 24 days) is refused before anything runs. Such a value overflowed the timer, so the reviewer stopped as soon as it started.
