# Drop audit

50 dropped scanner candidates, drawn at random (seed 1) from 240. For each, read the reason and the place, then write whether the class is right; when it is not, write the right class.

Classes, first match wins: config-owned, fixture, test, duplicate, out-of-change, low-value, rule-fp.

Ruled by: Fable (delegated by Sid, 2026-10-11). Sid delegated this audit to the session's model on 2026-10-11. Each ruling was made from the planted case's file at the cited place, not from the reason text. A path that two planted cases share names both. This sheet is a check on the drop classifier; it is not an adjudication and it changes no score.

Where each place was read: internal/api/handler.go in go-http-handler; tests/test_money.py in clean-python-feature (the only case with that path); scripts/deploy.sh, Dockerfile, app/search.py and package-lock.json in demo-polyglot (examples/demo-repo/planted); infra/database.tf in terraform-open-ingress; tools/settings.py and tools/thumbs.py in suppression-comments; files/app.py in flask-path-traversal; app/controllers/users_controller.rb in rails-controller-model, read at commit 752b77f, the version whose line 15 holds the lookup the reason describes; .github/workflows/ci.yml in demo-polyglot at commit 752b77f, where line 15 holds the title injection (workflow-untrusted-checkout also holds this path, in its base only, and its line 15 is the checkout step, which no change touches).

## 1

- Rule: semgrep:go.lang.security.audit.database.string-formatted-query.string-formatted-query
- Place: internal/api/handler.go, line 34
- Cited line: internal/api/handler.go:34
- Reason: This hit flags the same formatted query that the c1 finding already covers.
- Class: duplicate, by names-candidate "c1"
- Ruling: right. Line 34 is the Sprintf query of the planted sprintf-sql item; the reviewer raised it as c1.

## 2

- Rule: bandit:B101
- Place: tests/test_money.py, line 22
- Cited line: tests/test_money.py:22
- Reason: This assert sits in a pytest test function. Pytest relies on plain asserts, and the test suite never runs optimised.
- Class: test, by test-path "tests/test_money.py"
- Ruling: right. Line 22 is an assert inside a pytest test function of the clean case.

## 3

- Rule: shellcheck:SC2086
- Place: scripts/deploy.sh, line 7
- Cited line: scripts/deploy.sh:7
- Reason: This hit duplicates the unguarded delete finding on the same line.
- Class: duplicate, by duplicate-words "duplicates"
- Ruling: right. Line 7 is rm -rf on the unquoted variable, the planted shell-rm-unquoted item, which the reviewer raised.

## 4

- Rule: checkov:CKV_AWS_118
- Place: infra/database.tf, line 6
- Cited line: infra/database.tf:6
- Reason: Enhanced monitoring is optional observability. Its absence is not a defect.
- Class: rule-fp, by fall-through
- Ruling: right. The resource has no monitoring_interval; the reviewer says that is not a defect, so the rule is what the drop points at.

## 5

- Rule: checkov:CKV_AWS_157
- Place: infra/database.tf, line 6
- Cited line: infra/database.tf:6
- Reason: Multi-AZ is a cost and availability choice for each environment. A single-AZ instance is valid here.
- Class: rule-fp, by fall-through
- Ruling: right. Same resource, same kind of hardening check with no defect claimed.

## 6

- Rule: osv-scanner:GHSA-29mw-wpgm-hmr9
- Place: package-lock.json, line 11
- Cited line: package-lock.json:11
- Reason: The lodash downgrade is already raised as one finding that covers this advisory.
- Class: duplicate, by duplicate-words "already raised"
- Ruling: right. Line 11 is the lodash 4.17.15 entry of the planted vulnerable-lodash item; one downgrade, several advisories.

## 7

- Rule: semgrep:go.lang.security.audit.database.string-formatted-query.string-formatted-query
- Place: internal/api/handler.go, line 34
- Cited line: internal/api/handler.go:34
- Reason: This hit flags the same formatted query that the c1 finding already raises. Raising it again would report one problem twice.
- Class: duplicate, by names-candidate "c1"
- Ruling: right. As item 1.

## 8

- Rule: ruff:openqodex.suppression-added
- Place: tools/settings.py, line 4
- Cited line: tools/settings.py:4
- Reason: The noqa only allows a long documentation URL string. It hides no logic.
- Class: config-owned, by config-rule "openqodex.suppression-added"
- Ruling: right. Line 4 is a URL constant with noqa: E501; the candidate is the scan's own suppression candidate.

## 9

- Rule: hadolint:DL3008
- Place: Dockerfile, line 3
- Cited line: Dockerfile:3
- Reason: Pinning apt package versions is a style preference and causes no concrete bug here.
- Class: low-value, by low-value-words "style"
- Ruling: right. Line 3 installs curl unpinned, part of the planted docker-apt-install item; the reviewer dropped a true hit as low value, which points at the severity.

## 10

- Rule: checkov:CKV2_AWS_30
- Place: infra/database.tf, line 8
- Cited line: infra/database.tf:8
- Reason: Query logging needs a custom parameter group and is an optional audit choice. Its absence is not a bug.
- Class: rule-fp, by fall-through
- Ruling: right. As item 4.

## 11

- Rule: semgrep:python.django.security.injection.tainted-sql-string.tainted-sql-string
- Place: app/search.py, line 14
- Cited line: app/search.py:14
- Reason: This hit duplicates the SQL injection finding on the same line. The app uses Flask, not Django.
- Class: duplicate (framework-mismatch), by duplicate-words "duplicates"
- Ruling: right. Line 14 is the f-string execute of the planted sql-injection item, which the reviewer raised; the file imports flask.

## 12

- Rule: hadolint:DL3008
- Place: Dockerfile, line 3
- Cited line: Dockerfile:3
- Reason: An unpinned curl version is a style preference with no concrete failure here.
- Class: low-value, by low-value-words "style"
- Ruling: right. As item 9.

## 13

- Rule: bandit:B608
- Place: app/search.py, line 14
- Cited line: app/search.py:14
- Reason: The same injection is raised under c5.
- Class: duplicate, by names-candidate "c5"
- Ruling: right. As item 11.

## 14

- Rule: osv-scanner:GHSA-29mw-wpgm-hmr9
- Place: package-lock.json, line 11
- Cited line: package-lock.json:11
- Reason: This is the same lodash downgrade already raised as one finding.
- Class: duplicate, by duplicate-words "already raised"
- Ruling: right. As item 6.

## 15

- Rule: semgrep:python.django.security.injection.sql.sql-injection-using-db-cursor-execute.sql-injection-db-cursor-execute
- Place: app/search.py, lines 10 to 14
- Cited line: app/search.py:14
- Reason: This duplicates the injection finding raised for the execute call on line 14.
- Class: duplicate, by duplicate-words "duplicates"
- Ruling: right. Lines 10 to 14 run from the query string read to the execute call of the same planted item.

## 16

- Rule: semgrep:python.django.security.injection.tainted-sql-string.tainted-sql-string
- Place: app/search.py, line 14
- Cited line: app/search.py:3
- Reason: The app is Flask, not Django, and the same injection is already raised.
- Class: duplicate (framework-mismatch), by duplicate-words "already raised"
- Ruling: right. Line 3 is the flask import the reason cites as proof; the injection on line 14 was raised.

## 17

- Rule: hadolint:DL3015
- Place: Dockerfile, line 3
- Cited line: Dockerfile:3
- Reason: Extra recommended packages only add image size and cause no bug.
- Class: low-value, by low-value-words "size"
- Ruling: right. Line 3 lacks --no-install-recommends, part of the planted item; dropped as low value.

## 18

- Rule: osv-scanner:GHSA-p6mc-m468-83gw
- Place: package-lock.json, line 11
- Cited line: package-lock.json:11
- Reason: The lodash downgrade is raised once under c6.
- Class: duplicate, by names-candidate "c6"
- Ruling: right. As item 6.

## 19

- Rule: osv-scanner:GHSA-f23m-r3pf-42rh
- Place: package-lock.json, line 11
- Cited line: package-lock.json:11
- Reason: This is the same lodash downgrade already raised as one finding.
- Class: duplicate, by duplicate-words "already raised"
- Ruling: right. As item 6.

## 20

- Rule: semgrep:python.django.security.injection.tainted-sql-string.tainted-sql-string
- Place: app/search.py, line 14
- Cited line: app/search.py:14
- Reason: This repeats the search injection already raised under c5. The app uses Flask, not Django.
- Class: duplicate (framework-mismatch), by names-candidate "c5"
- Ruling: right. As item 11.

## 21

- Rule: osv-scanner:GHSA-p6mc-m468-83gw
- Place: package-lock.json, line 11
- Cited line: package-lock.json:11
- Reason: This is covered by the single lodash downgrade finding.
- Class: duplicate, by duplicate-words "covered by"
- Ruling: right. As item 6.

## 22

- Rule: hadolint:DL3009
- Place: Dockerfile, line 3
- Cited line: Dockerfile:3
- Reason: Leftover apt lists only affect image size.
- Class: low-value, by low-value-words "size"
- Ruling: right. Line 3 never removes the package lists, part of the planted item; dropped as low value.

## 23

- Rule: semgrep:python.django.security.injection.tainted-sql-string.tainted-sql-string
- Place: app/search.py, line 14
- Cited line: app/search.py:14
- Reason: The same injection is raised under c5.
- Class: duplicate, by names-candidate "c5"
- Ruling: right. As item 11.

## 24

- Rule: osv-scanner:GHSA-p6mc-m468-83gw
- Place: package-lock.json, line 11
- Cited line: package-lock.json:11
- Reason: The single lodash downgrade finding already covers this advisory.
- Class: duplicate, by duplicate-words "covers"
- Ruling: right. As item 6.

## 25

- Rule: semgrep:go.lang.security.audit.database.string-formatted-query.string-formatted-query
- Place: internal/api/handler.go, line 34
- Cited line: internal/api/handler.go:34
- Reason: This flags the same formatted query as c1. The c1 finding already covers that problem.
- Class: duplicate, by names-candidate "c1"
- Ruling: right. As item 1.

## 26

- Rule: osv-scanner:GHSA-29mw-wpgm-hmr9
- Place: package-lock.json, line 11
- Cited line: package-lock.json:11
- Reason: The c7 finding covers the lodash downgrade, which causes all these advisories.
- Class: duplicate, by names-candidate "c7"
- Ruling: right. As item 6.

## 27

- Rule: hadolint:DL3008
- Place: Dockerfile, line 3
- Cited line: Dockerfile:3
- Reason: Unpinned apt packages are image hygiene with no concrete failure in this change.
- Class: low-value, by low-value-words "hygiene"
- Ruling: right. As item 9.

## 28

- Rule: semgrep:python.lang.security.audit.formatted-sql-query.formatted-sql-query
- Place: app/search.py, line 14
- Cited line: app/search.py:14
- Reason: This duplicates the injection finding already raised for this line.
- Class: duplicate, by duplicate-words "duplicates"
- Ruling: right. As item 11.

## 29

- Rule: ruff:openqodex.suppression-added
- Place: tools/settings.py, line 4
- Cited line: tools/settings.py:4
- Reason: The noqa E501 comment only allows one long documentation URL constant. It hides no logic problem.
- Class: config-owned, by config-rule "openqodex.suppression-added"
- Ruling: right. As item 8.

## 30

- Rule: semgrep:python.flask.security.audit.app-run-param-config.avoid_app_run_with_bad_host
- Place: files/app.py, line 24
- Cited line: files/app.py:24
- Reason: The finding raised for c1 already covers the all-interfaces bind on this line. On its own, binding to 0.0.0.0 is a common deployment choice.
- Class: duplicate, by names-candidate "c1"
- Ruling: right. Line 24 is app.run on 0.0.0.0 with debug on, the planted debug-on-all-interfaces item, raised as c1.

## 31

- Rule: osv-scanner:GHSA-35jh-r3h4-6jhm
- Place: package-lock.json, line 11
- Cited line: package-lock.json:11
- Reason: The c7 finding covers the lodash downgrade, which causes all these advisories.
- Class: duplicate, by names-candidate "c7"
- Ruling: right. As item 6.

## 32

- Rule: bandit:B101
- Place: tests/test_money.py, line 21
- Cited line: tests/test_money.py:21
- Reason: Pytest test functions are meant to use plain assert statements. This test code never runs with optimisation enabled.
- Class: test, by test-path "tests/test_money.py"
- Ruling: right. As item 2.

## 33

- Rule: bandit:B404
- Place: tools/thumbs.py, line 1
- Cited line: tools/thumbs.py:1
- Reason: Importing subprocess is not a problem by itself. The unsafe call is reported separately on line 9.
- Class: rule-fp, by fall-through
- Ruling: right. Line 1 is the import; the planted nosec-shell-injection item sits on lines 8 to 9. The reason denies the rule's own claim, so the rule is what the drop points at, not dedup.

## 34

- Rule: bandit:B101
- Place: tests/test_money.py, line 23
- Cited line: tests/test_money.py:23
- Reason: This assert sits in a pytest test function. Pytest relies on plain asserts, and the test suite never runs optimised.
- Class: test, by test-path "tests/test_money.py"
- Ruling: right. As item 2.

## 35

- Rule: semgrep:python.django.security.injection.sql.sql-injection-using-db-cursor-execute.sql-injection-db-cursor-execute
- Place: app/search.py, lines 10 to 14
- Cited line: app/search.py:10
- Reason: This repeats the search injection already raised under c5.
- Class: duplicate, by names-candidate "c5"
- Ruling: right. As item 15.

## 36

- Rule: bandit:B101
- Place: tests/test_money.py, line 28
- Cited line: tests/test_money.py:28
- Reason: Pytest test functions are meant to use plain assert statements. This test code never runs with optimisation enabled.
- Class: test, by test-path "tests/test_money.py"
- Ruling: right. As item 2.

## 37

- Rule: hadolint:DL3020
- Place: Dockerfile, line 6
- Cited line: Dockerfile:6
- Reason: ADD of a local file behaves the same as COPY here, so this is style only.
- Class: low-value, by low-value-words "style"
- Ruling: right. Line 6 is ADD requirements.txt, the planted docker-add item; the rule is right and the reviewer dropped it as low value.

## 38

- Rule: hadolint:DL3020
- Place: Dockerfile, line 6
- Cited line: Dockerfile:6
- Reason: ADD of a local file behaves exactly like COPY here.
- Class: rule-fp, by fall-through
- Ruling: wrong; the right class is low-value. The rule's claim holds (line 6 uses ADD for a local file, the planted docker-add item); the reviewer only says the consequence is nil, the same reasoning as items 37 and 39, so the drop points at the severity, not at the rule. The words list has no entry for "behaves exactly like" or "same as", so the classifier fell through.

## 39

- Rule: hadolint:DL3020
- Place: Dockerfile, line 6
- Cited line: Dockerfile:6
- Reason: ADD on a local file behaves the same as COPY here, so this is only style.
- Class: low-value, by low-value-words "style"
- Ruling: right. As item 37.

## 40

- Rule: semgrep:python.lang.security.audit.formatted-sql-query.formatted-sql-query
- Place: app/search.py, line 14
- Cited line: app/search.py:14
- Reason: This repeats the search query injection finding on the same line.
- Class: duplicate, by duplicate-words "repeats"
- Ruling: right. As item 11.

## 41

- Rule: bandit:B101
- Place: tests/test_money.py, line 22
- Cited line: tests/test_money.py:22
- Reason: Pytest test functions use plain assert by design. The tests never run under optimised byte code.
- Class: test, by test-path "tests/test_money.py"
- Ruling: right. As item 2.

## 42

- Rule: hadolint:DL3014
- Place: Dockerfile, line 3
- Cited line: Dockerfile:3
- Reason: The full python image already ships curl, so the install normally needs no prompt.
- Class: rule-fp, by fall-through
- Ruling: right. Line 3 runs apt-get install without -y; the reviewer denies that the rule's failure (a prompt) can happen here, which is a claim against the rule, so rule-fp is the class even though the planted item says otherwise.

## 43

- Rule: osv-scanner:GHSA-f23m-r3pf-42rh
- Place: package-lock.json, line 11
- Cited line: package-lock.json:11
- Reason: The lodash downgrade is already raised as one finding that covers this advisory.
- Class: duplicate, by duplicate-words "already raised"
- Ruling: right. As item 6.

## 44

- Rule: bandit:B101
- Place: tests/test_money.py, line 28
- Cited line: tests/test_money.py:28
- Reason: This assert is in a pytest test function, where assert is the intended way to check results. Tests never run under optimised byte code.
- Class: test, by test-path "tests/test_money.py"
- Ruling: right. As item 2.

## 45

- Rule: semgrep:ruby.rails.security.brakeman.check-unscoped-find.check-unscoped-find
- Place: app/controllers/users_controller.rb, line 15
- Cited line: app/controllers/users_controller.rb:2
- Reason: The update action stays behind require_admin, so only admins reach this lookup. An admin may update any user by design.
- Class: rule-fp, by fall-through
- Ruling: right. In the version at commit 752b77f, line 15 is User.find(params[:id]) inside update, and line 2 keeps update behind require_admin (the except list is index, show, destroy). An admin looking up any user is by design, so the rule misfired. The current version has no lookup on line 15 (update became profile), which is how the version was identified.

## 46

- Rule: bandit:B101
- Place: tests/test_money.py, line 28
- Cited line: tests/test_money.py:28
- Reason: Pytest test functions use plain assert by design. The tests never run under optimised byte code.
- Class: test, by test-path "tests/test_money.py"
- Ruling: right. As item 2.

## 47

- Rule: semgrep:yaml.github-actions.security.run-shell-injection.run-shell-injection
- Place: .github/workflows/ci.yml, line 15
- Cited line: .github/workflows/ci.yml:15
- Reason: This repeats the pull request title injection already raised from the other candidate on the same line.
- Class: duplicate, by duplicate-words "repeats"
- Ruling: right. In demo-polyglot at commit 752b77f, line 15 is the run step that echoes the pull request title, the planted workflow-injection item, which actionlint and zizmor also report; the reviewer raised one. workflow-untrusted-checkout shares the path in its base only, with no injection on line 15.

## 48

- Rule: hadolint:DL3008
- Place: Dockerfile, line 3
- Cited line: Dockerfile:3
- Reason: An unpinned curl package is image hygiene with no realistic runtime impact.
- Class: low-value, by low-value-words "hygiene"
- Ruling: right. As item 9.

## 49

- Rule: bandit:B101
- Place: tests/test_money.py, line 24
- Cited line: tests/test_money.py:24
- Reason: This assert is in a pytest test function, where plain asserts are the normal way to check results. The test code does not run under optimised byte code in production.
- Class: test, by test-path "tests/test_money.py"
- Ruling: right. As item 2.

## 50

- Rule: semgrep:go.lang.security.audit.database.string-formatted-query.string-formatted-query
- Place: internal/api/handler.go, line 34
- Cited line: internal/api/handler.go:34
- Reason: This hit flags the same Sprintf query that the c1 finding already raises.
- Class: duplicate, by names-candidate "c1"
- Ruling: right. As item 1.

## Totals

Agreed 49 of 50. The classifier passes (43 or more).

Disagreements: item 38, rule-fp ruled low-value.

Seen and not changed: three drops with one reasoning (items 37, 38 and 39) get two classes because only two of them use a word on the low-value list. A phrase such as "behaves the same as" or "behaves exactly like" on that list would make them one class. lib/drops.mjs has no scorer for a completed sheet, so this total was counted by hand.
