# The Action's review mode: ways it can fail

Written before the tests. Each test of the review mode names the lines it guards ("R" and the number). `packages/cli/test/action.test.ts` runs the script without a reviewer, `packages/cli/test/total-review.test.ts` runs the new `review` flags with a stand-in model, and `tests/e2e/action-review.test.ts` runs the script with the real Claude Code.

1. A pull request commits files under `.openqodex/reviews/` and a `.openqodex/latest.json` that look like a complete, passing review, and the Action shows them, uploads them or reports `reviewed=true`.
2. A pull request changes `.openqodex/custom-instructions.md` to tell the reviewer to pass everything, and the review reads the pull request's text as the owners' instructions.
3. A pull request changes `.openqodex/config.yaml` or `.openqodex.yaml` to exclude files, disable scanners or lower the block severity, and the review reads that file.
4. The API key reaches `doctor`, the scanner install, the Claude Code install, a fallback `scan` or a scanner process.
5. The key appears in the job log, the job summary, an output, or a file under the runner's temporary folder.
6. The review ends incomplete (a timeout, a reviewer error, an answer that fails its checks) and the job reports `reviewed=true` or `review-status=complete`.
7. An incomplete review that left a report is replaced by the scan, so the findings that passed every check are lost from the job summary or the verdict.
8. No reviewer can start (no key and no login, or Claude Code fails to install), and the job shows no scanner findings and no reason.
9. The change is empty after the config's exclusions, and `review: required` fails the job, or the outputs claim a review ran.
10. The workflow runs on `pull_request_target`, and the Action reviews a fork's code with the repository's key.
11. A blocking finding comes with an incomplete review, and `fail-on-tool-error: false` lets the job pass.
12. `review: required` is set, this run has no complete review, and the job passes.
13. A wrong `review` or `claude-code-version` value is taken silently.
14. `review: auto` with no key runs anything but the scanner path of earlier versions, or its message does not say how to turn the review on.
15. The reviewer keeps its web tools in the Action because `reviewer_web: off` was written to a folder OpenQodex does not read (`OPENQODEX_HOME`).
16. The Action leaves the runner's own `config.yaml` in the OpenQodex home folder changed after the job (a self-hosted runner keeps its home folder).
17. Claude Code runs at a version other than the pinned one, or the script runs a `claude` program that the checkout holds.
18. The `block-on-severity` input is ignored in review mode.
19. Text from the pull request (a file name, a finding title, a reviewer's message) writes a workflow command or markdown structure into the annotation or the job summary.
20. The outputs `reviewed`, `review-status` and `reviewer` are missing, or say a review ran when it did not.
21. npm runs in the checkout, so the pull request's `.npmrc` points `npx` at a registry of its own, or a committed `node_modules` supplies the `openqodex` that runs, and that program gets the key.
22. The reviewer stops before any answer passes its checks (a timeout, an error, a refused key), so the partial report holds no findings, and a secret the scanners found is neither shown nor counted, where the scanners-only mode fails the job on it at the block severity.
