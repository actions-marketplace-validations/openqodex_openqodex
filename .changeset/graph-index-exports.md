---
"openqodex": minor
---

The library exports the graph's questions and its index files: `query`, `querySliced`, `OPERATIONS`, `SLICE_CHECKS`, `parseTarget`, `resolveTarget`, `prepareIndexes`, `writeIndex`, `readIndex`, `readIndexFrom`, `assemble`, `INDEX_FORMAT`, `serializeModel`, `deserializeModel`, `graphOf`, `floorReasons`, `hotSymbols` and `isTestPath`, with their types. A program builds a graph, saves the files `writeIndex` returns anywhere, reads them back with `readIndexFrom` and asks every question over the result. `writeIndex` now includes `projects.json`, so the files it returns are enough on their own.
