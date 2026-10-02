// Turns a custom scanner's `run` line into an argument list. No shell is ever
// involved: no variables, no globbing, no command separators, no ~.
import { OpenQodexError } from "@openqodex/core";
import { safeFileArgs } from "../safe-args.js";

// Splits on whitespace. Single quotes keep everything literally; double
// quotes keep everything except \" and \\; outside quotes a backslash keeps
// the next character.
export function splitCommand(line: string): string[] {
  const args: string[] = [];
  let cur = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && (line[i + 1] === '"' || line[i + 1] === "\\")) cur += line[++i];
      else cur += ch;
    } else if (/\s/.test(ch)) {
      if (started) args.push(cur);
      cur = "";
      started = false;
    } else {
      started = true;
      if (ch === "'" || ch === '"') quote = ch;
      else if (ch === "\\" && i + 1 < line.length) cur += line[++i];
      else cur += ch;
    }
  }
  if (quote) throw new OpenQodexError(`run line has an unclosed quote: ${line}`);
  if (started) args.push(cur);
  return args;
}

// `{target}` as a whole argument becomes one argument per target (a target
// that starts with "-" is passed as "./-name" so the tool reads it as a path);
// `{report}` and `{repo}` are replaced anywhere inside an argument.
export function expandArgs(args: string[], values: { report: string; repo: string; targets: string[] }): string[] {
  return args.flatMap((arg) =>
    arg === "{target}"
      ? safeFileArgs(values.targets)
      : [arg.replaceAll("{report}", values.report).replaceAll("{repo}", values.repo)],
  );
}
