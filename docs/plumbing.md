# Plumbing commands

`openqodex --help` lists four commands: `init`, `review`, `update` and `trust`. The commands below still work the same way. They are hidden from `--help` because hooks, the skill, the Action or OpenQodex itself call them, not people in daily use.

## scan

For machines. Kept for the pre-commit hook and the GitHub Action, which call it, and for the git pre-push hook of earlier releases.

```
openqodex scan [--base <ref>] [--uncommitted] [--only <list>] [--skip <list>] [--block-on-severity <severity>] [--report-dir <folder>]
```

Runs the scanners on the change and prints their findings, labelled as scanner data. No model is involved and nothing is checked: it is not a review. The pre-commit hook runs this command, and so does the GitHub Action when it has no key for the review or no reviewer could start. `--block-on-severity` sets the severity that makes it exit 1, and wins over `review.block_on_severity` in the config. `--report-dir <folder>` writes this scan's files (`report.md`, `report.json`, `report.sarif`, `scan.json`) to that folder instead of `.openqodex/reviews/`, and then the scan creates, reads and writes nothing under `.openqodex/` in the repository, as for `review`: without `--config` it uses the built-in defaults.

## review --agent and review --finalize

The two-step protocol of earlier versions, kept so a skill installed before the one-command review keeps working, and the fallback `review` names when no reviewer can start (only Codex or only Cursor installed, or Claude Code logged out). The brief `review --agent` prints carries the whole procedure. New skills, rules and permission rules no longer name it.

```
openqodex review --agent [--all | <target>] [...]
openqodex review --finalize [--run <id> | path]
```

- `review --agent`: run the scanners, write the brief and print it for the agent running the command.
- `review --finalize [path]`: check the agent's findings file and write the report. Without a path it reads `agent-findings.json` in the newest report folder. With a path it finds the run by the `change_id` in that file. `--run <id>` names the run folder instead; a review of a branch or a pull request is finalized only that way.

`--finalize` exits 2 when the findings file breaks the shape (naming the first wrong field), the change or the config moved since the brief, a finding cites a scanner rule or candidate that is not in this scan, the brief was written by another openqodex version that is not installed in `~/.openqodex/runtime/`, or, for a branch or a pull request, the temporary checkout moved from the reviewed commit or is gone. When the launcher started the review, the brief's finalize command is the plain line `<launcher> review --finalize`, with `--all` and `--offline` as the review had them. When the version that runs `--finalize` is not the one that wrote the brief, and that one is installed, it hands the run to that version. It never repairs a finding.

A review finished this way is a legacy review: the agent that ran it reviewed the change itself. Its report says so on the first line after the verdict, in every format ("Reviewed by the coding agent you are using."; `reviewed_by` in `report.json`, a run property in `report.sarif`). Finalize writes a legacy record to `~/.openqodex/receipts/`, and the push hooks accept it as reviewed, with a line naming who reviewed; it never counts as a complete record.

## doctor

For you, when a scanner is missing or slow to install. The skill asks you to run `doctor --install` once when the agent runs in a sandbox.

```
openqodex doctor [--install] [--json]
```

Prints the Node and git versions, the repository, the config, the OpenQodex home folder and the state of each scanner. It lists custom scanners with their approval state.

- `--install`: download every scanner that fits this machine, and wait for all of them.
- `--json`: print the same facts as JSON.

Under "Your settings" it prints each key of `~/.openqodex/config.yaml` (`update`, `reviewer`, `reviewer_web`, `skip_version`) with the value in force and where it comes from: the file, the default, or the environment variable that turns updates off. It names a key it does not know with the known key nearest to it.

Under "Updates" it prints the running version and whether the launcher started it, the newest version the last check saw and when, the last check, whether updates are on (and why not), and the last update error. For a version not started through the launcher (npx, a project-scope file), it says when that pinned version is behind the newest one a check saw. Without a check on this machine, it says nothing about that.

`doctor` always prints its table. It then exits 2 in three cases:

- git is missing;
- the config does not load;
- the `--cwd` folder does not exist.

## hook

Called by the agent push hooks and the git pre-push hook that `init` writes. You run `hook install` and `hook uninstall` yourself when you want the git hook without `init`.

```
openqodex hook check
openqodex hook install [--force]
openqodex hook uninstall
```

- `hook check`: the push gate. The Claude Code and Codex hooks call it before a shell command. It reads the hook's JSON on stdin and looks up the review of exactly the change being pushed. It always exits 0.
- `hook install`: add a git pre-push hook to this repository. It also sets up the launcher in `~/.openqodex/`, which the hook calls. The hook runs `hook pre-push`, which does the same lookup for each commit the push sends (`agents` has the details). It prints no scanner findings and never starts a review. It stops the push (exit 1) only when the config sets `block_on_severity` and the review is missing or blocked. A lookup that fails for its own reasons never stops the push.
- `hook install` refuses to replace a hook it did not write. `--force` replaces it and keeps the old hook as `pre-push.openqodex.bak`.
- `hook uninstall`: remove that hook and put back the one it replaced. A hook you edited after install is left in place.

When the repository uses husky or lefthook, `hook install` writes nothing. It prints the line to add to their pre-push hook. For husky it is `npx -y openqodex@<version> hook pre-push "$@" || [ $? -ne 1 ]`, so the hook gets the remote's name, which picks the base for a new branch. For lefthook the line has no `"$@"`: lefthook puts git's hook arguments into its command line as raw text, so a remote URL could carry shell code into it. Without the arguments, the hook looks the push up against `origin`, so a push to another remote is checked as if it went to `origin`. The part after `||` makes the line stop the push only on exit 1, as the hook `hook install` writes does: a lookup that fails for its own reasons (exit 2) never stops the push.

`init` asks whether to install the git hook. `agents` explains the push gate.

## guide

For agents: the skill reads the docs offline with it.

```
openqodex guide [skill | topic]
```

`guide skill`, and `guide` with no topic, print the full review procedure of the running version: the shipped skill with every command written for the runner that started it, the launcher's full path when the launcher started it, else `npx -y openqodex@<version>`. The skill `init` writes in user scope is a short stub that tells the agent to run `<launcher> guide skill` and follow what it prints. With a topic, it prints that page of these docs. An unknown topic lists the topics and exits 2.

## demo

For a first look: builds a repo with planted bugs to scan.

```
openqodex demo [dir]
```

Builds the demo repository in `<dir>`, or in a new temporary folder. A relative `<dir>` resolves from the folder you run the command in. The folder must be empty or new. The demo commits a clean baseline, then adds a change with planted bugs and leaves it uncommitted. It scans that change and prints the report. When some scanners are still installing, it says so and asks you to run `scan` again. The secret in the demo is generated each time and works nowhere.

## config migrate

For you, after a release renames or removes a key of the repo config, or for a repository that still has the 0.1.0 root `.openqodex.yaml`.

```
openqodex config migrate [--write]
```

Prints each change the table in `config` ("Changes between versions") asks of this repository's config, and the file as it would be, and writes nothing. With `--write` it writes that file: a renamed key gets its new name in place, a removed key is taken out, every comment stays, and the root `.openqodex.yaml` moves to `.openqodex/config.yaml`. A rewrite that would change what the config does is refused with exit 2. With nothing to change, it says so.

## report

Offered by OpenQodex itself after an internal failure.

```
openqodex report "<what went wrong>"
openqodex report --send-last
```

- `report "<what went wrong>"`: report a problem with OpenQodex. It prints the issue it would create and the two choices, the same as after a failure. It exits 0. Words that hold a path, a file name, a key or token, or an email address are refused with exit 2: remove them and run it again. Your user name and the repository's name are replaced with `<name>`.
- `report --send-last`: print the last issue shown in this repository again, then create it exactly as it was shown. Outside a repository it uses the last one shown outside a repository. It refuses a saved issue that is a link, is not in the saved shape, or changed after it was shown.

The issue holds only the command and its flags, a short diagnostic, the status of each scanner, the operating system, the CPU type and the Node version. For a scanner the diagnostic is its failure class only, such as `exited with code 2` or `timed out after 60 s`, never its output. For an internal error it is the error's class and first line, cut to 120 characters. Every path, file name, key or token, email address, user name and repository name is removed first, and a custom scanner is shown as `custom scanner`. It never holds code, diffs, findings, config or logs.

When the issue could not be saved, OpenQodex says so and does not offer `--send-last`.

In a terminal, press 1 or 2. Any other key, Enter, Ctrl-C or the end of input counts as 2. Without a terminal (an agent, a git hook, CI), OpenQodex prints the issue and how to create it later with `openqodex report --send-last`; doing nothing ignores it.

Choice 1 creates the issue with the GitHub CLI when `gh auth status` says you are signed in. Otherwise it opens the new issue page on GitHub with the title and body filled in, and prints the link. OpenQodex never signs you in. Choice 2 sends nothing. Nothing leaves your machine without choice 1. The last issue shown is kept in `.openqodex/last-report.json`, which git ignores.
