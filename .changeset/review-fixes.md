---
"openqodex": patch
---

- A large review no longer ends incomplete because Claude Code, as the reviewer, tried to read back a long search result it had saved in its own configuration folder. A read of the output saved for that review's session counts as the agent's own; a read of anything else in that folder still makes the review incomplete.
- A large review no longer ends incomplete because of a deletion the brief had no room for. The correction round now shows the removed lines between the two lines around the deletion, and the round no longer promises that ranges it can never send will follow.
- `review.paths.exclude` now applies to both paths of a renamed file. A file renamed out of an excluded folder is reviewed as a new file, without the excluded file's removed lines, and a file renamed into an excluded folder is reviewed as a deleted file.
