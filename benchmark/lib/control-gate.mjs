// Failure cases are listed in test/control-gate.test.mjs before this code.
import { readFileSync } from "node:fs";

// Accept literal shell words only. Quotes and escapes may group arguments,
// but shell expansion, comments and control syntax never reach Bash.
function words(command) {
  if (typeof command !== "string" || /[\r\n\0`$<>|;&]/.test(command)) return null;
  const args = [];
  let word = "", quote = null, started = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote !== null) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && ['"', "\\"].includes(command[i + 1])) word += command[++i];
      else word += c;
    } else if (c === " " || c === "\t") {
      if (started) { args.push(word); word = ""; started = false; }
    } else if (c === "'" || c === '"') {
      quote = c; started = true;
    } else if (c === "\\") {
      if (i + 1 === command.length) return null;
      word += command[++i]; started = true;
    } else {
      if (!/[A-Za-z0-9_./:@%+=,^-]/.test(c)) return null;
      word += c; started = true;
    }
  }
  if (quote !== null) return null;
  if (started) args.push(word);
  return args;
}

let allowed = false;
try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const args = words(input?.tool_input?.command);
  allowed = input?.hook_event_name === "PreToolUse" && input?.tool_name === "Bash"
    && args?.[0] === "git" && ["diff", "status", "log", "show", "rev-parse"].includes(args[1])
    && !args.slice(2).some((arg) => /^--(?:out|ext-diff|textconv)/.test(arg));
} catch { /* Malformed input is denied with the same one-line reason. */ }

// https://code.claude.com/docs/en/hooks#pretooluse-decision-control
process.stdout.write(`${JSON.stringify({ hookSpecificOutput: {
  hookEventName: "PreToolUse",
  permissionDecision: allowed ? "allow" : "deny",
  permissionDecisionReason: allowed ? "One Git read command allowed." : "Only one git diff, status, log, show or rev-parse read command with literal arguments is allowed; shell syntax, output files and external helpers are denied.",
} })}\n`);
