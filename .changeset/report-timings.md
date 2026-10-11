---
"openqodex": minor
---

- `report.json` says how long each phase of the run took, in milliseconds, under `timings`. A review records `change_ms`, `scan_ms`, `graph_ms`, `brief_ms`, `reviewer_ms` and `finalize_ms`, and `total_ms`, the time from the start of the command to the report, read from the clock. A scan records `change_ms`, `scan_ms` and `total_ms`. `scan_ms` is the scanner stage as a whole, so it is never less than the slowest scanner's time.
- The library's `reviewChange` result carries the same `timings`, from the call to the result, and the library exports their type, `RunTimings`.
- Nothing that read `report.json` before needs to change: the field is new and every other field is as it was.
