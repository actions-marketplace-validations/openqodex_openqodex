# Working in this repo

OpenQodex is open source code review that runs inside your coding agent, before you push. This file tells a coding agent how the repo is built and tested.

## Setup

- Node 22 or newer. The published package must work on Node 22, so test on 22 even if your machine has a newer default.
- pnpm 9 (the version is pinned in `package.json` under `packageManager`).
- `pnpm install`, then `pnpm build`.

## Commands

- `pnpm build`: builds `@openqodex/core`, then `@openqodex/scanners`, then the `openqodex` CLI, then copies the shipped assets beside the bundle.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` (unit), `pnpm test:e2e` (runs the built CLI as a real subprocess).
- `pnpm gate`: every check in order, stopping at the first failure. It must be green before any push. CI (`.github/workflows/ci.yml`) runs the same steps on Linux and macOS.
- `pnpm changeset`: add a changeset to any pull request with a change a user can see.
- `pnpm docs:index`: regenerates `docs/llms.txt`.

## Where things live

- `packages/cli`: the `openqodex` binary. It is published as one bundled file, `dist/bin.js`, with no runtime dependencies; every library it uses is a dev dependency that the bundler inlines.
- `packages/core`: the change source, the config parser, the lenses, the review brief, the renderers.
- `packages/scanners`: the scanner adapters, the changed-line filter and the pinned scanner table (`toolchain.json`).
- `skills/openqodex/`: the agent skill. `plugins/claude-code/`: the Claude Code plugin. `docs/`: the docs, shipped in the package. `examples/demo-repo/`: the sample repo with planted bugs.
- Assets that ship beside the bundle (lenses, docs, skill, templates, toolchain table, demo) are found at run time relative to the installed package through `assetPath()` in `packages/cli/src/assets.ts`, never from the current directory. `scripts/copy-assets.mjs` copies them into `packages/cli` after the build; the copies are gitignored.

## Exit codes

0 clean or warnings only, 1 a finding at or above the block threshold, 2 the tool itself failed.

## Tests

- No test fakes a module that lives in this repo or a binary on this machine. The only fake allowed is a model provider.
- End-to-end first: a feature is proved by running the real CLI on a real repo and reading the saved report.
- A piece that must be tested alone gets its list of failure cases written before its code. Do not add unit tests after the code to raise coverage.

## Writing

Plain English, sentence case, no emoji, no exclamation marks, no em dash character anywhere (prose, code comments, commit messages, changelog). Define a term the first time it appears. `scripts/scrub.mjs` fails the gate on private material and on the em dash.
