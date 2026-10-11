---
"openqodex": minor
---

- The library's `reviewChange` result carries the scan record as `result.scan`, the same object the command writes to `scan.json` (the candidates, each scanner's summary and rule packs, `selection` and `trail`), redacted like the report and without the secrets' fingerprints, and `result.timings` is always set, so a server host reads both from the result instead of a file.
