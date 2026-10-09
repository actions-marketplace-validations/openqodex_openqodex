# The review benchmark

This page is for contributors and for anyone who wants to check a claim about review quality. The benchmark measures how well `openqodex review` finds bugs that were planted on purpose, how often it reports something that is not there, and what each review costs in time and money. It lives in `benchmark/` in the repository; it is not part of the npm package.

A script runs it and a script scores it. No model decides what runs or how a review scores. A model may judge the wording of findings in a separate, optional pass, and that verdict never blocks anything.

## What it measures

Each case is a small git repository with a base commit and an uncommitted change, the same shape a developer has before a push. The change carries planted bugs, each with a file, a line range, a kind (`bug`, `security`, `performance`, `maintainability` or `style`), a severity and the scanner or the reasoning expected to find it. The benchmark runs the real built CLI on each case, with the real reviewer, with the code graph off and on, three times each.

From the saved reports it counts:

- Recall: planted bugs found, over planted bugs, overall and by severity. A bug found by two findings counts once.
- Precision: findings that are planted bugs, over findings. A second finding on a bug already found, a side issue the case lists as real but not planted, and a request for a test are left out.
- Clean controls: two cases have no bug. Any finding on them is false. A clean case passes only when its review completed with no finding; an incomplete or failed review fails it.
- Graph disclosure, for the cases that need the graph: whether the brief named the callers the change breaks, and whether it said what the graph could not see (a caller list that is a floor, a call it could not bind).
- Time per review (from the start of the CLI to its exit), reviewer turns, tokens and cost, as the report records them.

## How a finding is scored

A script matches each finding in `report.json` to its case. A finding matches a planted bug only when three things hold: its place (the same file and an overlapping line range), its kind (a category the bug lists) and its words (the finding names one of the bug's `mentions`, at the start of a word). Every plant and every accepted side issue lists its words; the scorer refuses a spec where one does not. The words are how a blast-radius bug is scored: the finding must sit on the changed line and name the caller that breaks.

The checks run in this order, and the first that holds decides:

1. Test gap: a finding of kind `maintainability` or `style` whose title asks for a test ("has no covering test", "lacks tests", "untested"). On a case with planted bugs it is true (the planted cases ship no tests), so it is counted apart and left out of precision, even when its lines span a planted bug. On a clean case, which ships its tests, it is false.
2. Accepted: a side issue the case lists as real but not planted, matched by place and words. It is left out of precision.
3. Hit: a planted bug, matched by place, kind and words. When two bugs share the lines, the one whose anchor line is nearest wins. A second hit on a bug already found in the same review is a duplicate: it is reported apart and never counted in precision.
4. Near miss or wrong kind: a hit in every way but the lines (within three lines of the range), or in every way but the kind. Neither is a hit; both count against precision. A near miss is listed so a spec that names the wrong line can be fixed.
5. False: anything else.

Each finding counts for one bug at most. A review that wrote no report misses every bug. A review the product marked incomplete is scored on the findings it holds and counted as incomplete.

## The cases

| Case | Language | Planted bugs (severity; expected finder) |
|---|---|---|
| `clean-python-feature` | Python | none (clean) |
| `clean-ts-refactor` | TypeScript | none (clean) |
| `demo-polyglot` | Python, Flask, Docker, shell, a workflow, npm | the demo repository's twelve: a secret (critical; gitleaks, semgrep), SQL injection (critical; bandit, semgrep), four Dockerfile issues (minor; hadolint), the container left running as root (major; reasoning), a vulnerable lodash (major; osv-scanner), two shell bugs (shellcheck), workflow script injection (major; actionlint, semgrep), a pagination off-by-one (major; reasoning) |
| `django-model-view` | Python, Django | a Decimal times a float (major), a field with no migration (major), an order readable by any user (critical), CSRF turned off on a POST (major); reasoning, semgrep for CSRF |
| `django-renamed-view` | Python, Django | a view renamed while the app's `urls.py`, outside the diff, still registers its old name, so loading the URLs fails (critical; reasoning, graph) |
| `express-admin-routes` | JavaScript, Express | a delete route without the admin check (critical), `forEach` with an async callback that is not awaited (major); reasoning |
| `express-route-param` | JavaScript, Express | a handler that now reads `req.params.userId` while its route, registered in another file outside the diff, declares `:id`, so every lookup answers 404 (major; reasoning, graph) |
| `flask-path-traversal` | Python, Flask | a download path built from a parameter (critical), the debug server on every interface (major); semgrep, bandit, reasoning |
| `go-http-handler` | Go | SQL built with `Sprintf` (critical; semgrep, golangci-lint), a mutex left locked on an early return (major), a deferred close before the error check (major) |
| `js-dynamic-dispatch-gap` | JavaScript | a handler made async while its caller, reached only through `table[action](id)`, uses the result as a string (major); the brief must say the graph could not bind that call |
| `nextjs-react-hooks` | TypeScript, Next.js | hooks after an early return (major), an effect with no dependency list (major), the query string put into the page as HTML (critical), list items without keys (minor) |
| `python-caller-break` | Python | a function that may now return `None`, with callers in another `src` package that add and divide its result (major; reasoning, graph) |
| `rails-controller-model` | Ruby, Rails | SQL built from params (critical), `destroy` left out of the admin check (critical), `permit!` (major), a welcome email on every save (major); brakeman, semgrep, reasoning |
| `suppression-comments` | Python, JavaScript | a shell injection hidden by `# nosec` (critical), an `eval` hidden by `eslint-disable` and `nosemgrep` (critical); a harmless `# noqa: E501` that must not be reported |
| `ts-interface-dispatch-break` | TypeScript | an implementation of a `Cache` interface whose `get` now throws where the interface promises an empty string, called only through the interface from two files among many other calls named `get` (major; reasoning, graph) |
| `ts-removed-export` | TypeScript | a renamed export still imported by a file outside the change (major; reasoning, graph); nothing in the diff shows it |
| `ts-workspace-caller-break` | TypeScript, pnpm workspace | `safeGit` changed from returning a string to returning an object, with callers in another package (major; reasoning, graph) |

Forty planted bugs in all: 13 critical, 21 major, 6 minor.

Each case is a folder under `benchmark/cases/<case>/`: `case.json` (the spec), `base/` (the base commit), `change/` (the files the change writes) and an optional `delete.txt`. `demo-polyglot` reads `examples/demo-repo` instead, and its secret is generated when the case is built, the same value every time, never committed. The repositories are built in a temporary folder; none is committed. `node benchmark/build.mjs <case>` builds one so you can read it.

## Run it

From a clone, with Node 22, Claude Code installed and logged in:

```
pnpm install
node benchmark/build-cli.mjs           # pnpm build, and a record of the commit and tree it built from
node benchmark/run.mjs --dry-run       # print the plan, run nothing
node benchmark/run.mjs                 # 17 cases, graph off and on, 3 repeats: 102 reviews
node benchmark/score.mjs benchmark/results/<date>-<commit>
```

The reviews run on your Claude Code account, at its usual cost. Useful flags of `run.mjs`: `--cases a,b`, `--graph off|on|off,on`, `--repeat N` (more than three needs `--allow-more`), `--reviewers claude,codex`, `--model <id>` (Claude Code only: it reaches the reviewer through `ANTHROPIC_MODEL`, and the run stops when Claude Code answers with another model; the Codex reviewer runs with `--ignore-user-config` and takes no model setting, so `--model` with Codex is refused), `--concurrency N` (default 1; parallel reviews slow each other), `--resume` (finish a stopped run).

`build-cli.mjs` records the commit, the tree the build read (every file the repository sees, staged or not, untracked included) and a hash of the bundle and its assets. `run.mjs` refuses a bundle with another hash, so a run never names a commit its bundle was not built from. "Dirty" in a run means the tree the bundle was built from differs from the commit's tree. The model each reviewer used is read from its own output: Claude Code names it in its answer, and Codex prints it in its header.

Each review runs as `openqodex review --report-dir <sample>/report --reviewer <name> --reviewer-web on --timeout 900`, with `--no-graph` for the graph-off configuration. `--report-dir` means built-in defaults and no custom instructions, so nothing on your machine shapes the review except the reviewer's login.

A run writes one folder, `benchmark/results/<date>-<commit>/`:

- `manifest.json`: the build and where it came from, the machine, every reviewer with its version and model, web access, the timeout, the concurrency, the plan, and how the first invocation ended. A resume never writes it.
- `resumes.jsonl`: one line when a resume starts and one when it ends.
- `cases/`: the specs the run used. The scorer reads these, so a later edit to a case never changes an old run's score.
- `samples/<case>/<configuration>/<n>/`: one attempt at one review: its own files (`report.json`, `brief.md`, `submission.json`, `trace.json`, `scan.json`), `receipt.txt` (what the review printed), `stderr.txt` and `sample.json` (exit code, time, usage, scanner versions). A second attempt of the same review goes to `<n>-attempt2/`.
- `rows.jsonl`: one line per attempt.
- `score.json`: written by `score.mjs`; `score-<folder>.json` when it scored against other specs with `--specs <folder>`.

Every attempt is saved as a sample before anything stops, and is scored: a review that failed, timed out or was stopped is a failure in the table, never a missing row. A reviewer failure gets one more attempt, in its own folder. The run stops at once when the reviewer hits a usage limit, a rate limit or a login wall, and when the same review fails twice with the same cause. It probes the reviewer before the first review and after any review whose reviewer failed. `--resume` runs the reviews that have no attempt yet; it is refused when the bundle, the machine, a reviewer's version or model, web access, the timeout, the concurrency, the cases, the configurations or the repeats differ from the run's.

## Compare two builds

```
node benchmark/score.mjs benchmark/results/<new> --against benchmark/results/<old>
```

The comparison first lists anything that differs besides the build: every reviewer with its version and model, the machine, the concurrency, web access, the timeout, the cases and their specs, the repeats. A different model is not a product change. It then shows recall, precision, clean controls, graph disclosure, time and cost per configuration, before and after, and lists regressions: a planted bug missed in two or more reviews of a configuration, more often than before, or more clean changes with findings. One missed review is a reason to look; two are a bug.

`score.mjs` exits 0 when it scored, 1 when the comparison shows a regression, and 2 when a folder cannot be scored. The exit code is information. Do not gate a release on it alone: a person reads the regression and the reviews behind it.

`--against` reads the older run's specs from that run's own `cases/` folder. The scorer refuses specs that lack the words each plant now needs, so `--against` cannot compare a run made before the words existed, such as `2026-10-08-752b77f`. Score such a run alone with the newer run's specs, then read the two summaries side by side:

```
node benchmark/score.mjs benchmark/results/<old> --specs benchmark/results/<new>/cases
```

This scores the old run's saved reviews against the newer specs. It writes `score-cases.json` into the old run's folder and names every case whose specs differ from that run's own. Such a case compares fairly only when the code under review is the same in both runs. When the case's code changed, as the Rails case's did after the first run, the old reviews read other code, and that case's numbers do not compare.

## The wording pass

```
node benchmark/judge.mjs benchmark/results/<run> [--model claude-sonnet-5] [--limit N] [--specs <folder>]
```

A model reads each finding that the script matched to a planted bug, with the bug's planted truth, and says whether its problem, consequence and fix sentences are plain and correct. It judges wording only, never whether the bug was found. It writes `judge.json` and prints a table. Nothing reads `judge.json`, and its verdict never blocks. Use a judge model other than the reviewer's.

## What it does not measure

- How often real changes carry these bugs. The cases are small and synthetic; the share of bugs found here is not the share found in your repository.
- The graph on a large repository. In these cases a search for a name finds every caller, so the graph-off reviewer can find the same callers; the graph's worth on a big codebase is not shown here.
- Scanners that are not installed on the machine that ran. Each sample records which scanners ran; on a Mac without Go or Ruby, golangci-lint, rubocop and brakeman do not run.
- Other reviewers and models, unless the run names them. A run measures one reviewer with one model.
- Run-to-run spread beyond three repeats. The reviewer is a model; three repeats show whether a result holds, not its exact rate.

## The first run

`benchmark/results/2026-10-08-752b77f`: build `752b77f` (openqodex 0.9.0), Claude Code 2.1.294 as the reviewer with `claude-opus-5-5`, on an Apple M5 Pro with Node 22. 14 cases, graph off and on, 3 repeats: 84 reviews, all complete, none failed.

The table is the run scored with the matching rules above, in `score-cases-v2.json`, against `cases-v2/`: the run's own specs with the words each plant and side issue needs added, and nothing else changed. The first scoring, `score.json`, used earlier rules that matched by place and kind alone and counted duplicates as correct; its precision was 101/105 and 102/106. This run was made before the build record existed: its manifest's `dirty: false` means no uncommitted change under `packages/` when the run started, not the tree the bundle was built from.

| Measure | Graph off | Graph on |
|---|---|---|
| Planted bugs found | 96/111 (86%) | 99/111 (89%) |
| critical | 31/33 | 32/33 |
| major | 57/60 | 57/60 |
| minor | 8/18 | 10/18 |
| Findings that are planted bugs | 96/101 (95%) | 99/103 (96%) |
| False findings | 4 | 4 |
| Near misses (one line off) | 1 | 0 |
| Duplicate hits (not counted) | 4 | 3 |
| Clean changes with no finding | 6/6 | 6/6 |
| Callers the change breaks, listed in the brief | 0/15 | 15/15 |
| Graph gaps disclosed in the brief | 0/6 | 3/6 |
| Time per review, mean | 26 s | 25 s |
| Cost per review, mean | $0.10 | $0.11 |

What it showed:

- The four cases whose bug is visible only through a caller outside the diff were found in every review, with the graph off as well as on: in repositories this small, the reviewer finds the callers with its own search. The graph put the callers in the brief every time; it did not change what was found.
- The brief with the graph on says the callers of `onSave` are a floor, but it does not name the computed call `table[action](id)` that reaches it (`js-dynamic-dispatch-gap`, 3 of 3 reviews).
- Most misses are minor Dockerfile issues in the demo repository (an unpinned `apt-get install`, `ADD` for a local file, the pip cache): the scanners raised each one, and the reviewer dropped them as harmless in most reviews.
- Three spec errors in this run's cases were found by reading the reviews, and are fixed for the next run (this run keeps its own copies): the Rails reviewer found the admin check missing from `destroy` at the `destroy` action, a place the spec did not list (2 reviews); the Next.js change drops the base page's search form by accident, a real bug the reviewer reported 5 times, each counted false; and `permit!` sat behind the admin check, so the plant was weak and was never reported (0 of 6). The case now plants it in a self-service profile update. Of the 8 false findings, 7 come from the first two errors. The eighth is real but was not listed: a path traversal in the suppression case's thumbnail command, which the earlier rules had credited to the planted shell injection on the same line. The case now lists it as a side issue.
- The reviewer also asked for tests about once per review (32 and 31 findings); these are counted apart, as the scoring rules above say.
- The wording pass (`judge.json`, judged by `claude-sonnet-5`, which never blocks) read the 203 findings that the earlier rules matched to a planted bug. Graph off and on: the problem sentence was plain in 86% and 90% and correct in 97% and 98%; the consequence plain in 86% and 85%, correct in 97% and 92%; the fix plain in 91% and 95%, correct in 97% and 98%. The judge's answer for 8 findings did not parse.

## The phase 2 run

`benchmark/results/2026-10-09-ac9cdae`: build `ac9cdae` (openqodex 0.10.0 with phase 2 of the code graph: calls through interfaces and base classes, functions used as values, type and value uses), Claude Code 2.1.295 as the reviewer with `claude-opus-5-5`, on the same Mac with Node 22. 15 cases, graph on only, 1 repeat. The run is marked dirty because 18 untracked scratch files sat under `.tmp/` in the build's tree; the product code is the commit's. The fixes from the phase's code review came after this build. They change how sure some edges are, not what the five graph cases' briefs say: scored again on the final build with the same brief checks, those briefs still name every gap and every caller.

The `django-model-view` review failed: the Mac went to sleep a second after it started, and the run stopped it after 1,521 s with no report. That one review ran again on the same build, in `benchmark/results/2026-10-09-ac9cdae-django-retry`, and completed. The phase 2 column takes `django-model-view` from that folder and every other case from the run. Each folder is scored with its own specs (`score.json`). The first run is scored with `cases-v2/`, as in its own table. `score.mjs --against` scores the earlier run with that run's own specs, which predate the words each plant needs, so this comparison calls the scorer's functions directly (#73).

| Measure (graph on) | First run, `752b77f`, 3 repeats | Phase 2, `ac9cdae`, 1 repeat |
|---|---|---|
| Planted bugs found | 99/111 (89%) | 33/38 (87%) |
| critical | 32/33 | 12/12 |
| major | 57/60 | 20/20 |
| minor | 10/18 | 1/6 |
| Findings that are planted bugs | 99/103 (96%) | 33/33 (100%) |
| False findings | 4 | 0 |
| Clean changes with no finding | 6/6 | 2/2 |
| Callers the change breaks, listed in the brief | 15/15 | 7/7 |
| Graph gaps disclosed in the brief | 3/6 | 3/3 |
| Time per review, mean | 25 s | 34 s |
| Cost per review, mean | $0.11 | $0.11 |

What it showed:

- The line this phase moved is the graph gaps. In `js-dynamic-dispatch-gap` the brief now names the computed call `table[action](id)` and lists the table's entries as its possible targets: 2 of 2 checks, where each review of the first run passed 1 of 2.
- The new case, `ts-interface-dispatch-break`, plants a bug that only a call through an interface reaches. Its brief listed both callers that reach it through the `Cache` interface as possible callers and called the list a floor (3 of 3 checks), and the review found the bug. Graph off was not run, so this run does not show whether the graph made the difference.
- On the 14 cases both runs hold, the review found 32 of 37 plants: every critical and major one. The five misses are minor: three Dockerfile issues and a shell loop in the demo repository that the scanners raised and the reviewer dropped, as in the first run, and the list items without keys in the Next.js case.
- No finding was false. Three findings matched side issues the cases list as real but not planted: the Next.js search form the change drops (listed since the first run, where it counted false 5 times), the Next.js search failure that is never caught, and the race between two redemptions in the Django case.
- The mean time rests on one demo review of 98 s, 82 s of it the reviewer's; the first run's three demo reviews with the graph on took 47 s, 83 s and 50 s. The median review took 28 s.

## Code graph phase 3: the graph command and the MCP server

`benchmark/results/2026-10-09-95efb19`: build `95efb19` of the phase 3 branch (openqodex 0.10.0), Claude Code 2.1.295 with `claude-opus-5-5`, graph on, one repeat: 14 reviews, all complete, none failed. `benchmark/results/2026-10-08-588a38c` is an earlier build of the same branch, run the same way. The first run is scored against this run's specs (`score-cases.json` in its folder), so every column uses the same rules and words. Its Rails numbers do not compare, since that case's code changed after it ran.

| Measure | First run, graph on (`752b77f`, 3 repeats) | Phase 3, earlier build (`588a38c`) | Phase 3 (`95efb19`) |
|---|---|---|---|
| Planted bugs found | 100/111 (90%) | 33/37 (89%) | 34/37 (92%) |
| critical | 33/36 | 12/12 | 12/12 |
| major | 57/57 | 19/19 | 19/19 |
| minor | 10/18 | 2/6 | 3/6 |
| Findings that are planted bugs | 100/100 (100%) | 33/33 (100%) | 34/36 (94%) |
| False findings | 0 | 0 | 2 |
| Clean changes with no finding | 6/6 | 2/2 | 2/2 |
| Callers the change breaks, listed in the brief | 15/15 | 5/5 | 5/5 |
| Graph gaps disclosed in the brief | 3/6 | 1/2 | 1/2 |
| Time per review, mean | 25 s | 29 s | 52 s |
| Reviewer turns per review, mean | 3.9 | 4.4 | 5.9 |
| Cost per review, mean | $0.11 | $0.12 | $0.37 |

What it showed:

- Phase 3 changes nothing the reviewer sees. The brief of every case in `95efb19` is the same as in `588a38c` and in the first run, apart from the line that gives the graph's build time and the Rails case, whose code changed. No line of bugs found, clean controls or graph disclosure moved by more than one review's spread.
- The two false findings are real issues the specs do not list: the Go search handler never checks `rows.Err()` after its loop, and the Next.js search page lets a late response overwrite newer results.
- Time, turns and cost per review doubled against `588a38c` with the same briefs and the same Claude Code version. The reviewer asked for more correction rounds (1.71 per review against 1.36). The cause is on the reviewer's side, not in the build: the input did not change. Which part (the account the run used, or the model's own variation between runs) was not tested.
- The graph-off configuration was not run: phase 3 does not change it.

## Code graph phase 4a: Django and Rails framework entries

`benchmark/results/2026-10-09-602a140`: build `602a140` of the phase 4a branch (openqodex 0.10.0), Claude Code 2.1.295 with `claude-opus-5-5`, graph on, one repeat: 15 reviews, all complete, none failed. The first run is scored against this run's specs (`score-cases-602a140.json` in its folder, named for this run so it sits beside other phases' scores of the same run), so both columns use the same rules and words. Its Rails numbers do not compare, since that case's code changed after it ran.

| Measure (graph on) | First run (`752b77f`, 3 repeats) | Phase 4a (`602a140`, 1 repeat) |
|---|---|---|
| Planted bugs found | 100/111 (90%) | 34/38 (89%) |
| critical | 33/36 | 13/13 |
| major | 57/57 | 19/19 |
| minor | 10/18 | 2/6 |
| Findings that are planted bugs | 100/100 (100%) | 34/34 (100%) |
| False findings | 0 | 0 |
| Clean changes with no finding | 6/6 | 2/2 |
| Callers the change breaks, listed in the brief | 15/15 | 5/5 |
| Graph gaps disclosed in the brief | 3/6 | 1/2 |
| Time per review, mean | 25 s | 28 s |
| Reviewer turns per review, mean | 3.9 | 4.1 |
| Cost per review, mean | $0.11 | $0.11 |

What it showed:

- The new case, `django-renamed-view`, renames a view while `orders/urls.py`, outside the diff, still registers the old name. The brief listed the route `ANY orders/<int:pk>/`, named `orders:detail`, declared at `orders/urls.py:8`, with "no handler now: the handler is missing", and the review found the bug. With the graph off, on the same build, three reviews found it too (`benchmark/results/2026-10-09-602a140-django-graph-off`, 3 of 3): in a repository this small the reviewer opens `urls.py` itself. This phase put the broken route in the brief; it moved no line of bugs found.
- On the 14 cases both runs hold, the review found 33 of 37 plants: every critical and major one. The four misses are minor: three Dockerfile issues in the demo repository that the scanners raised and the reviewer dropped, and the list items without keys in the Next.js case, as in the earlier runs.
- No finding was false. Three findings matched side issues the cases list as real but not planted.
- The graph gap line is unchanged: the `js-dynamic-dispatch-gap` brief still does not name the computed call `table[action](id)`. Phase 2 changes that, and this branch does not hold phase 2.

## Code graph phase 4b: the framework plugins

`benchmark/results/2026-10-09-881318b`: build `881318b` (openqodex 0.10.0, the Express, React, Next.js, FastAPI and Go net/http plugins), Claude Code 2.1.295 as the reviewer with `claude-opus-5-5`, graph on, one repeat of the 15 cases: 15 reviews, all complete. It is compared with the graph-on reviews of the first run, scored against this run's specs (`baseline-752b77f-score-cases.json` in this run's folder). Eight cases were edited after the first run, so for those the first run reviewed other files than its score assumes: its Rails `permit!` plant sat behind the admin check, and 0 of 3 of its reviews found it.

| Measure | 752b77f, graph on, 3 repeats, 14 cases | 881318b, graph on, 1 repeat, 15 cases |
|---|---|---|
| Planted bugs found | 100/111 (90%) | 35/38 (92%) |
| critical | 33/36 | 12/12 |
| major | 57/57 | 20/20 |
| minor | 10/18 | 3/6 |
| Findings that are planted bugs | 100/100 | 35/35 |
| False findings | 0 | 0 |
| Clean changes with no finding | 6/6 | 2/2 |
| Callers the change breaks, listed in the brief | 15/15 | 5/5 |
| Graph gaps disclosed in the brief | 3/6 | 1/2 |
| `express-route-param` (new: a handler reading a parameter its route does not declare) | not in the run | 1/1 |
| Time per review, mean | 25 s | 27 s |
| Cost per review, mean | $0.11 | $0.12 |

What it showed:

- No benchmark line moved. The plugins put their routes, middleware and test links on the graph, but nothing in the brief reads them yet: the brief lines that show a changed handler's route come with phase 4a's interface work, so this phase's effect on reviews can be measured only once those are merged.
- The reviewer found the new `express-route-param` bug by reading the route file, which the brief lists as a file that imports the changed handler; the brief does not yet say which route the handler serves.
- The three misses are minor: two Dockerfile issues in the demo repository the reviewer dropped as harmless (as in the first run), and the list items without keys in the Next.js case, a candidate the reviewer dropped.

## Code graph wave 1: phases 2, 3, 4a and 4b merged

`benchmark/results/2026-10-09-5227579`: build `5227579` of the `graph-wave-1` branch (openqodex 0.10.0 with phases 2, 3, 4a and 4b merged), Claude Code 2.1.295 as the reviewer with `claude-opus-5-5` pinned by `--model`, graph on, one repeat: 17 reviews, all complete, none failed. The first run's graph-on reviews are scored against this run's specs in `baseline-752b77f-score-cases.json` in this run's folder; its Rails numbers do not compare, since that case's code changed after it ran. Each phase column is that phase's own run as its section above gives it, scored with its own specs and cases.

| Measure (graph on) | First run `752b77f`, 3 repeats, 14 cases | Phase 2 `ac9cdae`, 15 cases | Phase 3 `95efb19`, 14 cases | Phase 4a `602a140`, 15 cases | Phase 4b `881318b`, 15 cases | Wave 1 `5227579`, 17 cases |
|---|---|---|---|---|---|---|
| Planted bugs found | 100/111 (90%) | 33/38 (87%) | 34/37 (92%) | 34/38 (89%) | 35/38 (92%) | 37/40 (93%) |
| critical | 33/36 | 12/12 | 12/12 | 13/13 | 12/12 | 13/13 |
| major | 57/57 | 20/20 | 19/19 | 19/19 | 20/20 | 20/21 |
| minor | 10/18 | 1/6 | 3/6 | 2/6 | 3/6 | 4/6 |
| Findings that are planted bugs | 100/100 (100%) | 33/33 (100%) | 34/36 (94%) | 34/34 (100%) | 35/35 (100%) | 37/39 (95%) |
| False findings | 0 | 0 | 2 | 0 | 0 | 1 |
| Clean changes with no finding | 6/6 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| Callers the change breaks, listed in the brief | 15/15 | 7/7 | 5/5 | 5/5 | 5/5 | 7/7 |
| Graph gaps disclosed in the brief | 3/6 | 3/3 | 1/2 | 1/2 | 1/2 | 3/3 |
| Briefs with a framework table | none | 0/15 | 0/14 | 3/15 | 0/15 | 8/17 |
| `django-renamed-view` found | not in the run | not in the run | not in the run | 1/1 | not in the run | 1/1 |
| `express-route-param` found | not in the run | not in the run | not in the run | not in the run | 1/1 | 1/1 |
| Time per review, mean | 25 s | 34 s | 52 s | 28 s | 27 s | 26 s |
| Reviewer turns per review, mean | 3.9 | not given | 5.9 | 4.1 | 4.2 | 4.3 |
| Cost per review, mean | $0.11 | $0.11 | $0.37 | $0.11 | $0.12 | $0.11 |

What it showed:

- The framework line moved. Eight of the 17 briefs carry a table of framework entries, against three in phase 4a's run and none in phase 4b's, whose plugins reached the brief only once 4a's lines were merged: the Django and Rails cases, both Express cases, the Go and Next.js cases, and `suppression-comments`.
- In `express-route-param` the brief now lists the route `GET /users/:id` declared at `src/routes/users.js:7`, handled by `getUser` (certain), so the brief itself shows that the route names the parameter `id`. Phase 4b's brief listed no route. The reviewer found the bug in both runs, and read `src/routes/users.js` in both, so this run does not show that the table changed the outcome.
- In `django-renamed-view` the brief lists the route `ANY orders/<int:pk>/`, named `orders:detail`, as having no handler now, as in phase 4a's run, and the review found the bug, as in that run.
- Phase 2's lines hold after the merge: every graph gap the specs check is disclosed (3 of 3) and every broken caller is listed (7 of 7).
- The three misses: two Dockerfile issues in the demo repository (every run misses some of these), and the Decimal times float in `django-model-view`, which the reviewer reported one line off the planted lines (a near miss by the scoring rules, not a hit).
- The false finding is a minor one in `express-admin-routes`: the purge reply reports the requested count as removed. It follows from the planted unawaited `forEach` two lines above it; the specs do not list it, so it counts false.
- Time, turns and cost per review match the first run's.

### The review fixes

The code review of the merged branch changed what four briefs show: three framework tables no longer say a route whose handler is an inline function or a method of an untyped value has "no handler now" (`express-admin-routes`, `go-http-handler`, `suppression-comments`), and the `django-renamed-view` brief adds the gap at the route that names the missing view. Only those four cases ran again, on build `4a7d198`, in `benchmark/results/2026-10-09-4a7d198`, the same way (graph on, one repeat, `claude-opus-5-5`).

| Measure (graph on, the four cases) | Wave 1 `5227579` | Review fixes `4a7d198` |
|---|---|---|
| Planted bugs found | 8/8 | 8/8 |
| False findings | 1 | 0 |
| Time per review, mean | 22 s | 22 s |
| Cost per review, mean | $0.10 | $0.10 |

No planted bug moved. The false finding of `5227579` (the purge reply's count in `express-admin-routes`) was not raised again; one repeat cannot say whether the brief caused that.

## Claims cite a run

A release note, a README line, a post or a reply that states anything about review quality (bugs found, false findings, speed or cost of a review) cites a saved benchmark run: the results folder, the score file it quotes (`score.json`, or `score-<folder>.json` with the specs it used), the build and the reviewer's model. A number that no saved run backs is not written.
