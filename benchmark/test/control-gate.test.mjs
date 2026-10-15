// Failure list, written before implementation:
// 1. One of the five Git read commands with arguments is denied.
// 2. Shell operators, substitutions, redirections or other commands are allowed.
// 3. Newlines, comments, expansions or malformed quoting evade command parsing.
// 4. A Git argument writes output or enables an external diff helper.
// 5. Malformed JSON, missing commands or the wrong hook event or tool pass.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const gate = fileURLToPath(new URL("../lib/control-gate.mjs", import.meta.url));
const input = (command) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
function decision(stdin) {
  const result = spawnSync(process.execPath, [gate], { input: stdin, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  const output = JSON.parse(result.stdout).hookSpecificOutput;
  expect(output.hookEventName).toBe("PreToolUse");
  expect(output.permissionDecisionReason).toMatch(/^[^\r\n]+$/);
  return output.permissionDecision;
}

for (const command of ["git diff --stat -- 'src/a b.ts'", "git status --short", "git log -5 --oneline", 'git show HEAD -- "src/a b.ts"', "git rev-parse --show-toplevel"]) it(`allows ${command}`, () => {
  expect(decision(JSON.stringify(input(command)))).toBe("allow");
});
for (const command of ["git diff; id", "git diff && id", "git diff | id", "git diff $(id)", "git diff `id`", "cat x", "ls", "git push", "git diff > f", "git diff & id", "git diff < f", "git diff\nid", "git diff\rstatus", "git diff # comment", "git diff *.ts", "git diff {a,b}", "git diff (id)", "git diff 'unfinished", 'git diff "unfinished', "git diff\\", "git -c alias.diff=push diff", "git diff --output=f", "git log --output f", "git show --ext-diff", "git diff --textconv"]) it(`denies ${JSON.stringify(command)} with a reason`, () => {
  expect(decision(JSON.stringify(input(command)))).toBe("deny");
});
for (const [name, stdin] of [["malformed JSON", "{"], ["null input", "null"], ["a missing command", JSON.stringify(input(undefined))], ["a non-string command", JSON.stringify(input(["git", "diff"]))], ["the wrong tool", JSON.stringify({ ...input("git diff"), tool_name: "Read" })], ["the wrong event", JSON.stringify({ ...input("git diff"), hook_event_name: "PostToolUse" })]]) it(`denies ${name} with a reason`, () => {
  expect(decision(stdin)).toBe("deny");
});
