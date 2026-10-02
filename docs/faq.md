# FAQ

## Do I need an API key or an account?

No. The review runs on the model your coding agent already uses. OpenQodex itself calls no model.

## Does OpenQodex send my code anywhere?

Not through the built-in scanners. Their network use is listed in `security`: scanner downloads, Semgrep rule packs, and dependency names and versions sent to osv.dev. Your agent's model sees what your agent reads, as it always does. A custom scanner you approved does whatever its own command does.

## Will it block my push?

Not by default. Without `review.block_on_severity` in `.openqodex.yaml`, OpenQodex only warns. Set that key to block pushes at a severity. `OPENQODEX_SKIP=1` lets one push through.

## Why did a scanner not run?

The report lists every selected scanner with a status and a reason. The usual reasons:

- The change holds no file it reads.
- It is still downloading on first use. It joins the next run.
- It needs Ruby or Go, which OpenQodex does not install.
- The agent's sandbox cannot download it. Run `npx openqodex doctor --install` in your own terminal.

## Why is a finding missing that the scanner reports on my whole repo?

OpenQodex keeps only findings on the lines your change adds or edits. Findings elsewhere belong to code you did not touch. A finding the agent places outside the changed lines is listed separately and never counts toward the verdict.

## Why were findings in my test fixtures dropped?

Scanner findings in fixtures, mocks, stubs, fakes and snapshots are dropped by default, because those files hold throwaway data. Set `review.include_fixtures: true` to keep them.

## How do I leave files out of the review?

List globs under `review.paths.exclude`. A `**/` prefix does not match a file at the repository root. To match both, list `**/x` and `x`. `config` has the rules.

## Can I use a scanner that is not built in?

Yes, by its GitHub link. Add two lines to `.openqodex.yaml` and approve the entry with `openqodex trust`. `custom-scanners` explains how.

## Does it change my repository?

The review writes only inside `.openqodex/`, which ignores itself in git. `git status` does not change. The built-in scanners run with fixes switched off, and their caches live outside the repository. A custom scanner you approved does whatever its own command does. `init` in user scope adds any repository file it writes to `.git/info/exclude`.

## Where are the reports?

In `.openqodex/reviews/<time>-<id>/` in the repository: `report.md` to read, `report.json` and `report.sarif` for tools. `.openqodex/latest.json` points at the newest one.

## Does it work on Windows?

Through WSL. OpenQodex runs on macOS and Linux.

## How do I remove it?

`npx openqodex init --uninstall` removes what `init` wrote. Delete `~/.openqodex/` to remove the scanners as well.
