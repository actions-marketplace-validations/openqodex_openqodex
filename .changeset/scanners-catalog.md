---
"openqodex": minor
---

Nine new built-in scanners, twenty-two in all. Each is pinned to one version, checked against its sha256 or a hash-locked lock file, and runs only when the change holds a file it reads.
- zizmor 1.30.1 checks GitHub workflows, action files and the Dependabot config for security problems, such as a pull request title expanded into a script or a `pull_request_target` workflow that runs the pull request's code. It runs offline.
- squawk 2.66.0 checks Postgres migrations for steps that lock or rewrite a busy table, such as an index built without `CONCURRENTLY` or a `NOT NULL` column with no default.
- SQLFluff 4.3.0 checks SQL for queries that return a wrong result or hold dead code, on eight rules only and with no templating, so no code from the repository runs.
- trivy 0.75.0 runs its misconfiguration checks on changed Terraform, Kubernetes and CloudFormation files. It is never handed a Terraform folder that calls a module it would download, and the report names such a folder.
- Checkov 3.3.22 runs its own checks on the same files. It loads no `.checkov.yaml` from the repository or your home, so no external Python check runs, and it sends nothing.
- TFLint 0.64.0 runs the core Terraform rules with OpenQodex's own settings: no plugin, no `.tflint.hcl` from the repository, and no value it evaluates in a finding.
- kube-linter 0.8.3 checks changed Kubernetes manifests, each finding on the line of the field it names.
- kubeconform 0.8.0 checks changed Kubernetes objects against pinned schemas it downloads once from raw.githubusercontent.com. `--offline` skips it.
- cargo-deny 0.20.2 checks a changed `Cargo.lock` against the RustSec advisory database, which it fetches from github.com. It needs your own Cargo and never downloads crates. `--offline` skips it.
- A suppression a change adds for zizmor, squawk, SQLFluff, trivy, Checkov, TFLint or kube-linter (an ignore comment, `checkov:skip`, `tflint-ignore`, a kube-linter ignore annotation) is shown as a finding for the reviewer to check, as for the existing scanners. kubeconform and cargo-deny obey no inline marker.
- One problem that several scanners report on the same lines is shown once, the higher severity, naming the other scanners: a workflow script injection from semgrep, actionlint and zizmor, a RustSec advisory from osv-scanner and cargo-deny, and nine missing settings that trivy and Checkov both check.
- A changed `pyproject.toml`, `setup.cfg`, `tox.ini` or `pep8.ini` is now compared by what ruff or SQLFluff reads from it, so a setting written in another form, such as an escaped TOML key or a `[DEFAULT]` key, raises the settings note, and a version bump in `[project]` still raises none.
- The demo repository plants a Postgres migration that blocks writes, an SSH port open to the internet in Terraform and a privileged Kubernetes container.
- The benchmark gains four cases for the new scanners: workflow security, Postgres migrations, Terraform open to the internet and Kubernetes host access.
