// A small program shaped like the CLI: `__install <tool>` runs one install,
// `resolve <tool> <budgetMs>` resolves a tool, prints the result and exits.
// It never sets the worker entry, so the resolver's default (this program
// itself) is what starts the install.
import { createToolResolver, runInstallWorker } from "../dist/index.js";

const [command, tool, budget] = process.argv.slice(2);
if (command === "__install") {
  process.exitCode = await runInstallWorker(tool);
} else if (command === "resolve") {
  const resolve = createToolResolver({ allowInstall: true, installBudgetMs: budget === "null" ? null : Number(budget) });
  process.stdout.write(JSON.stringify(await resolve(tool)));
}
