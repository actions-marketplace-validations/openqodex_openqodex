// `openqodex report "<what went wrong>"`: the developer or the agent reports a
// problem. It prints the issue it would create and the two choices; nothing
// is sent. `openqodex report --send-last` sends the last issue shown, exactly
// as it was shown.
import { OpenQodexError } from "@openqodex/core";
import { EXIT_OK } from "../exit-codes.js";
import { offer, readLast, redact, sendIssue } from "../feedback.js";
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
    if (typeof issue === "string") throw new OpenQodexError(issue);
    // What is sent is printed again first, so it is never a surprise.
    process.stderr.write(`Sending this issue:\nIssue title: ${issue.title}\nIssue body:\n${issue.body}\n`);
    process.stdout.write(`${await sendIssue(issue)}\n`);
    return EXIT_OK;
  }
  const words = positionals[0]?.trim() ?? "";
  if (words === "") throw new OpenQodexError(USAGE);
  // The words are the developer's own, so they are refused rather than
  // silently rewritten: nothing is shown or saved until they are clean.
  const found = [...redact(words).found];
  if (found.length > 0) {
    throw new OpenQodexError(`your words hold ${found.join(", ")}; remove it and run report again. Nothing was saved or sent.`);
  }
  await offer({ code: "developer-report", component: "report", diagnostic: words }, "report", [], global.cwd);
  return EXIT_OK;
}
