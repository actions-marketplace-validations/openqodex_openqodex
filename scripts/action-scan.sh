#!/usr/bin/env bash
# The GitHub Action's scan step (action.yml runs it). Every value comes from
# the environment, never pasted into the script:
#   OPENQODEX_VERSION   the openqodex version to run
#   BASE_SHA            the pull request's base commit, empty outside one
#   BASE_REF            the pull request's base branch, empty outside one
#   PUSH_BEFORE         a push event's previous commit (all zeros for a new ref)
#   DEFAULT_BRANCH      the repository's default branch
#   BLOCK_ON_SEVERITY   empty, or a severity name
#   CONFIG_FROM         base or head
#   EVENT_NAME          the event that started the workflow
#   RUNNER_TEMP, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY   set by the runner
# The scanner install and the scan run under one tool-failure policy: a
# failure of either sets status tool-failed and warns; the next step decides
# whether that fails the job.
set -eo pipefail

plain_name() { [[ "$1" =~ ^[A-Za-z0-9._/][A-Za-z0-9._/-]*$ ]] && [[ "$1" != -* ]]; }
is_sha() { [[ "$1" =~ ^[0-9a-f]{40}$ ]]; }

# The commit the change is measured from: the pull request's base, a push's
# previous commit, or for a push that creates a branch the merge base with
# the default branch. Fetched when the checkout lacks it.
base=""
if is_sha "$BASE_SHA"; then
  base="$BASE_SHA"
elif [ "$EVENT_NAME" = "push" ] && is_sha "$PUSH_BEFORE"; then
  if [[ "$PUSH_BEFORE" =~ ^0+$ ]]; then
    if plain_name "$DEFAULT_BRANCH" && git fetch --no-tags --quiet origin "refs/heads/${DEFAULT_BRANCH}:refs/remotes/origin/${DEFAULT_BRANCH}" 2>/dev/null; then
      base="$(git merge-base HEAD "refs/remotes/origin/${DEFAULT_BRANCH}" 2>/dev/null || true)"
    fi
  else
    git cat-file -e "${PUSH_BEFORE}^{commit}" 2>/dev/null || git fetch --no-tags --quiet origin "$PUSH_BEFORE" 2>/dev/null || true
    if git cat-file -e "${PUSH_BEFORE}^{commit}" 2>/dev/null; then base="$PUSH_BEFORE"; fi
  fi
fi
no_base=""
[ -n "$base" ] || no_base=" This event gives no base to measure the change from, so the scan uses its default scope."

echo "OpenQodex scanners only: this job runs the scanners on the change and is not a review. The full review runs on your machine with openqodex review.${no_base}"

# A wrong input is a workflow error: it fails the step with one line.
case "$CONFIG_FROM" in
  base | head) ;;
  *)
    echo "::error title=OpenQodex input::config-from must be base or head"
    exit 1
    ;;
esac
case "$BLOCK_ON_SEVERITY" in
  "" | info | nitpick | minor | major | critical) ;;
  *)
    echo "::error title=OpenQodex input::block-on-severity must be empty or one of info, nitpick, minor, major, critical"
    exit 1
    ;;
esac

out_dir="$(mktemp -d "${RUNNER_TEMP}/openqodex-XXXXXX")"
sarif="${out_dir}/openqodex.sarif"
err="${out_dir}/stderr.txt"

# The last non-empty line of a file, safe inside a workflow command: one
# line, no control characters, no %, no run of colons.
last_line() {
  { grep -v '^[[:space:]]*$' "$1" || true; } | tail -n 1 | tr -d '\000-\037\177' | sed -e 's/%/%25/g' -e 's/::*/:/g' | cut -c 1-300
}

# In a pull request the config comes from the base branch unless the workflow
# says head: the pull request's own config could hide findings. Whatever goes
# wrong, the scan gets an explicit config (empty: the built-in defaults),
# never the pull request's own file.
config_args=()
if [ "$EVENT_NAME" = "pull_request" ] || [ "$EVENT_NAME" = "pull_request_target" ]; then
  if [ "$CONFIG_FROM" = "base" ]; then
    base_config="${out_dir}/base-config.yaml"
    : > "$base_config"
    if ! plain_name "$BASE_REF"; then
      echo "::warning title=OpenQodex config::the base branch name is not a plain branch name, so the scan uses the built-in defaults"
    elif ! git fetch --no-tags --quiet origin "refs/heads/${BASE_REF}:refs/remotes/origin/${BASE_REF}"; then
      echo "::warning title=OpenQodex config::could not fetch the base branch, so the scan uses the built-in defaults, not the pull request's config"
    elif ! git show "refs/remotes/origin/${BASE_REF}:.openqodex/config.yaml" > "$base_config" 2>/dev/null; then
      git show "refs/remotes/origin/${BASE_REF}:.openqodex.yaml" > "$base_config" 2>/dev/null || : > "$base_config"
    fi
    config_args=(--config "$base_config")
  fi
fi

args=(scan "${config_args[@]}" --format sarif --output "$sarif")
if [ -n "$base" ]; then args+=(--base "$base"); fi
if [ -n "$BLOCK_ON_SEVERITY" ]; then args+=(--block-on-severity "$BLOCK_ON_SEVERITY"); fi

set +e
npx -y "openqodex@${OPENQODEX_VERSION}" doctor --install "${config_args[@]}" 2> >(tee "$err" >&2)
code=$?
wait
if [ "$code" = "0" ]; then
  npx -y "openqodex@${OPENQODEX_VERSION}" "${args[@]}" 2> >(tee "$err" >&2)
  code=$?
  wait
  # Anything but 0 and 1 (a crash, a kill: 137, 139, 143) is a tool error.
  if [ "$code" != "0" ] && [ "$code" != "1" ]; then code=2; fi
elif [ "$code" != "2" ]; then
  code=2
fi
set -e

echo "exit-code=$code" >> "$GITHUB_OUTPUT"
if [ "$code" = "0" ]; then
  echo "status=passed" >> "$GITHUB_OUTPUT"
elif [ "$code" = "1" ]; then
  echo "status=blocked" >> "$GITHUB_OUTPUT"
else
  echo "status=tool-failed" >> "$GITHUB_OUTPUT"
  reason="$(last_line "$err")"
  [ -n "$reason" ] || reason="exit code $code"
  echo "::warning title=OpenQodex did not run::${reason}"
  echo "OpenQodex did not run: ${reason}" >> "$GITHUB_STEP_SUMMARY"
fi
if [ -f "$sarif" ]; then
  echo "sarif=true" >> "$GITHUB_OUTPUT"
  echo "sarif-file=$sarif" >> "$GITHUB_OUTPUT"
else
  echo "sarif=false" >> "$GITHUB_OUTPUT"
fi
