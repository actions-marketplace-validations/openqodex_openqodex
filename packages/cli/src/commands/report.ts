// `openqodex report "<what went wrong>"`: the developer or the agent reports a
// problem. It prints the issue it would create and the two choices; nothing
// is sent. `openqodex report --send-last` sends the last issue shown, exactly
// as it was shown.
import { OpenQodexError } from "@openqodex/core";
import { EXIT_OK } from "../exit-codes.js";
import { offer, readLast, sendIssue } from "../feedback.js";
import { parseFlags } from "../flags.js";

const USAGE = 'usage: openqodex report "<what went wrong>" | openqodex report --send-last';

export async function run(args: string[]): Promise<number> {
  const { global, bools, positionals } = parseFlags(args, {
    bools: ["--send-last"],
    positionals: 1,
    globals: ["--cwd"],
  });
  if (bools.has("--send-last")) {
    if (positionals.length > 0) throw new OpenQodexError(USAGE);
    const issue = await readLast(global.cwd);
    if (issue === null) throw new OpenQodexError("no problem report has been shown here, so there is nothing to send");
    process.stdout.write(`${await sendIssue(issue)}\n`);
    return EXIT_OK;
  }
  const words = positionals[0]?.trim() ?? "";
  if (words === "") throw new OpenQodexError(USAGE);
  await offer({ code: "developer-report", component: "report", diagnostic: words }, "report", [], global.cwd);
  return EXIT_OK;
}
