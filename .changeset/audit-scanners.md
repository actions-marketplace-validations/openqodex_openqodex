---
"openqodex": minor
---

Scanners now download only where a repository's files call for them. `doctor --install` inside a repository installs the scanners its files need, less `scanners.disable` and `review.paths.exclude`, and prints why for each one; `doctor --install --all-scanners` installs every scanner, as `doctor --install` did before. `init` honours the config the same way, prints one line per scanner it downloads, such as `brakeman: Rails app in backend/`, and `init --dry-run` prints those lines without downloading. The GitHub Action installs what the repository needs and keys its cache on the pinned scanner versions and those scanners, so a release that pins nothing new reuses the cache.

Each changed file now belongs to its nearest project, read from that project's manifests as text. brakeman runs only for a file in a Rails app (rails in the `Gemfile` or `Gemfile.lock`, and `config/application.rb` or `bin/rails`), from that app's folder, so a Rails app in `backend/` is scanned and a React Native app's CocoaPods `Gemfile` no longer pulls in brakeman. rubocop no longer runs for a `Gemfile` alone and loads its Rails cops only in a Rails app. oxlint runs its React, accessibility and Next.js rules in projects that depend on them, and then the reviewer is no longer handed the `useEffect` dependency pattern oxlint already checks. ruff adds its Django, FastAPI and Airflow rules in those projects. shellcheck checks an extensionless script whose first line names sh or bash. `scan.json` records the projects of the change.

osv-scanner moves to 2.6.0 and reads `bun.lock`, `uv.lock`, `pdm.lock`, `pylock.toml`, the NuGet lockfiles and more; it no longer gets `go.sum`, which it cannot read and which stopped the whole lockfile check. It sends dependency names and versions to osv.dev only: its deps.dev and file-hash lookups are off. Aliased advisories are one finding, and a lockfile with no package is no longer a failure.

oxlint moves to 1.86.0 and installs from its GitHub release, checked against its sha256, with no npm. semgrep, bandit, brakeman and rubocop install from lock files shipped in the package that name every dependency at one version with its sha256, and each download is checked against it, so their dependencies no longer float between machines. brakeman now asks for Ruby 3.0 or newer, which its pinned gem needs.

The README and docs now say which scanners download when, and every trivy example passes `--disable-telemetry --skip-version-check --skip-check-update`.
