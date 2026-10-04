{{INSTRUCTIONS}}

How to run the review, before any `git push` and whenever you are asked to review the changes:

1. Run `npx -y openqodex@{{VERSION}} review` from the repository. It takes one to three minutes: allow it up to ten minutes, or run it in the background and wait for it to exit. If the skill is not loaded, run `npx -y openqodex@{{VERSION}} guide` to print it.
2. Show the developer the report it prints, exactly as printed, without rewording it.
3. When the verdict is `blocked` (exit 1), do not push unless the developer says so after seeing the findings. Exit 2 means there is no complete review: tell the developer what the output says is missing.

Never edit code during the review, never run `openqodex trust` without asking the developer, and never set `OPENQODEX_SKIP`.
