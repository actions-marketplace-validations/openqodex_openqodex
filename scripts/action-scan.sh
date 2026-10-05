#!/usr/bin/env bash
# The GitHub Action's step (action.yml runs it): the full review when the
# step's environment holds ANTHROPIC_API_KEY or `review` is required, the
# scanners only otherwise. Every value comes from the environment, never
# pasted into the script:
#   OPENQODEX_VERSION   the openqodex version to run
#   BASE_SHA            the pull request's base commit, empty outside one
#   BASE_REF            the pull request's base branch, empty outside one
#   PUSH_BEFORE         a push event's previous commit (all zeros for a new ref)
#   DEFAULT_BRANCH      the repository's default branch
#   BLOCK_ON_SEVERITY   empty, or a severity name
#   CONFIG_FROM         base or head
#   EVENT_NAME          the event that started the workflow
#   REVIEW              auto, off or required
#   CLAUDE_CODE_VERSION the Claude Code version the review runs
#   ANTHROPIC_API_KEY   the repository's key, set on the step from a secret
#   RUNNER_TEMP, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY   set by the runner
# The key leaves the environment on the first line below. Only the review
# command gets it back: doctor, the Claude Code install and a fallback scan
# never see it, and nothing here prints it or writes it to a file.
# The scanner install, the review and the scan run under one tool-failure
# policy: a failure sets status tool-failed and warns; the next step decides
# whether that fails the job.
set -eo pipefail

key="${ANTHROPIC_API_KEY-}"
unset ANTHROPIC_API_KEY

plain_name() { [[ "$1" =~ ^[A-Za-z0-9._/][A-Za-z0-9._/-]*$ ]] && [[ "$1" != -* ]]; }
is_sha() { [[ "$1" =~ ^[0-9a-f]{40}$ ]]; }

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
case "$REVIEW" in
  auto | off | required) ;;
  *)
    echo "::error title=OpenQodex input::review must be auto, off or required"
    exit 1
    ;;
esac
if ! [[ "$CLAUDE_CODE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "::error title=OpenQodex input::claude-code-version must be a version number such as 2.1.289"
  exit 1
fi

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
[ -n "$base" ] || no_base=" This event gives no base to measure the change from, so OpenQodex uses its default scope."

# Review mode or scan mode. `note` is the one line that says, in scan mode,
# why there is no review or how to turn it on. The review never runs on
# pull_request_target: that event hands the repository's secrets to a
# workflow run on code from forks.
mode=scan
review_status=off
note=""
if [ "$REVIEW" = "off" ]; then
  note="The review is off: the workflow sets review: off."
elif [ "$EVENT_NAME" = "pull_request_target" ]; then
  note="The review never runs on pull_request_target, which hands the repository's secrets to code from forks, so this job runs the scanners only."
elif [ "$EVENT_NAME" != "pull_request" ] && [ "$EVENT_NAME" != "push" ]; then
  note="The review runs on pull_request and push events only, so this job runs the scanners only."
elif [ -n "$key" ] || [ "$REVIEW" = "required" ]; then
  mode=review
else
  note="To run the full review in this job, set ANTHROPIC_API_KEY on this step from a repository secret; GitHub gives no secrets to a pull request from a fork."
fi

if [ "$mode" = "review" ]; then
  if [ -n "$key" ]; then who="on the repository's Anthropic API key"; else who="on this runner's Claude Code login"; fi
  echo "OpenQodex review: this job runs the full review of the change, with Claude Code ${CLAUDE_CODE_VERSION} as the reviewer, ${who}.${no_base}"
else
  echo "OpenQodex scanners only: this job runs the scanners on the change and is not a review. The full review runs on your machine with openqodex review.${no_base}"
  echo "$note"
fi

out_dir="$(mktemp -d "${RUNNER_TEMP}/openqodex-XXXXXX")"
sarif=""
err="${out_dir}/stderr.txt"
# npx and npm run from out_dir, never from the checkout: there npm would read
# the pull request's .npmrc (its own registry) and could run an openqodex the
# pull request committed under node_modules. OpenQodex gets the checkout as --cwd.
repo_dir="$PWD"

# The last non-empty line of a file, safe inside a workflow command: one
# line, no control characters, no %, no run of colons.
last_line() {
  { grep -v '^[[:space:]]*$' "$1" || true; } | tail -n 1 | tr -d '\000-\037\177' | sed -e 's/%/%25/g' -e 's/::*/:/g' | cut -c 1-300
}

# A line for a workflow command: the same rules as last_line.
command_text() {
  printf '%s' "$1" | tr -d '\000-\037\177' | sed -e 's/%/%25/g' -e 's/::*/:/g' | cut -c 1-300
}

# A line for the job summary: one line, every character markdown or HTML
# gives meaning to escaped, so text from the pull request makes no structure.
summary_text() {
  printf '%s' "$1" | tr -d '\000-\037\177' | sed -e 's/[]\`*_[()!<>#|~\\]/\\&/g' | cut -c 1-600
}

# In a pull request the config comes from the base branch unless the workflow
# says head: the pull request's own config could hide findings. Whatever goes
# wrong, OpenQodex gets an explicit config (empty: the built-in defaults),
# never the pull request's own file. The review's custom instructions follow
# the same rule: the base branch's .openqodex/custom-instructions.md, or none.
config_args=()
instructions_args=()
if [ "$EVENT_NAME" = "pull_request" ] || [ "$EVENT_NAME" = "pull_request_target" ]; then
  if [ "$CONFIG_FROM" = "base" ]; then
    base_config="${out_dir}/base-config.yaml"
    base_instructions="${out_dir}/base-instructions.md"
    : > "$base_config"
    : > "$base_instructions"
    if ! plain_name "$BASE_REF"; then
      echo "::warning title=OpenQodex config::the base branch name is not a plain branch name, so OpenQodex uses the built-in defaults"
    elif ! git fetch --no-tags --quiet origin "refs/heads/${BASE_REF}:refs/remotes/origin/${BASE_REF}"; then
      echo "::warning title=OpenQodex config::could not fetch the base branch, so OpenQodex uses the built-in defaults, not the pull request's config"
    else
      git show "refs/remotes/origin/${BASE_REF}:.openqodex/config.yaml" > "$base_config" 2>/dev/null ||
        git show "refs/remotes/origin/${BASE_REF}:.openqodex.yaml" > "$base_config" 2>/dev/null ||
        : > "$base_config"
      git show "refs/remotes/origin/${BASE_REF}:.openqodex/custom-instructions.md" > "$base_instructions" 2>/dev/null ||
        : > "$base_instructions"
    fi
    config_args=(--config "$base_config")
    instructions_args=(--instructions "$base_instructions")
  fi
fi

# Claude Code at the pinned version: the claude on PATH when it is that
# version and lives outside the checkout, else a copy installed from npm into
# the runner's temporary folder, never over a Claude Code the runner has.
claude_prefix="${RUNNER_TEMP}/openqodex-claude-code"
claude_version() { (cd "$out_dir" && "$1" --version 2>/dev/null) | head -n 1 | cut -d ' ' -f 1; }
use_claude_code() {
  local found found_dir checkout
  found="$(command -v claude || true)"
  case "$found" in
    /*) ;;
    *) found="" ;;
  esac
  # Compared as physical paths, so a PATH folder reached through a link into
  # the checkout is still inside it.
  if [ -n "$found" ]; then
    checkout="$(pwd -P)"
    found_dir="$(cd "$(dirname "$found")" 2>/dev/null && pwd -P)" || found_dir=""
    case "${found_dir}/" in
      "${checkout}"/* | /) found="" ;;
    esac
  fi
  if [ -n "$found" ] && [ "$(claude_version "$found")" = "$CLAUDE_CODE_VERSION" ]; then return 0; fi
  if [ "$(claude_version "${claude_prefix}/bin/claude")" != "$CLAUDE_CODE_VERSION" ]; then
    echo "Installing Claude Code ${CLAUDE_CODE_VERSION} from npm"
    (cd "$out_dir" && npm install --global --prefix "$claude_prefix" --no-audit --no-fund "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}") >&2 || return 1
  fi
  [ "$(claude_version "${claude_prefix}/bin/claude")" = "$CLAUDE_CODE_VERSION" ] || return 1
  PATH="${claude_prefix}/bin:${PATH}"
  export PATH
}

# The reviewer's web tools are off in the Action: `reviewer_web: off` in the
# user config of the OpenQodex home folder this run reads (OPENQODEX_HOME
# when set). The file is put back as it was when the review ends, so a
# self-hosted runner keeps its own settings.
oq_home="${OPENQODEX_HOME:-${HOME}/.openqodex}"
user_config="${oq_home}/config.yaml"
saved_config="${out_dir}/user-config.yaml"
had_config=""
web_off() {
  mkdir -p "$oq_home"
  if [ -f "$user_config" ]; then
    cp -p "$user_config" "$saved_config"
    had_config=1
  fi
  {
    if [ -n "$had_config" ]; then grep -v -E '^reviewer_web[[:space:]]*:' "$saved_config" || true; fi
    echo "reviewer_web: off"
  } > "$user_config"
  trap put_back_config EXIT
}
put_back_config() {
  if [ -n "$had_config" ]; then cp -p "$saved_config" "$user_config"; else rm -f "$user_config"; fi
  trap - EXIT
}

# The fields of this run's report.json, one per line: complete or incomplete;
# 1 when a finding (or a candidate nobody checked) meets the block severity;
# the reviewer and its version; what is missing.
read_report() {
  node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const c = r.completion || {};
const order = ["info", "nitpick", "minor", "major", "critical"];
const at = order.indexOf(r.block_on_severity);
const severities = (r.findings || []).map((f) => f.severity).concat((r.not_reviewed || []).map((n) => n.reviewSeverity));
const blocking = r.verdict === "blocked" || (at >= 0 && severities.some((s) => order.indexOf(s) >= at));
const line = (s) => String(s).replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 300);
const who = c.reviewer ? `${c.reviewer.driver} ${c.reviewer.version}` : "";
const complete = c.status === "complete" && r.verdict !== "incomplete";
process.stdout.write([complete ? "complete" : "incomplete", blocking ? "1" : "0", line(who), line((c.missing || []).join("; "))].join("\n") + "\n");
' "$1"
}

# Why no reviewer started: the first reason the review printed under "Full
# review unavailable", else its last line.
unavailable_reason() {
  local r
  r="$(awk '/^Full review unavailable/ { f = 1; next } f && /^- / { sub(/^- /, ""); print; exit }' "$1" || true)"
  [ -n "$r" ] || r="$(last_line "$1")"
  printf '%s' "$r"
}

npx_openqodex() { (cd "$out_dir" && npx -y "openqodex@${OPENQODEX_VERSION}" "$@" --cwd "$repo_dir"); }

set +e
npx_openqodex doctor --install "${config_args[@]}" 2> >(tee "$err" >&2)
code=$?
wait
scan_failed=""
run_scan=""
review_reason=""
reviewer=""
summary_file=""
if [ "$code" != "0" ]; then
  code=2
  scan_failed=1
  if [ "$mode" = "review" ]; then
    review_status=unavailable
    review_reason="the scanner install failed, so neither the review nor the scan ran"
  fi
elif [ "$mode" = "scan" ]; then
  run_scan=1
elif ! use_claude_code; then
  review_status=unavailable
  review_reason="Claude Code ${CLAUDE_CODE_VERSION} could not be installed from npm"
  run_scan=1
else
  report_dir="${out_dir}/review"
  review_err="${out_dir}/review-stderr.txt"
  rargs=(review "${config_args[@]}" "${instructions_args[@]}" --reviewer claude --report-dir "$report_dir")
  if [ -n "$base" ]; then rargs+=(--base "$base"); fi
  if [ -n "$BLOCK_ON_SEVERITY" ]; then rargs+=(--block-on-severity "$BLOCK_ON_SEVERITY"); fi
  web_off
  # The one command that gets the key, in its environment only (never on a
  # command line, where other processes could read it).
  if [ -n "$key" ]; then
    (cd "$out_dir" && ANTHROPIC_API_KEY="$key" npx -y "openqodex@${OPENQODEX_VERSION}" "${rargs[@]}" --cwd "$repo_dir") 2> >(tee "$review_err" >&2)
  else
    (cd "$out_dir" && npx -y "openqodex@${OPENQODEX_VERSION}" "${rargs[@]}" --cwd "$repo_dir") 2> >(tee "$review_err" >&2)
  fi
  rc=$?
  wait
  put_back_config
  # Only this run's own folder is read: a report the pull request committed
  # under .openqodex/ is never looked at.
  fields=""
  if [ -f "${report_dir}/report.json" ]; then fields="$(read_report "${report_dir}/report.json")" || fields=""; fi
  if [ -n "$fields" ]; then
    { IFS= read -r status_field; IFS= read -r blocking; IFS= read -r reviewer; IFS= read -r missing; } <<< "$fields"
    sarif="${report_dir}/report.sarif"
    summary_file="${report_dir}/report.md"
    if [ "$status_field" = "complete" ]; then
      review_status=complete
      if [ "$blocking" = "1" ]; then code=1; else code=0; fi
    else
      # An incomplete review keeps its partial report, and the scan runs too,
      # so a scanner finding still counts: the reviewer may have stopped
      # before it checked any. A blocking finding in either fails the job.
      review_status=incomplete
      review_reason="${missing:-the review is incomplete}"
      if [ "$blocking" = "1" ]; then code=1; else code=2; fi
      run_scan=1
    fi
  elif [ "$rc" = "0" ] && [ ! -e "${report_dir}/report.json" ]; then
    review_status=skipped
    code=0
  else
    review_status=unavailable
    review_reason="$(unavailable_reason "$review_err")"
    [ -n "$review_reason" ] || review_reason="exit code $rc"
    run_scan=1
  fi
fi

if [ -n "$run_scan" ]; then
  # The scan's SARIF is the one uploaded: after a review that did not
  # complete, it is the whole set of scanner findings.
  review_code="$code"
  sarif="${out_dir}/openqodex.sarif"
  scan_dir="${out_dir}/scan"
  args=(scan "${config_args[@]}" --format sarif --output "$sarif")
  if [ "$mode" = "review" ]; then args+=(--report-dir "$scan_dir"); fi
  if [ -n "$base" ]; then args+=(--base "$base"); fi
  if [ -n "$BLOCK_ON_SEVERITY" ]; then args+=(--block-on-severity "$BLOCK_ON_SEVERITY"); fi
  npx_openqodex "${args[@]}" 2> >(tee "$err" >&2)
  code=$?
  wait
  # Anything but 0 and 1 (a crash, a kill: 137, 139, 143) is a tool error.
  if [ "$code" != "0" ] && [ "$code" != "1" ]; then
    code=2
    scan_failed=1
  fi
  # In review mode the result is the worse of the review and the scan: a
  # blocking finding from either is 1, and a review that did not complete is
  # a tool failure (2) otherwise.
  if [ "$mode" = "review" ]; then
    if [ "$code" = "1" ] || [ "$review_code" = "1" ]; then code=1; else code=2; fi
  fi
fi
set -e

echo "exit-code=$code" >> "$GITHUB_OUTPUT"
if [ "$code" = "0" ]; then
  echo "status=passed" >> "$GITHUB_OUTPUT"
elif [ "$code" = "1" ]; then
  echo "status=blocked" >> "$GITHUB_OUTPUT"
else
  echo "status=tool-failed" >> "$GITHUB_OUTPUT"
fi
if [ "$review_status" = "complete" ]; then echo "reviewed=true" >> "$GITHUB_OUTPUT"; else echo "reviewed=false" >> "$GITHUB_OUTPUT"; fi
echo "review-status=${review_status}" >> "$GITHUB_OUTPUT"
echo "reviewer=$(command_text "$reviewer")" >> "$GITHUB_OUTPUT"

if [ -n "$scan_failed" ]; then
  reason="$(last_line "$err")"
  [ -n "$reason" ] || reason="exit code $code"
  echo "::warning title=OpenQodex did not run::${reason}"
  echo "OpenQodex did not run: ${reason}" >> "$GITHUB_STEP_SUMMARY"
fi
if [ "$review_status" = "incomplete" ] || [ "$review_status" = "unavailable" ]; then
  echo "::warning title=OpenQodex review did not complete::$(command_text "$review_reason")"
fi

# The job summary: this run's report as it wrote it, or one line on why
# there is none.
{
  case "$review_status" in
    complete)
      head -c 1000000 "$summary_file"
      ;;
    incomplete)
      echo "**The review did not complete:** $(summary_text "$review_reason")"
      echo
      echo "The partial report of this run follows. Its findings passed every check, but the change was not fully reviewed."
      echo
      head -c 500000 "$summary_file"
      echo
      echo "The scanner findings below come from a separate scan, because the review did not complete."
      echo
      if [ -f "${scan_dir}/report.md" ]; then head -c 500000 "${scan_dir}/report.md"; fi
      ;;
    unavailable)
      echo "**The review did not complete:** $(summary_text "$review_reason")"
      echo
      if [ -n "$run_scan" ]; then echo "This job ran the scanners only instead."; fi
      ;;
    skipped)
      echo "OpenQodex review: nothing to review. The change has no file left after the config's exclusions."
      ;;
    off)
      if [ -n "$key" ] || [ "$REVIEW" = "required" ]; then echo "$note"; fi
      ;;
  esac
  if [ "$REVIEW" = "required" ] && [ "$review_status" != "complete" ] && [ "$review_status" != "skipped" ]; then
    echo
    echo "review: required is set, and this job has no complete review, so the job fails."
  fi
} >> "$GITHUB_STEP_SUMMARY"
if [ "$REVIEW" = "required" ] && [ "$review_status" != "complete" ] && [ "$review_status" != "skipped" ]; then
  echo "::error title=OpenQodex review required::this job has no complete review (review-status ${review_status})"
fi

if [ -n "$sarif" ] && [ -f "$sarif" ]; then
  echo "sarif=true" >> "$GITHUB_OUTPUT"
  echo "sarif-file=$sarif" >> "$GITHUB_OUTPUT"
else
  echo "sarif=false" >> "$GITHUB_OUTPUT"
fi
