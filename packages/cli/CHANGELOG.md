# openqodex

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
