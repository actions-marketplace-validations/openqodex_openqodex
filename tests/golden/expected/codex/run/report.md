# Passed with warnings: 28 findings \(12 major, 16 minor\)

Change 597352237e51 against HEAD, 11 files, +45 -16

Summary: Reviewed the fixed planted change.

Blast radius: risk low \(2 symbols touched, 0 callers in 0 files\)

Counts: 28 findings \(12 major, 16 minor\), 0 scanner candidates dropped, 7 below the severity threshold

## Findings \(28\)

### 1. Major bug: Planted problem number 1

- **Where:** .github/workflows/ci.yml:17
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** semgrep:yaml.github-actions.security.run-shell-injection.run-shell-injection

### 2. Major bug: Planted problem number 2

- **Where:** app/config.py:2
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** semgrep:generic.secrets.security.detected-stripe-api-key.detected-stripe-api-key

### 3. Major bug: Planted problem number 3

- **Where:** app/search.py:14
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** semgrep:python.sqlalchemy.security.sqlalchemy-execute-raw-query.sqlalchemy-execute-raw-query

### 4. Major bug: Planted problem number 4

- **Where:** app/search.py:14
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** semgrep:python.django.security.injection.tainted-sql-string.tainted-sql-string

### 5. Major bug: Planted problem number 5

- **Where:** app/search.py:14
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** semgrep:python.flask.security.injection.tainted-sql-string.tainted-sql-string

### 6. Major bug: Planted problem number 6

- **Where:** package-lock.json:11
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** osv-scanner:GHSA-35jh-r3h4-6jhm

### 7. Major bug: Planted problem number 7

- **Where:** package-lock.json:11
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** osv-scanner:GHSA-p6mc-m468-83gw

### 8. Major bug: Planted problem number 8

- **Where:** Dockerfile:6
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** hadolint:DL3020

### 9. Major bug: Planted problem number 9

- **Where:** infra/main.tf:28
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** trivy:AWS-0107

### 10. Major bug: Planted problem number 10

- **Where:** deploy/deployment.yaml:43
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** kube-linter:privilege-escalation-container

### 11. Major bug: Planted problem number 11

- **Where:** deploy/deployment.yaml:42
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** kube-linter:privileged-container

### 12. Major bug: Planted problem number 12

- **Where:** scripts/deploy.sh:11
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** shellcheck:SC2045

### 13. Minor bug: Planted problem number 13

- **Where:** app/search.py:10-14
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** semgrep:python.django.security.injection.sql.sql-injection-using-db-cursor-execute.sql-injection-db-cursor-execute

### 14. Minor bug: Planted problem number 14

- **Where:** app/search.py:14
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** semgrep:python.lang.security.audit.formatted-sql-query.formatted-sql-query

### 15. Minor bug: Planted problem number 15

- **Where:** deploy/deployment.yaml:42
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** semgrep:yaml.kubernetes.security.privileged-container.privileged-container

### 16. Minor bug: Planted problem number 16

- **Where:** deploy/deployment.yaml:43
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** semgrep:yaml.kubernetes.security.allow-privilege-escalation-true.allow-privilege-escalation-true

### 17. Minor bug: Planted problem number 17

- **Where:** db/migrations/002\_index\_item\_names.sql:2
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** squawk:require-concurrent-index-creation

### 18. Minor bug: Planted problem number 18

- **Where:** package-lock.json:11
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** osv-scanner:GHSA-29mw-wpgm-hmr9

### 19. Minor bug: Planted problem number 19

- **Where:** package-lock.json:11
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** osv-scanner:GHSA-f23m-r3pf-42rh

### 20. Minor bug: Planted problem number 20

- **Where:** Dockerfile:1
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** hadolint:DL3007

### 21. Minor bug: Planted problem number 21

- **Where:** Dockerfile:3
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** hadolint:DL3008

### 22. Minor bug: Planted problem number 22

- **Where:** Dockerfile:3
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** hadolint:DL3014

### 23. Minor bug: Planted problem number 23

- **Where:** Dockerfile:7
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** hadolint:DL3042

### 24. Minor bug: Planted problem number 24

- **Where:** infra/main.tf:28
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** checkov:CKV\_AWS\_24

### 25. Minor bug: Planted problem number 25

- **Where:** deploy/deployment.yaml:43
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** checkov:CKV\_K8S\_20

### 26. Minor bug: Planted problem number 26

- **Where:** deploy/deployment.yaml:42
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** checkov:CKV\_K8S\_16

### 27. Minor bug: Planted problem number 27

- **Where:** scripts/deploy.sh:7
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** shellcheck:SC2115

### 28. Minor bug: Planted problem number 28

- **Where:** app/search.py:14
- **Problem:** This changed line introduces an unsafe operation.
- **Why it matters:** The affected behavior can fail when this path runs.
- **Fix:** Correct the flagged operation before using this change.
- **Source:** bandit:B608

## Coverage

- **Files the reviewer opened:** not recorded by Codex
- **Reads outside the snapshot:** not recorded by Codex
- **Changed ranges given to the reviewer:** 18 of 18
Scanners: 17 scanners ran, 5 had nothing to check

Reviewer: codex 0.160.0, <SECONDS> s, 1 turn, 1,000 tokens in, 500 out

Made by Qodex: review on every pull request at https://qodex.ai
