---
"openqodex": minor
---

- `openqodex review` now does the whole review in one run: it copies your change into a temporary snapshot, runs the scanners and the code graph on it, starts Claude Code as a separate reviewer that can only read the snapshot, checks the answer with a script and prints one report. Each finding says where, the problem, why it matters and the fix, and the report ends with which reviewer ran, how long it took and what it used.
- A review is complete only when every scanner candidate was raised or dropped with a reason and every changed range was given to the reviewer. Otherwise the report says what is missing and the command exits 2.
- With no reviewer installed and logged in, `review` prints "Full review unavailable", says what is missing, saves the unchecked scanner candidates to a file and exits 2. It never shows scanner output as a review.
- New flags: `--reviewer auto|claude` and `--timeout <seconds>` (600 by default).
- `review --agent` and `review --finalize` still work for older skills; a review finished that way is recorded as a legacy review.
