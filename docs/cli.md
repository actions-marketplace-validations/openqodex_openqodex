# Commands

Run every command with `npx openqodex <command>`, or `openqodex <command>` when the package is installed. `openqodex --help` lists the four commands below: `init`, `review`, `update` and `trust`. The commands that hooks, the skill and the Action call (`scan`, `doctor`, `hook`, `guide`, `demo`, `report`) still work; `plumbing` describes them.

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

A repository with no commits checks every file with `scan`; `review` needs a first commit to make its snapshot. A review of your own change never fetches from a remote; a review of a branch or a pull request does (see "Reviewing a branch or a pull request").

## Shared flags

`scan`, `review`, `doctor`, `trust` and `guide` accept these flags. `demo` accepts only `--no-color`, `--quiet`, `--verbose`, `--no-install` and `--offline`. `init`, `hook` and `update` accept none of them.

- `--cwd <dir>`: find the repository from `<dir>`. A relative `--output` path still resolves from the folder you ran the command in.
- `--config <path>`: read this config file instead of `.openqodex.yaml` at the repo root.
- `--format <terminal|markdown|json|sarif>`: the report format. The default is `terminal`. Only `scan` and `review` use it.
- `--output <file>`: write the report to `<file>` instead of stdout. Only `scan` and `review` use it.
- `--no-color`: no colour. `NO_COLOR` set in the environment does the same.
- `--quiet`: no progress lines on stderr.
- `--verbose`: print the stack when OpenQodex itself fails.
- `--no-install`: do not download missing scanners. The report lists them as not installed.
- `--offline`: no built-in scanner goes online. osv-scanner and semgrep are skipped and listed as disabled. Scanner downloads are off. The daily version check does not start after this run.

`doctor --install` together with `--offline` or `--no-install` exits 2.

Progress goes to stderr. The report goes to stdout.

`openqodex --version` prints the version. `openqodex --help` lists the commands.

## review

```
openqodex review [--all | --base <ref> | --uncommitted] [--reviewer auto|claude|codex|cursor] [--reviewer-web on|off] [--timeout <seconds>] [--block-on-severity <severity>] [--instructions <file>] [--report-dir <folder>] [--no-graph] [--only <list>] [--skip <list>]
openqodex review <branch | #number | pull request link> [--base <ref>] [--reviewer auto|claude|codex|cursor] [--reviewer-web on|off] [--timeout <seconds>] [--block-on-severity <severity>] [--instructions <file>] [--report-dir <folder>] [--no-graph] [--only <list>] [--skip <list>]
```

- The whole review in one run. OpenQodex copies the change into a temporary snapshot in `~/.openqodex/checkouts/`, runs the scanners and the code graph on it, and starts a reviewer as a separate process with no window: Claude Code (`claude`), which can only read, search and list files in the snapshot, or Codex (`codex exec`), whose commands can read the snapshot and cannot write or reach the network. A script checks the reviewer's answer and sends problems back at most twice, with any changed lines the reviewer was not yet given. The report goes to stdout; progress goes to stderr: one line per stage (for the scanners, for example "Scanners: 6 ran, 5 had nothing to check, 14 candidates to check"), and a line every 15 seconds while the reviewer works. The snapshot is deleted at the end. A review is complete only when every scanner candidate was raised or dropped and every changed range was given to the reviewer; otherwise it says what is missing and exits 2. With no reviewer installed and logged in, it prints "Full review unavailable", what is missing, the path of a file with the unchecked scanner candidates, and a fallback: the `review --agent` command for the agent you are in to review the change itself, and exits 2. `docs/internal-reviewer-drivers.md` records how the reviewer is started and isolated.
- `--reviewer auto|claude|codex|cursor`: the reviewer to start. Without it, `reviewer:` in `~/.openqodex/config.yaml` decides, else `auto`. `auto` picks the agent running the command when it can tell (Claude Code or Codex) and its reviewer can start, else Claude Code, else Codex. `cursor` is not enabled: it says why and exits 2 ("Full review unavailable"). `codex` exits the same way when the command runs inside Codex's own sandbox, where a second Codex cannot start. The report names the reviewer and its version. With Codex it prints "not recorded by Codex" for file reads, because Codex's event stream does not show every command. The reviewer gets its agent's web tools by default (Claude Code's WebSearch and WebFetch, or Codex's cached web search); `reviewer_web: off` in the same file removes them (`security` says why you might).
- `--reviewer-web on|off`: give the reviewer its agent's web tools for this run, or not, whatever `reviewer_web` in `~/.openqodex/config.yaml` says. The file is not changed. The GitHub Action passes `off`.
- `--timeout <seconds>`: stop the reviewer after this long. The default is 600.
- `--block-on-severity <severity>`: the severity that makes the review exit 1 (`info`, `nitpick`, `minor`, `major` or `critical`). It wins over `review.block_on_severity` in the config, as for `scan`.
- `--instructions <file>`: read the owners' instructions from this file instead of `.openqodex/custom-instructions.md`, with the same 32 KB limit. An empty file means no instructions. The GitHub Action passes the base branch's copy, so a pull request cannot supply its own.
- `--report-dir <folder>`: write every file of this run (`report.md`, `report.json`, `report.sarif`, the brief and the rest) to this folder instead of `.openqodex/reviews/`, readable by you only, plus `reviewer.json`, which says whether a reviewer started and which (`{"started": true, "driver": "claude", "version": "2.1.289"}`) or, when none could, why (`{"started": false, "reasons": [...]}`). With it, `review` creates, reads and writes nothing under `.openqodex/` in the repository: no run folder, no `latest.json`, no team files. It still reads the config and `custom-instructions.md` there unless `--config` and `--instructions` name other files, and it still writes the record the push hooks read in your OpenQodex home. Nothing is written when there is nothing to review. The GitHub Action names a new folder of its own, so a report or a link a branch committed under `.openqodex/` is never read and cannot stop the run, and it tells a review that stopped from one that never began by `reviewer.json`.
- `<branch>`, `#<number>` or a pull request link: review that branch or pull request instead of your own change. See "Reviewing a branch or a pull request".
- `--base`, `--uncommitted`: see "Which change is checked".
- `--all`: review the whole repository instead of the change. See "Reviewing the whole repository".
- `--no-graph`: do not build the code graph for this run.
- `--only <list>`: run only these scanners, comma separated.
- `--skip <list>`: skip these scanners, comma separated.

A scanner name is a built-in name such as `semgrep`, or `custom:<name>` for a custom scanner.

`review --agent` and `review --finalize`, the two-step protocol of earlier versions, still work for skills installed before this one and are the fallback `review` names when no reviewer can start: `plumbing` describes them. A review finished that way is recorded as a legacy review, which the push hooks accept, with a line naming who reviewed.

### Deleted lines

A finding counts toward the verdict only on a line the change added or modified. A change that only deletes lines, such as a removed check, has no such line, so the lines next to each deletion count too: the line just above and the line just below it in the new file. The brief lists each deletion point ("2 lines deleted after line 14 of app/auth.py") and tells the reviewer to cite one of those lines and say what was removed. Any other line the change did not touch stays under "Outside the changed lines".

### Reviewing a branch or a pull request

`review <branch>` reviews a branch that is not your current work, and `review '#42'` or `review https://github.com/<owner>/<repo>/pull/42` a pull request. Quote `#42` in a shell, where `#` starts a comment. A bare number is a branch name. The branch may be local, `origin/<name>`, or a branch on the remote that is fetched on demand.

```
openqodex review feature/login
openqodex review '#42'
```

The change is what the target added since it left its base: from the merge base of the two to the target's head, read from the commits, never from a work tree. Commits that landed on the base after the split are not part of it. The base is, in this order:

1. `--base <ref>`.
2. The pull request's base, which `gh` names when it is installed and signed in. For a branch, only when it has exactly one open pull request.
3. `review.default_base`.
4. The remote's default branch (`origin/HEAD`), read without the network.

Without `gh`, a branch review uses the next source, and a review of `#<number>` says in one line that the pull request's base is not known. The first line of the output and the brief say which base was used and where it came from.

The head is fetched first: a branch from its remote, so a stale `origin/<name>` is brought up to date, and a pull request from `pull/<number>/head`, the ref GitHub keeps for every pull request. That ref is the one host convention OpenQodex uses. A base named as `<remote>/<branch>` is fetched too, even when this clone has never seen it. Fetches use git and its own credentials; OpenQodex reads no token. A fetch writes only `refs/remotes/<remote>/<branch>` for a branch, or a ref of its own under `refs/openqodex/tmp/` for a pull request, removed when the review ends: no configured fetch mapping, no tags, no pruning, so your branches and tags never change. A pull request link must name a remote of this repository whose host is exactly `github.com`. In a partial clone, a file that is not downloaded is never fetched for the checkout and the review stops with one line; this needs git 2.44 or newer. An older git fetches such a file itself, so with `--offline` a target review in a partial clone refuses to start on it. For `#<number>`, when `gh` names the repository the pull request was opened against and one of your remotes points at it, the head and the base are fetched from that remote, and a line says which. A local branch is read as it is. `--offline` fetches nothing and calls no `gh`, and says in one line when the target is not available locally.

The files are read in a temporary checkout of the head in `~/.openqodex/checkouts/`, a folder only you can open. Making it, and every later git call in it (the code graph included), runs nothing from the repository: no git hook, no file system monitor, no clean, smudge or process filter (including one an include adds only for linked work trees), no submodule. Files stored in Git LFS hold their pointers, and one line says so. Your settings apply, never the target's: the config and `custom-instructions.md` are read from your repository. Checking the target out runs nothing from it, and a link in it becomes a small plain file holding the link's target. The scanners you approved for this repository do run on the target's files, with this repository's settings; one named only in the target's config never runs. If you review pull requests from people you do not trust, approve only custom scanners that do not execute the code they scan. With `--agent`, when the target is your current commit and your work tree is clean, the files are read in place; with uncommitted work, the committed head is reviewed in a checkout, and one line says your uncommitted work is not part of it.

The review runs in a fresh checkout, and the checkout is removed at the end. With the older `--agent` protocol, the brief names the checkout, tells the agent to read the code there and never to run its tests or scripts, and prints the finalize line with `--run <id>`, run from your repository. The run folder stays in your repository. Finalize checks that the checkout is still at the reviewed commit. It removes the checkout when it succeeds or when the review must be run again, and keeps it after an error the agent can fix in its findings file. A target review writes no receipt, so it never replaces the review of the change you are about to push. A later `review` removes a checkout left for more than 24 hours.

`review --all` and `--uncommitted` cannot be combined with a target.

### Reviewing the whole repository

`review --all` treats every file in the repository as the change: every tracked file and every untracked file git does not ignore, as they are on disk, minus `exclude` and `.openqodex/`. Every line of every text file is in scope, so the scanners report on the whole repository with no changed-line filter. Submodules, symbolic links, unreadable files and files over 5 MB are listed in the brief as left out.

The command runs the scanners and gives the reviewer a brief: the most-called functions from the code graph and the files with the most scanner hits, as places to start; the 50 most severe scanner candidates, with all of them in `candidates.json`; the matching patterns; and the file inventory in `inventory.json`. A finding must name a file in the inventory and a line that exists in it. Every scanner candidate must be raised or dropped; coverage of the files is reported, not required, since no reviewer reads a whole repository line by line. A whole-repo run keeps its own receipt in `.openqodex/latest-all.json`, so it never replaces the review of the change you are about to push.

The brief includes `.openqodex/custom-instructions.md` when the repo has one; a file over 32 KB is refused, never cut. The brief shows it to the reviewer as quoted text from the repository, because anyone who can commit can change it. It can widen or narrow what the reviewer flags, and a candidate dropped because of it says so in the report; it cannot give the reviewer a tool, skip a check or change the finding shape. A scanner given more files than one process can take runs once per batch of files, within its usual time limit.

`--all` cannot be combined with `--base` or `--uncommitted`. The git hook and the GitHub Action never run it.

## init

```
openqodex init [--agent <name>]... [--project] [--hook <pre-push|none>] [--no-repo] [--no-review] [--yes] [--uninstall] [--dry-run]
```

Installs OpenQodex into your coding agents, then reviews. After the install, inside a repository: when there is a change, it runs `review` and prints the report; when there is none, it asks what to review (the whole repository, a pull request, a branch, or not now). With `--yes` or without a terminal it prints the three commands instead of asking. This review uses the scanners already installed, starts no download, and never changes the exit code of `init`, which is about the install.

- `--agent <name>`: `claude-code`, `cursor`, `codex`, `cline` or `all`. Repeat it for several. Without it, `init` uses every agent it finds.
- `--project`: write the files into the repository for a team to commit. The default writes them in your home folder.
- `--hook <pre-push|none>`: answer the pre-push hook question without asking. Without it, `init` asks once per repository and records the answer.
- `--no-repo`: do not add the team review section to the repository's `CLAUDE.md` and `AGENTS.md`. Without it, `init` without `--project` asks once per repository (default yes) and records the answer; `--yes` or `--no-repo` on a later run replaces the recorded answer. A file the repository's git ignore rules hide is left alone, with one line saying why, since it could not be committed.
- `--yes`, `-y`: do not ask. It adds the team review section, even where this repository answered no before (only `--no-repo` keeps it out), and adds the pre-push hook unless this repository answered no to it before or `--hook none` says so. Without a terminal, `init` needs this flag.
- `--no-review`: end after the install, with no review and no question.
- `--uninstall`: remove what `init` wrote. A file you edited after `init` is left in place.
- `--dry-run`: print the plan and write nothing.

`init` does not take the flags listed under "Flags every command below accepts". `agents` lists each file it writes.

## trust

```
openqodex trust [--yes] [--list] [--revoke <name>]
```

Approves the custom scanners in `.openqodex.yaml`. For each new or changed entry, it downloads the release asset. It shows what will run and asks yes or no.

- `--yes`: approve every pending entry without asking. Use it only for entries you have read.
- `--list`: print each custom scanner and its state: trusted, not approved, or changed since approval.
- `--revoke <name>`: remove the approval for one scanner.

Without a terminal and without `--yes`, `trust` exits 2. `custom-scanners` explains the whole step.

## update

```
openqodex update [--now | --rollback | --off | --on | --status]
```

Checks npm for a newer release and installs it now, in the foreground, the same way the daily check does. It works only for an install made with `npx openqodex init`: run through `~/.openqodex/bin/openqodex`, which hooks and the installed skill call. Run any other way (npx, a project-scope file), it exits 2 and says to run `npx openqodex init`.

- No flag: install the newest release that is at least 24 hours old and whose build record verifies, then print what happened.
- `--now`: also install a release younger than 24 hours. Verification is the same.
- `--rollback`: turn updates off, then point the launcher back at the version that was active before the last update. It exits 2 and changes nothing when that version's copy is gone or when `update: off` cannot be written.
- `--off`, `--on`: write `update: off` or `update: on` to `~/.openqodex/config.yaml`. `init --uninstall` removes that file when `update` created it and it is unchanged, and removes the update state.
- `--status`: print the same update lines as `doctor`.

Each release is checked before anything of it runs: its sha512 must match the registry's, and its npm provenance must be signed by this repository's release workflow on `main` (see `security`). A release that fails is skipped, recorded, and not downloaded again for 7 days. An update writes no agent file and never writes inside a repository: the user-scope skill asks the launcher for the procedure with `guide skill`, so it always matches the active version. A foreground `update`, `--rollback`, `--off` and `--on` wait up to 60 seconds while another `init`, uninstall or update runs, then exit 2 with one line. `update` also removes runtime copies older than 7 days, except the one `init` installed, the current one and the previous one.

After an update the next command prints one line on stderr: `openqodex updated to X (was Y). Roll back: openqodex update --rollback`. The agent push hook does not print it.

## Environment variables

- `OPENQODEX_HOME`: where OpenQodex keeps scanners, the launcher and approvals. The default is `~/.openqodex`.
- `OPENQODEX_SKIP=1`: the push gate lets the push through and says so. It is your switch, not your agent's.
- `OPENQODEX_AUTO_UPDATE=0`: no daily version check. `OPENQODEX_OFFLINE=1` and a set `CI` variable do the same.
- `NO_COLOR`: no colour in the terminal report.
