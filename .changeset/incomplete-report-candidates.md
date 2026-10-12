---
"openqodex": patch
---

- A review that stops before any answer passes the checks, such as one stopped at its time cap, now lists every scanner candidate no reviewer checked: in the receipt, `report.md`, `report.json` (`not_reviewed`) and `report.sarif`, each with its file, line, rule, scanner and message. Before, these reports held no scanner result at all. The review is still incomplete and exits 2.
