# Examples

## demo-repo

A tiny shop API (Flask, a deploy script, a Dockerfile, a lockfile and a GitHub workflow) with bugs planted on purpose, so you can watch OpenQodex find them. `openqodex demo [dir]` builds it for you:

1. copies `demo-repo/baseline/` into a new folder and commits it, so the baseline is the base of the change;
2. copies `demo-repo/planted/` over it and leaves those changes uncommitted;
3. runs the scan and prints what it found.

Then open the folder in your coding agent and ask it to review the change with OpenQodex.

The baseline is clean: every scanner that reads its files reports nothing. The planted change adds these bugs:

| File | Line | Bug | Found by |
|---|---|---|---|
| `app/config.py` | 2 | a live-looking Stripe secret key | gitleaks `stripe-access-token`, semgrep |
| `app/search.py` | 14 | SQL built with an f-string from the request (SQL injection) | bandit `B608`, semgrep |
| `Dockerfile` | 1 | `FROM python:latest`, an unpinned base image | hadolint `DL3007` |
| `Dockerfile` | 3 | `apt-get install` without `-y`, version pins, `--no-install-recommends` or cleanup | hadolint `DL3008`, `DL3015`, `DL3009`, `DL3014` |
| `Dockerfile` | 6 | `ADD` for a local file | hadolint `DL3020` |
| `Dockerfile` | 7 | `pip install` keeps its cache in the image | hadolint `DL3042` |
| `Dockerfile` | 11 | no `USER`, so the container runs as root | semgrep `missing-user` |
| `package-lock.json` | 11 | lodash 4.17.15, with known advisories (CVE-2020-8203 among them) | osv-scanner |
| `scripts/deploy.sh` | 7 | `rm -rf $DEPLOY_DIR/` unquoted: an empty variable deletes from `/` | shellcheck `SC2115`, `SC2086` |
| `scripts/deploy.sh` | 11 | a loop over unquoted `ls` output | shellcheck `SC2045`, `SC2086` |
| `.github/workflows/ci.yml` | 15 | the pull request title is pasted into a shell command (script injection) | actionlint `expression`, semgrep |
| `app/server.py` | 23 | pagination skips the first page (`page * PAGE_SIZE` with pages counted from 1) | no scanner: only a reviewer reading the code finds it |

`demo-repo/expected.json` holds the same list with exact rule ids, for the end-to-end test.

### The secret is generated

`planted/app/config.py` holds the placeholder `{{GENERATED_SECRET}}`, not a key. `openqodex demo` replaces it with `sk_live_` and 24 random letters and digits each time it builds the demo, so the key exists only in the demo folder on your machine. It is not a real key and works nowhere. No secret, real or fake, is committed to this repository.
