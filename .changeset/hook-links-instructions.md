---
"openqodex": patch
---

The push hook no longer follows links when it copies the repo's settings into its temporary checkout, so a pushed commit cannot make it write or delete a file outside that checkout, and a linked settings file in your checkout is skipped.
A pushed commit's own `.openqodex` folder never reaches the push scan, and run files under `.openqodex` that are links are no longer read, so a link to an endless file cannot hang a push; a linked `.openqodex/.gitignore` stops the scan with a one-line message.
Custom instructions are shown to the review agent as quoted text that can only widen or narrow what is flagged; a candidate dropped because of them says so in its reason.
