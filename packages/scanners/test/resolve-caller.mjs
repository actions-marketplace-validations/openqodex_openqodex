// A separate caller process for toolchain.test.ts: `resolve <tool> <budgetMs>`
// resolves a tool, prints the result and exits. The install runs in the
// built openqodex CLI, which the toolchain finds beside this package.
import { createToolResolver } from "../dist/index.js";

const [command, tool, budget] = process.argv.slice(2);
if (command === "resolve") {
  const resolve = createToolResolver({ allowInstall: true, installBudgetMs: budget === "null" ? null : Number(budget) });
  process.stdout.write(JSON.stringify(await resolve(tool)));
}
