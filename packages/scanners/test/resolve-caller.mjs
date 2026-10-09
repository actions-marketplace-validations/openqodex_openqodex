// A separate caller process for toolchain.test.ts: `resolve <tool> <budgetMs>`
// resolves a tool, prints the result and exits. Like the CLI, it names the
// built openqodex bin as the program that runs each install.
import { fileURLToPath } from "node:url";
import { createToolResolver, setInstallWorkerEntry } from "../dist/index.js";

const [command, tool, budget] = process.argv.slice(2);
if (command === "resolve") {
  setInstallWorkerEntry(fileURLToPath(new URL("../../cli/dist/bin.js", import.meta.url)));
  const resolve = createToolResolver({ allowInstall: true, installBudgetMs: budget === "null" ? null : Number(budget) });
  process.stdout.write(JSON.stringify(await resolve(tool)));
}
