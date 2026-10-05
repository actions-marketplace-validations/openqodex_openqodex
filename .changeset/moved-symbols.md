---
"openqodex": patch
---

The blast radius no longer reports a function that moved to another file as "removed, still called". It lists it as "moved to" its new file, and a move does not raise the risk.
A call to a function loaded with `await import()` inside another function is now traced to that function. Before, it counted as a call to a removed function of the same name in the caller's own file.
A name bound by destructuring, such as `const { a } = x` or a parameter `{ a }`, now hides a function of the same name, so its calls are no longer traced to that function.
A file that git sees as renamed is now checked: a caller that still imports the old path is reported as "removed, still called".
