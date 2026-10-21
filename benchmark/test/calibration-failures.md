# W8-3 failure cases

Written before implementation.

1. A comparison accepts less than 90 percent agreement on either published class.
2. A comparison accepts a calibration from another product build.
3. A judge sees published vendor labels before returning its verdicts.
4. A missing, duplicate or extra vendor label silently changes the denominator.
5. Greptile pools its original truth with Augment's corrected comments.
6. A malformed model answer becomes a missed bug.
7. Martian reports its default F2 instead of the cited Core F1 row.
8. Martian silently skips a golden comment absent from the published evaluations.
9. Aggregate agreement hides the class counts or an empty class.
10. A calibration's claimed agreement differs from its saved label counts.
11. A calibration reference uses another board, prompt or judge.
12. Calibration runs on changed upstream pipeline bytes.
13. The relay omits usage, making cost look like zero.
14. Public GitHub reviews use unauthenticated requests despite an authenticated gh session, or pagination drops comments.
