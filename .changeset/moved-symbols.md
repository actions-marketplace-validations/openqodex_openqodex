---
"openqodex": patch
---

The blast radius no longer reports a function that moved to another file as "removed, still called". It lists it as "moved to" its new file, and a move does not raise the risk.
A call to a function loaded with `await import()` inside another function is now traced to that function. Before, it counted as a call to a removed function of the same name in the caller's own file.
A name an import binds inside a function (`await import()`, `require`, or a Python import) now counts only in that function, so a call elsewhere in the file that is broken stays reported.
A name bound by destructuring, such as `const { a } = x`, a parameter `{ a }`, an assignment `({ a } = x)` or Python `a, b = pair`, now hides a function or an import of the same name, so its calls are no longer traced there.
A `let` or `const` declared in a block, a loop or a catch clause now hides a function of the same name only inside that block.
A method call on an object made from a class or a function that an import inside a function loaded is traced again, also after the code assigns that class name something else. A call on a name that the function declares later, such as one a closure uses before the declaration, follows that declaration, not an outer variable of the same name.
A file with thousands of nested blocks no longer slows the code graph down: calls nested more than 256 scopes deep are left unresolved.
A file that git sees as renamed is now checked: a caller that still imports the old path is reported as "removed, still called".
