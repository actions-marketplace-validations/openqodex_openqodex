---
"openqodex": patch
---

bandit no longer raises an assert (`B101`) in a test file, where assert is how a test checks its results; it still raises one in every other Python file, and its other checks still read test files.
