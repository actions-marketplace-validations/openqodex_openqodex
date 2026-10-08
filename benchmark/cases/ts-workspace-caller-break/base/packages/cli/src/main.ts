import { currentBranch } from "./branch.js";
import { changedFiles } from "./status.js";

const root = process.cwd();
const branch = await currentBranch(root);
if (branch === null) {
  console.error("not a git repository");
  process.exit(1);
}
const files = await changedFiles(root);
console.log(`${branch}: ${files.length} changed files`);
