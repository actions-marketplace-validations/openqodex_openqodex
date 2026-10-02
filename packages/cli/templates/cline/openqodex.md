# Review before push with OpenQodex

Before any `git push`, and whenever you are asked to review the changes, review the change with OpenQodex:

1. Run `npx -y openqodex@{{VERSION}} review --agent` from the repository and read the brief it prints.
2. Follow the openqodex skill for the rest of the review: verify each scanner candidate, write your findings to the path the brief names, then run `npx -y openqodex@{{VERSION}} review --finalize`. If the skill is not loaded, run `npx -y openqodex@{{VERSION}} guide` to print it.
3. Show the developer the verdict and the report path. When the verdict is `blocked`, do not push unless the developer says so after seeing the findings.

Never edit code during the review, never run `openqodex trust` without asking the developer, and never set `OPENQODEX_SKIP`.
