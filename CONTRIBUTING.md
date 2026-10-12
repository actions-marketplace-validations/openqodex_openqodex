# Contributing to OpenQodex

Thank you for helping. This page says how to set up the repository, how changes are tested, and what a pull request needs.

## Setup

- Node 22. The published package must work on Node 22, so test on 22 even when your machine has a newer default.
- pnpm 9. `package.json` pins the exact version under `packageManager`.
- git.

```
pnpm install
pnpm build
```

Run the CLI you built from any git repository with a change:

```
node packages/cli/dist/bin.js review
```

## The gate

```
pnpm gate
```

The gate builds, typechecks, lints and runs the unit and end-to-end tests. It then validates the skill and the plugin manifests and scans for private material. It stops at the first failure. CI runs the same steps with Node 22: on Linux for a pull request, and on Linux and macOS in the merge queue and on main. Run it before you push.

The end-to-end tests run the real CLI on the demo repository with the real scanners. The first run downloads them.

## Tests

- No test fakes a module that lives in this repository or a program on the machine. `vi.mock`, `vi.fn` and their kin are not used. Tests use real temporary folders, real git repositories and real scanner output.
- A test makes its temporary folders with `tempDir()` from `tests/temp-dirs.mjs`, and its file calls `afterAll(removeTempDirs)`. Each test run keeps its temporary folders in one folder of its own and fails when a test leaves one behind (`tests/temp-guard.ts`).
- A feature is proved end to end: run the real CLI on a real repository and read the saved report.
- A piece tested alone starts with its failure cases, listed in a comment at the top of the test file. The tests follow that list. The code comes last.
- A bug report becomes a test on the demo repository before it is fixed. The test and the fix share one pull request.

## Changesets

A pull request with a change a user can see carries a changeset:

```
pnpm changeset
```

Pick the `openqodex` package and the bump. Write one line in plain English about what the user sees. The release workflow turns changesets into `CHANGELOG.md`.

## Before a release

The "Version packages" pull request publishes when it merges. Before you merge it, check out its head and compare the build with the published package on the planted cases and AACR-Bench's development subset:

```
node benchmark/build-cli.mjs
node benchmark/ingest/aacr.mjs --data-only
node benchmark/release-check.mjs --install-scanners
```

It runs no model and spends nothing. It must exit 0. Exit 1 names each loss, such as a planted bug the published package found and the new build misses: fix it before the release. Exit 2 means it could not run and shows nothing either way. On a machine without Ruby, Go or Cargo, add `--allow-missing-scanners`. `docs/benchmark.md` ("The release check") says what it compares. The release workflow runs the planted part again before it publishes, and does not publish on any exit but 0.

## After a release

The self-update can only be proven between two real releases. After a publish, run the release check from the previous release to the new one:

```
node scripts/check-self-update.mjs --from <previous> --to <new> --now
```

It installs `<previous>` from npm into a temporary home with `init`, runs the update through the launcher and requires that the launcher then runs `<new>`. Without `--now` it starts the daily check through a normal command instead, which installs only a release at least 24 hours old.

## Docs

The docs in `docs/` ship inside the package. A change to a config key, a flag or a command updates its page in the same pull request. `pnpm docs:index` regenerates `docs/llms.txt`.

## Writing

Plain English, sentence case, no emoji, no exclamation marks. Never use the em dash character, in prose, code comments, commit messages or the changelog. The gate fails on it.

## Sign-off

Every commit carries a Developer Certificate of Origin sign-off. It states that you wrote the change or have the right to submit it under the Apache 2.0 licence. The text is at https://developercertificate.org.

Add the sign-off with `git commit -s`. It adds this line, with your name and email:

```
Signed-off-by: Your Name <you@example.com>
```

## Pull requests

- One change per pull request.
- The gate is green.
- The pull request carries its test, its docs change and its changeset.
- Security problems are never reported in a pull request or an issue. See `SECURITY.md`.

## CI and the merge queue

- A pull request runs one check: the gate on Linux. The macOS gate and the scanner-only benchmark show as skipped.
- When the pull request is ready, a maintainer adds it to the merge queue. The queue merges it with main and with every pull request ahead of it in the queue. Then it runs the full gate on that result: the gate on Linux, the gate on macOS and the scanner-only benchmark.
- When the full gate passes, the queue merges the pull request into main. When it fails, the queue removes the pull request and main does not change. Fix the branch and add it to the queue again.
- To run the full gate before the queue, for example on a scanner or installer change, a maintainer adds the label `full-ci` to the pull request.
- Each push to main runs the full gate again, and the release workflow.

## Adding a built-in scanner

Open a scanner request issue first. A built-in scanner needs three things. It needs a pinned version for every supported system in `packages/scanners/toolchain.json`. It needs an adapter. It needs a planted bug in the demo repository that the end-to-end test checks. A compatible scanner can already run as a custom scanner without a change here: one that writes SARIF or one JSON document. See `docs/custom-scanners.md`.
