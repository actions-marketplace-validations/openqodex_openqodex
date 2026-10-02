# Commands

Run every command with `npx openqodex <command>`, or `openqodex <command>` when the package is installed.

## Exit codes

- `0`: clean, or warnings only.
- `1`: a finding at or above `review.block_on_severity`. Without that key, no command exits 1.
- `2`: OpenQodex itself failed: a wrong flag, an invalid config, not a git repository, a stale review, or an internal error. `doctor` prints its table first and then exits 2.

A scanner that fails or is missing never changes the exit code. The report lists it with the reason.

When OpenQodex itself fails (exit 2 with `openqodex failed:`) or a scanner ends `failed`, OpenQodex prints the GitHub issue it would create and two choices: `1 create a GitHub issue` and `2 ignore`. `report` explains the choices. A missing scanner, a wrong flag or a finding never prints them. `hook check` never prints them.

## Which change is checked

By default the change is the commits not yet pushed plus everything uncommitted, untracked files included. OpenQodex finds the base in this order:

1. `--base <ref>`: the point where the current branch left that ref.
2. `--uncommitted`: the last commit, `HEAD`. Only uncommitted work counts.
3. The point where the branch left its upstream branch.
4. The point where the branch left the remote's default branch (`origin/HEAD`).
5. The last commit, `HEAD`.

A repository with no commits checks every file. OpenQodex never fetches from a remote.

## Shared flags

`scan`, `review`, `doctor`, `trust` and `guide` accept these flags. `demo` accepts only `--no-color`, `--quiet`, `--verbose`, `--no-install` and `--offline`. `init` and `hook` accept none of them.

- `--cwd <dir>`: find the repository from `<dir>`. A relative `--output` path still resolves from the folder you ran the command in.
- `--config <path>`: read this config file instead of `.openqodex.yaml` at the repo root.
- `--format <terminal|markdown|json|sarif>`: the report format. The default is `terminal`. Only `scan` and `review` use it.
- `--output <file>`: write the report to `<file>` instead of stdout. Only `scan` and `review` use it.
- `--no-color`: no colour. `NO_COLOR` set in the environment does the same.
- `--quiet`: no progress lines on stderr.
- `--verbose`: print the stack when OpenQodex itself fails.
- `--no-install`: do not download missing scanners. The report lists them as not installed.
- `--offline`: no built-in scanner goes online. osv-scanner and semgrep are skipped and listed as disabled. Scanner downloads are off.

`doctor --install` together with `--offline` or `--no-install` exits 2.

Progress goes to stderr. The report goes to stdout.

`openqodex --version` prints the version. `openqodex --help` lists the commands.

## review

```
openqodex review [--agent | --finalize [path]] [--all | --base <ref> | --uncommitted] [--no-graph] [--only <list>] [--skip <list>]
```

- `--agent`: run the scanners, write the brief and print it. Your agent runs this.
- `--finalize [path]`: check the agent's findings and write the report. Without a path it reads `agent-findings.json` in the newest report folder. With a path it finds the run by the `change_id` in that file.
- Neither flag: the same as `scan`, plus one line on how to get the AI review from your agent.
- `--base`, `--uncommitted`: see "Which change is checked".
- `--all`: review the whole repository instead of the change. See "Reviewing the whole repository".
- `--no-graph`: do not build the code graph for this run.
- `--only <list>`: run only these scanners, comma separated.
- `--skip <list>`: skip these scanners, comma separated.

A scanner name is a built-in name such as `semgrep`, or `custom:<name>` for a custom scanner.

`--finalize` exits 2 when:

- the findings file breaks the shape, naming the first wrong field;
- the change moved since the brief;
- the config changed since the brief;
- a finding cites a scanner rule or candidate that is not in this scan.

It never repairs a finding. Fix what it names, or run `review --agent` again.

### Reviewing the whole repository

`review --all` treats every file in the repository as the change: every tracked file and every untracked file git does not ignore, as they are on disk, minus `exclude` and `.openqodex/`. Every line of every text file is in scope, so the scanners report on the whole repository with no changed-line filter. Submodules, symbolic links, unreadable files and files over 5 MB are listed in the brief as left out.

There is no scan-only report of the whole repository. With or without `--agent`, the command runs the scanners and prints a brief for your agent: the most-called functions from the code graph and the files with the most scanner hits, as places to start; the 50 most severe scanner candidates, with all of them in `candidates.json`; the matching patterns; and the file inventory in `inventory.json`. Without `--agent` it adds one line saying the review is done when your agent finalizes it. Ask your agent: review my whole repo with openqodex.

`review --finalize` then works as for a change. A finding must name a file in the inventory and a line that exists in it, or finalize exits 2. Any edit to any file after the brief moves the review id, and finalize says the change moved.

`--all` cannot be combined with `--base` or `--uncommitted`. The git hook and the GitHub Action never run it.

## scan

```
openqodex scan [--base <ref>] [--uncommitted] [--only <list>] [--skip <list>]
```

Runs the scanners on the change and prints the report. No model is involved. The git hook, the pre-commit hook and the GitHub Action run this command.

## init

```
openqodex init [--agent <name>]... [--project] [--yes] [--uninstall] [--dry-run]
```

Installs OpenQodex into your coding agents.

- `--agent <name>`: `claude-code`, `cursor`, `codex`, `cline` or `all`. Repeat it for several. Without it, `init` uses every agent it finds.
- `--project`: write the files into the repository for a team to commit. The default writes them in your home folder.
- `--yes`, `-y`: do not ask. Without a terminal, `init` needs this flag.
- `--uninstall`: remove what `init` wrote. A file you edited after `init` is left in place.
- `--dry-run`: print the plan and write nothing.

`init` does not take the flags listed under "Flags every command below accepts". `agents` lists each file it writes.

## doctor

```
openqodex doctor [--install] [--json]
```

Prints the Node and git versions, the repository, the config, the OpenQodex home folder and the state of each scanner. It lists custom scanners with their approval state.

- `--install`: download every scanner that fits this machine, and wait for all of them.
- `--json`: print the same facts as JSON.

`doctor` always prints its table. It then exits 2 in three cases:

- git is missing;
- the config does not load;
- the `--cwd` folder does not exist.

## trust

```
openqodex trust [--yes] [--list] [--revoke <name>]
```

Approves the custom scanners in `.openqodex.yaml`. For each new or changed entry, it downloads the release asset. It shows what will run and asks yes or no.

- `--yes`: approve every pending entry without asking. Use it only for entries you have read.
- `--list`: print each custom scanner and its state: trusted, not approved, or changed since approval.
- `--revoke <name>`: remove the approval for one scanner.

Without a terminal and without `--yes`, `trust` exits 2. `custom-scanners` explains the whole step.

## hook

```
openqodex hook check
openqodex hook install [--force]
openqodex hook uninstall
```

- `hook check`: the push gate. The Claude Code and Codex hooks call it before a shell command. It reads the hook's JSON on stdin. It always exits 0.
- `hook install`: add a git pre-push hook to this repository. It also sets up the launcher in `~/.openqodex/`, which the hook calls. The hook runs `scan` before each push. It stops the push only when the scan exits 1. A scan that fails for its own reasons never stops the push.
- `hook install` refuses to replace a hook it did not write. `--force` replaces it and keeps the old hook as `pre-push.openqodex.bak`.
- `hook uninstall`: remove that hook and put back the one it replaced. A hook you edited after install is left in place.

When the repository uses husky or lefthook, `hook install` writes nothing. It prints the line to add to their pre-push hook.

`init` never installs the git hook. `agents` explains the push gate.

## guide

```
openqodex guide [topic]
```

Prints the skill without a topic. With a topic, it prints that page of these docs. An unknown topic lists the topics and exits 2.

## demo

```
openqodex demo [dir]
```

Builds the demo repository in `<dir>`, or in a new temporary folder. A relative `<dir>` resolves from the folder you run the command in. The folder must be empty or new. The demo commits a clean baseline, then adds a change with planted bugs and leaves it uncommitted. It scans that change and prints the report. When some scanners are still installing, it says so and asks you to run `scan` again. The secret in the demo is generated each time and works nowhere.

## report

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

## Environment variables

- `OPENQODEX_HOME`: where OpenQodex keeps scanners, the launcher and approvals. The default is `~/.openqodex`.
- `OPENQODEX_SKIP=1`: the push gate lets the push through and says so. It is your switch, not your agent's.
- `NO_COLOR`: no colour in the terminal report.
