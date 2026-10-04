# openqodex

## 0.6.0

### Minor Changes

- [#35](https://github.com/openqodex/openqodex/pull/35) [`dfef509`](https://github.com/openqodex/openqodex/commit/dfef5093ded29019f795e98108b02362d4b2f5c4) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - Codex can now be the reviewer. `openqodex review --reviewer codex` runs the full review with `codex exec` on your Codex login, and `auto` picks Codex when you run the command from Codex or when Codex is the only reviewer installed.
  The Codex reviewer reads the copy of the change in a read-only sandbox with no network for its commands. It still loads your global `~/.codex/AGENTS.md`.
  Before each Codex review, OpenQodex checks that the sandbox refuses a read outside the copy and a write inside it. If it does not, the review does not start and you get "Full review unavailable" with the fallback.
  With Codex, the report says file reads were not recorded, because Codex does not show every command it runs. Changed lines count only when the brief or a correction round put them in front of the reviewer.
  Inside Codex's own sandbox, where a second Codex cannot start, `review --reviewer codex` prints "Full review unavailable" and the `review --agent` fallback.
  The reviewer brief no longer tells the reviewer which tools it has; it says to inspect the copy with its own tools, edit nothing and run none of the repository's code.

- [#35](https://github.com/openqodex/openqodex/pull/35) [`8e614e4`](https://github.com/openqodex/openqodex/commit/8e614e493386a0e371afc21594a3e8fe9bc0c20a) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - The reviewer can now search the web and open web pages by default; set `reviewer_web: off` in `~/.openqodex/config.yaml` to remove the web tools.

### Patch Changes

- [#37](https://github.com/openqodex/openqodex/pull/37) [`0b0b923`](https://github.com/openqodex/openqodex/commit/0b0b923c911d6591bf25e924638183bb85cc0ef0) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - A scanner download that is stopped for being too large or too slow no longer leaves its partial file behind.

- [#35](https://github.com/openqodex/openqodex/pull/35) [`59bb4b6`](https://github.com/openqodex/openqodex/commit/59bb4b60353da73ae96f2a1d26a7e7dd239f8e1e) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - - The terminal report no longer prints a line reading only "agent" under a finding the reviewing agent raised from its own reading; a scanner finding the agent verified still names its scanner.

  - The line `hook install` prints for husky or a pre-push hook of your own now passes git's hook arguments (`"$@"`), so a push to a remote other than origin is checked against that remote. The lefthook line passes none, because lefthook would put a remote URL into the command as raw shell text; with lefthook a push is still checked against origin.
  - `docs/security.md` now lists the problem report among the network uses: what the issue holds, and that it is sent only when you choose it.
  - The skill now says that two scanners go online: semgrep downloads its rule packs, and osv-scanner sends dependency names and versions to osv.dev. `--offline` skips both.
  - A brief written by a local build of OpenQodex (run with `node <path>/dist/bin.js`) now names that same node and file in its finalize command, and in the fallback line when no reviewer can start, instead of `npx -y openqodex@<version>`. A run through npx or the launcher is unchanged.
  - `init` and the first scan or review no longer tell you to commit a file that git ignores in your repository; they say it is ignored and not shared with your team.

- [#35](https://github.com/openqodex/openqodex/pull/35) [`379c2ca`](https://github.com/openqodex/openqodex/commit/379c2ca96ef8798c838f9e4c9d51556abb76aa91) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - In a work tree nested inside its bare repository (such as `repo.git/main`), the review after `init` no longer includes the files `init` itself wrote.

- [#35](https://github.com/openqodex/openqodex/pull/35) [`1ce2fac`](https://github.com/openqodex/openqodex/commit/1ce2fac3df1173a986a044d87e47ecedc3030f19) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - The pre-push hook now finds a complete review of the pushed branch even after a later review of other work.

## 0.5.0

### Minor Changes

- [#31](https://github.com/openqodex/openqodex/pull/31) [`4e5b25d`](https://github.com/openqodex/openqodex/commit/4e5b25dc75f653f1b640c852d1396faa8a3f9648) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - - The GitHub Action reads a pull request's OpenQodex config from its base branch, so the pull request cannot hide findings through its own config; when the base cannot be read it uses the built-in defaults, never the pull request's file. The new input `config-from: head` reads the pull request's config instead. A wrong `config-from` or `block-on-severity` value now fails the step.

  - The GitHub Action handles a failed scanner install like a failed scan: a warning and `status: tool-failed`, and a failed job only with `fail-on-tool-error: true`. An incomplete review in SARIF is now a failed run that names what is missing.
  - The push hooks check each range a push sends against the commit the remote holds, so a force push over work the review never saw is not covered by it. The agent hook checks your current work for a plain `git push` and says it cannot tell for any other push command (a deny when `block_on_severity` is set); the git pre-push hook stays the check that sees the exact commits. A pre-push that sends nothing passes.
  - A review stops before the reviewer starts when a file name holds a secret the scanners found, and the reviewer's trace is redacted like the report.
  - A review counts a changed file that was too large to map or brief as unread until the reviewer reads it.
  - A finding must start on a changed line and end within the file and 200 lines.
  - Ctrl-C during a review stops the reviewer and its children and removes the snapshot.
  - The review `init` ends with now reviews your own earlier edits to files init writes, such as CLAUDE.md, without init's own section.
  - A review from the older two-step protocol counts for the push hooks only when this machine ran its scan.
  - The review `init` ends with now runs when `init` also installs the git pre-push hook or adds a `.git/info/exclude` line; before, it stopped with "the review after init did not run".
  - The git pre-push hook accepts a review of a branch made with no upstream set when it is pushed over its remote tip, as long as the review covered exactly the pushed commit; before, such a push counted as unreviewed and, under `block_on_severity`, was stopped every time. When a branch the remote has is still unreviewed and has no upstream, the hook's line says to set the upstream, review, then push.
  - When no reviewer can start (only Codex or only Cursor installed, or Claude Code logged out), `review` now names a fallback after "Full review unavailable": the agent you are in runs `review --agent` and follows the brief it prints. The skill tells the agent to follow it.
  - A review finished through `review --agent` and `review --finalize` says "Reviewed by the coding agent you are using." on the first line after the verdict, in the terminal, `report.md`, `report.json` (`reviewed_by`) and `report.sarif` (a run property). Its brief ends by telling the agent to show you the report as printed.

- [#31](https://github.com/openqodex/openqodex/pull/31) [`a3eb515`](https://github.com/openqodex/openqodex/commit/a3eb5158089cd42d43c35cb6cca92d22bdbad28c) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - - `--reviewer` now takes `auto`, `claude`, `codex` or `cursor`, and `reviewer:` in `~/.openqodex/config.yaml` sets it for every review. Only Claude Code is enabled as a reviewer: Codex and Cursor say why they are not and the review exits 2.

  - `reviewer_web: on` in `~/.openqodex/config.yaml` gives the reviewer Claude Code's web tools. It is off by default.
  - `init` now ends with a review of your change, or asks what to review when there is none (the whole repository, a pull request, a branch, or not now). Without a terminal it prints the three commands. `--no-review` skips it, and a review that cannot run never fails `init`.
  - The push hooks now look up the review of exactly what is pushed. A complete passing review is silent, a missing one asks for `openqodex review`, an incomplete one never blocks, and a review from the older two-step protocol counts, with a line naming who reviewed.
  - The push hooks trust only the review record in your own `~/.openqodex/receipts/`, never report files a branch carries under `.openqodex/`. `init` and `update` remove records older than 30 days.
  - The git pre-push hook no longer scans or prints scanner findings.
  - The GitHub Action says first that it runs the scanners only. A tool failure (exit 2) no longer fails the job: it shows a warning annotation and a job summary line, and sets the new `status` output to `tool-failed`. The new input `fail-on-tool-error: true` fails the job instead, and the new input `block-on-severity` sets a gate that the pull request's own config cannot weaken.
  - `scan --block-on-severity <severity>` wins over the config's `review.block_on_severity`.
  - The skill, the agent rules and the team section now give the agent one command, `review`, and tell it to show the report exactly as printed. Claude Code is allowed to run `review` and `review --all` without asking; the older `review --agent` and `review --finalize` rules are removed.
  - Progress shows one line for the scanner stage, such as "Scanners: 6 ran, 5 had nothing to check, 14 candidates to check", instead of a line per scanner.

- [#31](https://github.com/openqodex/openqodex/pull/31) [`93a4a4a`](https://github.com/openqodex/openqodex/commit/93a4a4a48a8ae212de14d564b27bd671fb052738) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - - `openqodex review` now does the whole review in one run: it copies your change into a temporary snapshot, runs the scanners and the code graph on it, starts Claude Code as a separate reviewer that can only read the snapshot, checks the answer with a script and prints one report. Each finding says where, the problem, why it matters and the fix, and the report ends with which reviewer ran, how long it took and what it used.
  - A review is complete only when every scanner candidate was raised or dropped with a reason and every changed range was given to the reviewer. Otherwise the report says what is missing and the command exits 2.
  - With no reviewer installed and logged in, `review` prints "Full review unavailable", says what is missing, saves the unchecked scanner candidates to a file and exits 2. It never shows scanner output as a review.
  - New flags: `--reviewer auto|claude` and `--timeout <seconds>` (600 by default).
  - `review --agent` and `review --finalize` still work for older skills; a review finished that way is recorded as a legacy review.

## 0.4.0

### Minor Changes

- [#25](https://github.com/openqodex/openqodex/pull/25) [`000d3df`](https://github.com/openqodex/openqodex/commit/000d3dfda4105f9a0127b2584938c58c01677b8c) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - - `openqodex review <branch>` and `openqodex review '[#42](https://github.com/openqodex/openqodex/issues/42)'` (or a pull request link) review a branch or a pull request that is not your current work. OpenQodex fetches it, checks it out in a temporary folder without running anything from it, and reviews what it added since it left its base. Your own settings and approvals apply, never the target's.
  - The base of a branch or pull request review comes from `--base`, the pull request's base when `gh` is installed, `review.default_base`, or the remote's default branch, and the output says which.
  - `review --finalize --run <id>` finalizes one run by name; the brief of a branch or pull request review prints it.
  - A change to a scanner's own settings or ignore file, such as `.gitleaksignore` or `ruff.toml`, is raised as a candidate the reviewer must clear, since it can hide that scanner's findings. A scan shows it as a note that never counts toward the verdict.
  - A change that only deletes code can now carry a finding that counts: the lines next to a deletion count as changed, and the brief lists each deletion point (issue [#22](https://github.com/openqodex/openqodex/issues/22)).

## 0.3.0

### Minor Changes

- [#21](https://github.com/openqodex/openqodex/pull/21) [`db539cd`](https://github.com/openqodex/openqodex/commit/db539cd986ba385aaf53d88cc689b206f4ac73ad) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - `init` inside a repository adds a short review section to the repository's `CLAUDE.md` and `AGENTS.md`, so a teammate's agent reviews before pushing with nothing installed; the files show in `git status` to be committed. `--no-repo` skips it, and `--uninstall` removes exactly that section.
  Every user-scope install gets the launcher in `~/.openqodex/bin/`, even for Cursor or Cline alone. The user-scope skill is now a short stub that runs `<launcher> guide skill` for the full procedure of the active version, and the user-scope Cursor and Cline rules call the launcher instead of `npx -y openqodex@<version>`. The next `init` replaces a skill or rule an earlier `init` wrote, while it is unchanged.
  New `guide skill`: prints the review procedure of the running version, with its commands written for the launcher when the launcher started it.
  The launcher runs the version named on the first line of `~/.openqodex/runtime/current`, and the version `init` installed when that line is missing, malformed or names a copy that is gone. A runtime copy is never replaced once written.
  The skill installed with `npx skills add` uses `~/.openqodex/bin/openqodex` when it exists.

- [#21](https://github.com/openqodex/openqodex/pull/21) [`3f53203`](https://github.com/openqodex/openqodex/commit/3f53203a0e3e01ca87f65b003266375f69be6353) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - In user scope, `init` adds rules so Claude Code runs the exact review command lines the skill names (`review --agent`, `review --finalize`, their `--all` and `--offline` forms) and `guide` without asking. When the launcher's path holds `*`, no rule is written and `init` says so, so a review can run unattended; any other flag or command still asks. `init --uninstall` removes exactly the rules it added.
  The skill `init` writes in project scope keeps the committed `npx -y openqodex@<version>` commands and no longer tells an agent to prefer the launcher.
  `init` skips the team review section for a `CLAUDE.md` or `AGENTS.md` the repository's git ignore rules hide, and says why.
  `init --uninstall` removes the update state, and `~/.openqodex/config.yaml` when `openqodex update` created it and it is unchanged.
  `openqodex update --rollback` turns updates off before anything else and changes nothing when it cannot.
  `openqodex --help` now shows four commands; `scan` is part of `review`; the other commands still work.
  `init`, uninstall, `hook install` and the update's switch take one lock that the operating system releases when a process ends: a listener on 127.0.0.1 that accepts no data. Lock files from earlier versions are removed by `init`.

- [#21](https://github.com/openqodex/openqodex/pull/21) [`23f6714`](https://github.com/openqodex/openqodex/commit/23f67146e67cda5abb195577fe63a70d5e23adc9) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - An install made with `init` updates itself: at most once a day, after a review, scan or push check run through the launcher, a background check installs a newer release that is at least 24 hours old and whose npm provenance was signed by this repository's release workflow. The command never waits for it, and the next command says once which version it moved to.
  New `openqodex update` command: `--now`, `--rollback`, `--off`, `--on` and `--status`. `doctor` shows the update state. Updates are off with `update: off` in `~/.openqodex/config.yaml`, `OPENQODEX_AUTO_UPDATE=0`, `--offline` and in CI.
  `review --finalize` runs on the openqodex version that wrote the brief, and the brief's finalize command names that version's own runtime when the launcher started it.
  A run through npx or a project-scope file never checks for updates; `doctor`, `review` and `scan` say when that pinned version is behind the newest one a check on this machine saw.

### Patch Changes

- [#21](https://github.com/openqodex/openqodex/pull/21) [`58b8578`](https://github.com/openqodex/openqodex/commit/58b8578b24a5722c219d0534a74ed2651ac77c5a) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - A review no longer misses a file edited at the same size within the same second that git last wrote its index.

## 0.2.1

### Patch Changes

- [#14](https://github.com/openqodex/openqodex/pull/14) [`39aeb9f`](https://github.com/openqodex/openqodex/commit/39aeb9f07f0e51819bdcc0369e329d70c0f5218d) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - The push hook no longer follows links when it copies the repo's settings into its temporary checkout, so a pushed commit cannot make it write or delete a file outside that checkout.
  A pushed commit's own `.openqodex` folder never reaches the push scan.
  OpenQodex never reads or writes `.openqodex/` or the root `.openqodex.yaml` through a symbolic link at any level: a link there stops `init`, `init --uninstall`, `report`, `hook check`, `hook pre-push` and `review --finalize` with one line, or counts as no file for a run receipt, instead of reading or writing outside the repository.
  `--config` and `--output` that name a path under `.openqodex/` follow the same rule, and the message for a linked path says to replace the link with a real file.
  A `--config` or `--output` path that reaches `.openqodex/` through a symbolic link elsewhere in the repo is refused with a message that says to name the file directly.
  Files under `.openqodex/` and the config are read only when they are regular files within a size limit, so a link to a device or a named pipe can no longer hang a push or a review.
  The line `hook install` prints for husky, lefthook or a hook it did not write now ends in `|| [ $? -ne 1 ]`, so only a finding at the block threshold stops the push and a tool failure never does.
  Custom instructions are shown to the review agent as quoted text that can only widen or narrow what is flagged; a candidate dropped because of them says so in its reason.

## 0.2.0

### Minor Changes

- [#7](https://github.com/openqodex/openqodex/pull/7) [`ee91b7d`](https://github.com/openqodex/openqodex/commit/ee91b7d43ced9298e24e73b919ce2fec4137e58c) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - `init` asks to add the git pre-push hook, adds a section to each agent's instruction file saying to review in a separate subagent when a feature or fix is done, and creates `.openqodex/config.yaml` and `.openqodex/custom-instructions.md` for the team to commit; the review brief carries the custom instructions word for word, and a scan no longer makes the push gate forget a finished review.

- [#7](https://github.com/openqodex/openqodex/pull/7) [`c70e992`](https://github.com/openqodex/openqodex/commit/c70e99298d887be147323a4ba51b029414030634) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - `openqodex review --all` reviews the whole repository: the scanners check every file, and your agent reviews on top of their results, starting from the most-called functions and the files with the most scanner hits.

- [#7](https://github.com/openqodex/openqodex/pull/7) [`762bbb0`](https://github.com/openqodex/openqodex/commit/762bbb004ba36dbc5acfae2f65b041fbf93d03f0) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - Config moves to `.openqodex/config.yaml`, created with every key and its default on the first run; the root `.openqodex.yaml` is still read. New keys: `review.severity_threshold` (default `minor`: nitpick and info findings stay out of the report unless set to `info`), `review.default_base`, and `graph.enabled`, `graph.budget_ms`, `graph.max_files`, `graph.max_file_bytes`. Keys of the hosted `.qodex.yaml` that have no local meaning warn and are ignored; `pr_review` is accepted as an alias of `review`.

- [#7](https://github.com/openqodex/openqodex/pull/7) [`762bbb0`](https://github.com/openqodex/openqodex/commit/762bbb004ba36dbc5acfae2f65b041fbf93d03f0) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - When OpenQodex itself fails, or a scanner fails, it prints the exact text of a GitHub issue and offers two choices: 1 create the issue, 2 ignore. Nothing is sent without that choice. `openqodex report "<what went wrong>"` offers the same for anything else. The issue never holds code, paths, file names or secrets.

- [#7](https://github.com/openqodex/openqodex/pull/7) [`762bbb0`](https://github.com/openqodex/openqodex/commit/762bbb004ba36dbc5acfae2f65b041fbf93d03f0) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - The review brief now carries a code graph of the repo: which functions the change touches, who calls them with the exact call lines, which files import a changed file, and functions the change removed that other code still calls. It covers TypeScript, JavaScript, Python, Go and Ruby, binds a call only when the code proves the target, builds in a few seconds and caches per file under `.openqodex/graph/`. `graph.enabled: false` in the config or `--no-graph` turns it off.

## 0.1.0

### Minor Changes

- [#3](https://github.com/openqodex/openqodex/pull/3) [`8003022`](https://github.com/openqodex/openqodex/commit/8003022c393621be062ecb1b8aac35b822f3b028) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - First release of OpenQodex, open source code review that runs inside your coding agent before you push.

  - `openqodex review --agent` works out your change, runs the scanners that fit it, and prints a review brief for your agent.
  - `openqodex review --finalize` checks the agent's findings without a model and writes the report as Markdown, JSON and SARIF.
  - `openqodex scan` runs the scanners only, for git hooks, pre-commit and CI.
  - Thirteen built-in scanners, each run only when the change holds a file it reads, and only findings on changed lines kept.
  - Scanners download on first use at pinned versions; a slow install finishes in the background and joins the next run.
  - Any scanner can be added by its GitHub link in `.openqodex.yaml` and runs only after `openqodex trust` approves it.
  - `openqodex init` installs the skill and the push gate into Claude Code, Codex CLI, Cursor and Cline, and `--uninstall` removes them.
  - The push gate warns by default and blocks only when `.openqodex.yaml` sets `review.block_on_severity`.
  - `openqodex hook install` adds an optional git pre-push hook.
  - `openqodex doctor` shows which scanners are ready, and `--install` installs them all.
  - `openqodex demo` builds a small repository with planted bugs and scans it.
  - `openqodex guide` prints the docs offline.
  - A GitHub Action and a pre-commit hook run the scan.
  - `--offline` skips osv-scanner and semgrep, the two built-in scanners that go online, and turns scanner downloads off.
