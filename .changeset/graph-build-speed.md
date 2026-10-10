---
"openqodex": patch
---

- The code graph builds faster: each JavaScript or TypeScript file's parse tree is walked once for the call graph and the Express, React and Next.js plugins (the Django, Rails, FastAPI and Go readers keep their own walk), a node of the tree is read only where a rule needs it, and each file's project and Rails application are looked up once per build. On this repository a build with no kept facts takes about 1.4 times as long as before the framework plugins (it took 1.7 times), and a build from kept facts about 1.4 times (it took 1.7 times).
- The kept facts in `.openqodex/graph/` are smaller: the Express plugin keeps a variable's value only where it can read it (16.4 MB on this repository, from 22.2 MB). The plugin interface is now version 4 and the Express plugin version 7, so the first build after the update parses every file again.
