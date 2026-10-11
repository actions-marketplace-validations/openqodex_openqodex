#!/usr/bin/env node
// The first name of benchmark/materialise.mjs, kept as an alias: it takes
// the same arguments, so `node benchmark/build.mjs <case> [folder]` still
// builds a case into a folder (a new temp folder when left out) and prints
// the repository's path.
import { main } from "./materialise.mjs";

process.exitCode = main();
