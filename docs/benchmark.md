# The review benchmark

This page is for contributors and for anyone who wants to check a claim about review quality. The benchmark measures how well `openqodex review` finds bugs that were planted on purpose, how often it reports something that is not there, and what each review costs in time and money. It lives in `benchmark/` in the repository; it is not part of the npm package.

A script runs it and a script scores it. No model decides what runs or how a review scores. A model may judge the wording of findings in a separate, optional pass, and that verdict never blocks anything.

## What it measures

Each case is a small git repository with a base commit and an uncommitted change, the same shape a developer has before a push. The change carries planted bugs, each with a file, a line range, a kind (`bug`, `security`, `performance`, `maintainability` or `style`), a severity and the scanner or the reasoning expected to find it. The benchmark runs the real built CLI on each case, with the real reviewer, with the code graph off and on, three times each.

From the saved reports it counts:

- Recall: planted bugs found, over planted bugs, overall and by severity. A bug found by two findings counts once.
- Precision: findings that are planted bugs, over findings. A side issue the case lists as real but not planted is left out.
- Clean controls: two cases have no bug. Any finding on them is false, and the case fails its control.
- Graph disclosure, for the cases that need the graph: whether the brief named the callers the change breaks, and whether it said what the graph could not see (a caller list that is a floor, a call it could not bind).
- Time per review (from the start of the CLI to its exit), reviewer turns, tokens and cost, as the report records them.

## How a finding is scored

A script matches each finding in `report.json` to the planted bugs of its case:

- Hit: the same file, a line range that overlaps the bug's, and a kind the bug lists. When a bug lists words (`mentions`), the finding must use one of them. This is how a blast-radius bug is scored: the finding must sit on the changed line and name the caller that breaks.
- Near miss: a hit in every way but the lines, within three lines of the range. It is not a hit; it is listed so a spec that names the wrong line can be fixed.
- Wrong kind: on the bug's lines, with a kind the bug does not list. It is not a hit.
- Accepted: on a side issue the case lists as real but not planted. It is left out of precision.
- Test gap: on a case with planted bugs, a finding whose title only asks for a test. The brief hints at missing tests and the planted cases ship none, so such a finding is true. It is counted apart and left out of precision, even when its lines span a planted bug. On a clean case, which ships its tests, it is false.
- False: anything else.

When one finding could match two bugs on the same lines, a bug whose words it uses wins, then the bug whose anchor line is nearest. Each finding counts for one bug at most.

A review that wrote no report misses every bug. A review the product marked incomplete is scored on the findings it holds and counted as incomplete.

## The cases

| Case | Language | Planted bugs (severity; expected finder) |
|---|---|---|
| `clean-python-feature` | Python | none (clean) |
| `clean-ts-refactor` | TypeScript | none (clean) |
| `demo-polyglot` | Python, Flask, Docker, shell, a workflow, npm | the demo repository's twelve: a secret (critical; gitleaks, semgrep), SQL injection (critical; bandit, semgrep), four Dockerfile issues (minor; hadolint), the container left running as root (major; reasoning), a vulnerable lodash (major; osv-scanner), two shell bugs (shellcheck), workflow script injection (major; actionlint, semgrep), a pagination off-by-one (major; reasoning) |
| `django-model-view` | Python, Django | a Decimal times a float (major), a field with no migration (major), an order readable by any user (critical), CSRF turned off on a POST (major); reasoning, semgrep for CSRF |
| `express-admin-routes` | JavaScript, Express | a delete route without the admin check (critical), `forEach` with an async callback that is not awaited (major); reasoning |
| `flask-path-traversal` | Python, Flask | a download path built from a parameter (critical), the debug server on every interface (major); semgrep, bandit, reasoning |
| `go-http-handler` | Go | SQL built with `Sprintf` (critical; semgrep, golangci-lint), a mutex left locked on an early return (major), a deferred close before the error check (major) |
| `js-dynamic-dispatch-gap` | JavaScript | a handler made async while its caller, reached only through `table[action](id)`, uses the result as a string (major); the brief must say the graph could not bind that call |
| `nextjs-react-hooks` | TypeScript, Next.js | hooks after an early return (major), an effect with no dependency list (major), the query string put into the page as HTML (critical), list items without keys (minor) |
| `python-caller-break` | Python | a function that may now return `None`, with callers in another `src` package that add and divide its result (major; reasoning, graph) |
| `rails-controller-model` | Ruby, Rails | SQL built from params (critical), `destroy` left out of the admin check (critical), `permit!` (major), a welcome email on every save (major); brakeman, semgrep, reasoning |
| `suppression-comments` | Python, JavaScript | a shell injection hidden by `# nosec` (critical), an `eval` hidden by `eslint-disable` and `nosemgrep` (critical); a harmless `# noqa: E501` that must not be reported |
| `ts-removed-export` | TypeScript | a renamed export still imported by a file outside the change (major; reasoning, graph); nothing in the diff shows it |
| `ts-workspace-caller-break` | TypeScript, pnpm workspace | `safeGit` changed from returning a string to returning an object, with callers in another package (major; reasoning, graph) |

Thirty-seven planted bugs in all: 11 critical, 20 major, 6 minor.

Each case is a folder under `benchmark/cases/<case>/`: `case.json` (the spec), `base/` (the base commit), `change/` (the files the change writes) and an optional `delete.txt`. `demo-polyglot` reads `examples/demo-repo` instead, and its secret is generated when the case is built, the same value every time, never committed. The repositories are built in a temporary folder; none is committed. `node benchmark/build.mjs <case>` builds one so you can read it.

## Run it

From a clone, with Node 22, Claude Code installed and logged in:

```
pnpm install && pnpm build
node benchmark/run.mjs --dry-run       # print the plan, run nothing
node benchmark/run.mjs                 # 14 cases, graph off and on, 3 repeats: 84 reviews
node benchmark/score.mjs benchmark/results/<date>-<commit>
```

The reviews run on your Claude Code account, at its usual cost. Useful flags of `run.mjs`: `--cases a,b`, `--graph off|on|off,on`, `--repeat N` (more than three needs `--allow-more`), `--reviewers claude,codex`, `--model <id>` (sets the reviewer's model through `ANTHROPIC_MODEL`), `--concurrency N` (default 1; parallel reviews slow each other), `--resume` (finish a stopped run).

Each review runs as `openqodex review --report-dir <sample>/report --reviewer <name> --reviewer-web on --timeout 900`, with `--no-graph` for the graph-off configuration. `--report-dir` means built-in defaults and no custom instructions, so nothing on your machine shapes the review except the reviewer's login.

A run writes one folder, `benchmark/results/<date>-<commit>/`:

- `manifest.json`: the build (commit, CLI version, the bundle's sha256), the reviewer, its version and model, the machine, the date, the plan, and how the run ended.
- `cases/`: the specs the run used. The scorer reads these, so a later edit to a case never changes an old run's score.
- `samples/<case>/<configuration>/<n>/`: the review's own files (`report.json`, `brief.md`, `submission.json`, `trace.json`, `scan.json`), `receipt.txt` (what the review printed), `stderr.txt` and `sample.json` (exit code, time, usage, scanner versions).
- `rows.jsonl`: one line per review.
- `score.json`: written by `score.mjs`.

The run stops at once when the reviewer hits a usage limit, a rate limit or a login wall, and when the same review fails twice with the same cause. It probes the reviewer before the first review and after any review whose reviewer failed. What is saved stays saved; `--resume` runs the rest.

## Compare two builds

```
node benchmark/score.mjs benchmark/results/<new> --against benchmark/results/<old>
```

The comparison first lists anything that differs besides the build: the reviewer's model or version, the cases, the repeats. A different model is not a product change. It then shows recall, precision, clean controls, graph disclosure, time and cost per configuration, before and after, and lists regressions: a planted bug missed in two or more reviews of a configuration, more often than before, or more clean changes with findings. One missed review is a reason to look; two are a bug.

`score.mjs` exits 0 when it scored, 1 when the comparison shows a regression, and 2 when a folder cannot be scored. The exit code is information. Do not gate a release on it alone: a person reads the regression and the reviews behind it.

## The wording pass

```
node benchmark/judge.mjs benchmark/results/<run> [--model claude-sonnet-5] [--limit N]
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

| Measure | Graph off | Graph on |
|---|---|---|
| Planted bugs found | 96/111 (86%) | 99/111 (89%) |
| critical | 31/33 | 32/33 |
| major | 57/60 | 57/60 |
| minor | 8/18 | 10/18 |
| Findings that are planted bugs | 101/105 (96%) | 102/106 (96%) |
| False findings | 3 | 4 |
| Near misses (one line off) | 1 | 0 |
| Clean changes with no finding | 6/6 | 6/6 |
| Callers the change breaks, listed in the brief | 0/15 | 15/15 |
| Graph gaps disclosed in the brief | 0/6 | 3/6 |
| Time per review, mean | 26 s | 25 s |
| Cost per review, mean | $0.10 | $0.11 |

What it showed:

- The four cases whose bug is visible only through a caller outside the diff were found in every review, with the graph off as well as on: in repositories this small, the reviewer finds the callers with its own search. The graph put the callers in the brief every time; it did not change what was found.
- The brief with the graph on says the callers of `onSave` are a floor, but it does not name the computed call `table[action](id)` that reaches it (`js-dynamic-dispatch-gap`, 3 of 3 reviews).
- Most misses are minor Dockerfile issues in the demo repository (an unpinned `apt-get install`, `ADD` for a local file, the pip cache): the scanners raised each one, and the reviewer dropped them as harmless in most reviews.
- Three spec errors in this run's cases were found by reading the reviews, and are fixed for the next run (this run keeps its own copies): the Rails reviewer found the admin check missing from `destroy` at the `destroy` action, a place the spec did not list (2 reviews); the Next.js change drops the base page's search form by accident, a real bug the reviewer reported 5 times, each counted false; and `permit!` sat behind the admin check, so the plant was weak and was never reported (0 of 6). The case now plants it in a self-service profile update. Every false finding in the table comes from the first two errors.
- The reviewer also asked for tests about once per review (32 and 31 findings); these are counted apart, as the scoring rules above say.
- The wording pass (`judge.json`, judged by `claude-sonnet-5`, which never blocks) read the 203 findings that found a planted bug. Graph off and on: the problem sentence was plain in 86% and 90% and correct in 97% and 98%; the consequence plain in 86% and 85%, correct in 97% and 92%; the fix plain in 91% and 95%, correct in 97% and 98%. The judge's answer for 8 findings did not parse.

## Claims cite a run

A release note, a README line, a post or a reply that states anything about review quality (bugs found, false findings, speed or cost of a review) cites a saved benchmark run: the results folder, its `score.json`, the build and the reviewer's model. A number that no saved run backs is not written.
