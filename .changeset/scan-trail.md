---
"openqodex": minor
---

- `scan.json` records which scanners the change called for and why, under `selection`, and what became of every finding a scanner raised, under `trail`: one entry per finding with its rule, file, lines, severity and the step that dropped it (outside the change, not on a changed line, a fixture file, a disabled rule, merged into another candidate) or the candidate it became. An entry never holds the finding's message.
- Each scanner's entry in `scan.json` and `report.json` also says how many of its findings each step dropped (`stages`), how long its tool took to find or install (`resolveMs`) and how many changed files it was handed (`files`).
- Nothing is printed, and nothing that read these files before needs to change: the fields are new and every other field is as it was.
