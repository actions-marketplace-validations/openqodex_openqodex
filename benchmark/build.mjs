#!/usr/bin/env node
// Builds one benchmark case into a folder, to read or to review by hand:
//   node benchmark/build.mjs <case> [folder]
// With no folder, a new temp folder. Prints the repository's path.
import { resolve } from "node:path";
import { buildCase, listCases } from "./lib/cases.mjs";

const [id, into] = process.argv.slice(2);
if (!id || !listCases().includes(id)) {
  console.error(`usage: node benchmark/build.mjs <case> [folder]\ncases: ${listCases().join(", ")}`);
  process.exit(2);
}
const { dir } = buildCase(id, into === undefined ? undefined : resolve(into));
console.log(dir);
