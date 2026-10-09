// `openqodex mcp`: the code graph's MCP tool server on stdio, for the agent
// that starts it (`init` registers it). Standard output carries the
// protocol only; everything else goes to standard error.
import { OpenQodexError } from "@openqodex/core";
import { runStdio } from "@openqodex/mcp";
import { EXIT_OK } from "../exit-codes.js";

export async function run(args: string[]): Promise<number> {
  let repo: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--repo") repo = args[++i];
    else if (a.startsWith("--repo=")) repo = a.slice("--repo=".length);
    else throw new OpenQodexError(`unknown argument: ${a}; usage: openqodex mcp [--repo <dir>]`);
    if (repo === undefined || repo === "") throw new OpenQodexError("--repo needs a folder");
  }
  await runStdio({ version: __OPENQODEX_VERSION__, cwd: process.cwd(), repo });
  return EXIT_OK;
}
