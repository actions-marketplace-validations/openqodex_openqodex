---
"openqodex": minor
---

- Every correction round of a review is saved in `rounds.json` beside the report: the checks the earlier answer failed, that answer, and the changed line ranges the round sent. A finding a check rejected, and the next answer left out, now shows it was raised. `reviewChange` returns the same rounds as `result.rounds`.
