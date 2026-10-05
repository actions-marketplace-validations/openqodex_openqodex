---
"openqodex": minor
---

A suppression comment the change adds, such as `# nosec`, `# noqa`, `nosemgrep`, `gitleaks:allow`, `# shellcheck disable=`, `# hadolint ignore=`, `//nolint`, `# rubocop:disable` or `eslint-disable`, is now a candidate of the scanner it silences, rule `openqodex.suppression-added`. The reviewer keeps or drops it. The same text inside a string does not count, except for semgrep and gitleaks, which obey it anywhere on the line. `scanners` lists every comment and where it counts.

`scan`, the pre-commit hook and the GitHub Action now count an added suppression comment and a changed scanner settings or ignore file as a minor finding, so `block_on_severity: minor` blocks on them. `review.severity_threshold` never hides them, and `--only` and `--skip` no longer leave out a changed settings file. The report no longer has a separate "This change edits a scanner settings file" list, and `report.json` no longer has `settings_changes`.

A scanner's finding on the same line no longer hides one of these candidates, for example semgrep's secret finding beside an added `gitleaks:allow`.
