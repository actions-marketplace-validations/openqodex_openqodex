---
"openqodex": patch
---

The Java graph dispatches calls through the first type parameter bound.
Generic class arguments supply method result types, so `Box<Repo>.get().find()` binds to `Repo.find`.
Raw and external generic results remain unresolved.
