---
"openqodex": minor
---

semgrep's entry in `report.json` and `scan.json` now lists the registry rule packs the scan used, each with the sha256 of its rules and the size of the bytes semgrep read, so two scans that used different rules show it, and two that used the same rules match even when the registry sends them in another order or as YAML.
