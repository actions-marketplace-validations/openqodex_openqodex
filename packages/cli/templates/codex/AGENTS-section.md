<!-- openqodex:start -->
## Review before push (OpenQodex)
OpenQodex is open source code review that runs scanners on the change and guides your own review before it is pushed.
Before any `git push`, and when asked to review the changes, run `npx -y openqodex@{{VERSION}} review --agent` and follow the openqodex skill (`npx -y openqodex@{{VERSION}} guide` prints it).
Write findings to the path the brief names, run `npx -y openqodex@{{VERSION}} review --finalize`, then show the developer the verdict and the report in `.openqodex/reviews/`.
If scanners cannot install inside the sandbox, ask the developer to run `npx openqodex doctor --install` once in their own terminal.
Do not push when the verdict is `blocked` unless the developer says so after seeing the findings.
<!-- openqodex:end -->
