---
"openqodex": patch
---

The push hook no longer follows links when it copies the repo's settings into its temporary checkout, so a pushed commit cannot make it write or delete a file outside that checkout.
A pushed commit's own `.openqodex` folder never reaches the push scan.
OpenQodex never reads or writes `.openqodex/` or the root `.openqodex.yaml` through a symbolic link at any level: a link there stops `init`, `init --uninstall`, `report`, `hook check`, `hook pre-push` and `review --finalize` with one line, or counts as no file for a run receipt, instead of reading or writing outside the repository.
`--config` and `--output` that name a path under `.openqodex/` follow the same rule, and the message for a linked path says to replace the link with a real file.
Files under `.openqodex/` and the config are read only when they are regular files within a size limit, so a link to a device or a named pipe can no longer hang a push or a review.
The line `hook install` prints for husky, lefthook or a hook it did not write now ends in `|| [ $? -ne 1 ]`, so only a finding at the block threshold stops the push and a tool failure never does.
Custom instructions are shown to the review agent as quoted text that can only widen or narrow what is flagged; a candidate dropped because of them says so in its reason.
