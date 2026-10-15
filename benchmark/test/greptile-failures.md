# W8-2 failure list

Written before the implementation and tests.

1. An upstream fix replaces the reconstructed defect-bearing pull request. Reject a repository, pull request, base or head that differs from the pinned run metadata. Prove the accepted case against a real clone and its trees.
2. A case loses one truth set or merges the original Greptile label with Augment's corrections. Reject missing sets, missing sources and incorrect counts or hashes. Read both sets from separately pinned raw files.
3. A case changes without changing the suite hash. Hash every case input, including title, body, commits and both truth sets, in a stable order. Re-ingesting unchanged pins must keep the hash.
4. Martian verification passes on equal totals while a comment belongs to another case or has changed. Compare all case identities and each comment to the published results at the pinned revision. Name the case and comment number on every mismatch, including a missing or extra comment.
5. A source changes after ingestion. Check every raw file against its sha256 pin, and refuse a missing file in offline mode.
6. A title joins the wrong corrected row, a run link is duplicated, or a source loses a case. Require one matching title per repository and exactly ten cases per repository, fifty overall.
7. A previous split moves cases during re-ingestion. Refuse a split rewrite that moves or drops an existing case.
