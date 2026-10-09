---
"openqodex": minor
---

- The code graph follows calls through interfaces, abstract classes and base classes. A call on a value typed by an interface or a base type binds to the member it declares, and each implementation or override that may run instead is listed as a possible caller of that call. Before, a change to a class behind an interface listed no caller, and a call through `this` or `self` in a base class never reached the subclasses that override it.
- Each language's own lookup order picks the method: Python's method resolution order (so a diamond picks the class Python picks), Go's shallowest embedding and its method sets, Ruby's prepend, include and extend order. A Go type implements an interface when its methods cover it by name, and a Python class a Protocol the same way.
- A function passed to an in-repo function that calls that parameter, a local given one function and then called, an entry of a literal table called by a computed key, and a function returned by name and then called are listed as possible callers. A wrapper that never calls what it is given is not.
- The brief lists possible callers apart from certain and likely ones, at most 20 inline, and never counts them as callers; a possible caller makes the list a floor. It also lists where the touched code is used as a value or named as a type, and what implements or overrides it.
- A call through an interface keeps at most 32 possible implementations, and says how many it left out. A call through a TypeScript interface says that an object of the same shape may answer it without declaring `implements`.
- The review's packet gives each caller its level and counts per level, and adds `implementers/` and `references/` pages for each touched symbol.
- Text from the repository in the brief's graph block, such as a file name with a line break in it, stays on its own line and opens no markdown: names are code spans, paths and notes are escaped (#71).
