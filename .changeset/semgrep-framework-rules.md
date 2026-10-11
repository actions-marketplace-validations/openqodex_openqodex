---
"openqodex": minor
---

semgrep's Django rules no longer reach the review from a Flask project, nor its Flask rules from a Django project, when no dependency file, settings file or the file itself names the other framework; whatever cannot be read or parsed keeps them, and `scan.json` records each one left out, why, and which files settled it.
