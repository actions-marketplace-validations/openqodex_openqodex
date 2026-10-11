---
"openqodex": minor
---

- Every correction round of a review is saved in `rounds.json` beside the report: the checks the earlier answer failed, that answer, and the changed line ranges the round sent. A finding a check rejected, and the next answer left out, now shows it was raised. `reviewChange` returns the same rounds as `result.rounds`.
- A secret the scanners found that a reviewer's answer held as a JSON key, not a value, was saved as it was in `submission.json`. Run files now redact keys as well as values.
