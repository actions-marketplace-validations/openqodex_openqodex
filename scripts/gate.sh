#!/usr/bin/env bash
# The gate. Runs every check in order and stops at the first failure.
# CI runs the same steps (.github/actions/gate, which both gate jobs in
# .github/workflows/ci.yml use); keep the two in step.
# One CI job is not mirrored here and runs in CI only: bench-scan, the
# scanner-only benchmark and its trend gate against the accepted run in
# benchmark/index. It installs every scanner, which needs Ruby 3.3 for
# brakeman and rubocop and Go 1.26 for golangci-lint (this Mac has neither).
# bench-weekly.yml, the weekly scanner-only run on real pull requests, shares
# its setup (.github/actions/bench-setup) and is not a pull request check.
set -euo pipefail
cd "$(dirname "$0")/.."

step() {
  printf '\n== %s ==\n' "$1"
  shift
  "$@"
}

step "build" pnpm build
step "typecheck" pnpm typecheck
step "lint" pnpm lint
step "unit tests" pnpm test
step "e2e tests" pnpm test:e2e
step "golden run" pnpm golden:check
step "skill and plugin manifests" node scripts/validate-skill.mjs
step "config docs" node scripts/config-docs.mjs --check
step "docs index" node scripts/docs-index.mjs --check
step "docs facts" node scripts/docs-facts.mjs
step "benchmark results" node scripts/benchmark-results.mjs --check
step "private material scrub" node scripts/scrub.mjs

printf '\ngate: green\n'
