// The Codex driver, fed a real recorded run. The fixture
// (fixtures/codex-stream.jsonl) is the --json output of one short real
// `codex exec` run with the driver's command line and web search on
// (codex-cli 0.160.0, 2026-10-04): a failed command, a command that read the
// file, a web search, a first message, the final answer and the usage. The
// snapshot path is written as __SNAPSHOT__. The process that prints it is the
// model provider stand-in: a script that replays recorded lines and exits,
// started by the real driver, read by the real parser.
//
// Ways it could fail, written before the code:
//  1. The final answer is taken from an earlier message, or the usage is lost.
//  2. A message followed by a failed turn counts as an answer.
//  3. A stream that ends with no terminal event counts as an answer.
//  4. A nonzero exit after a finished turn counts as an answer.
//  5. A correction round, which is a new run, does not carry the brief, the
//     previous answer and the correction, in that order.
//  6. The process group is left running after the deadline or after close.
//  7. An answer past the size limit is held and checked.
//  8. Web off still gives the model web search; web on gives shell commands
//     network.
//  9. A token of the developer's, or a variable that ties the reviewer to a
//     running Codex session, reaches the reviewer.
// 10. Inside Codex's own sandbox, detection reports Codex as ready, so the
//     run starts a reviewer that dies at once instead of offering the fallback.
// 11. A Codex older than the tested version is started with flags it may not know.
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CODEX_TESTED, codexArgs, codexDriver, codexEnv, detectCodex, olderThanTested } from "../src/reviewers/codex.js";
import { DEPTH_ENV } from "../src/reviewers/driver.js";

const here = dirname(fileURLToPath(import.meta.url));
const RECORDED = readFileSync(join(here, "fixtures/codex-stream.jsonl"), "utf8");
const lines = RECORDED.trim().split("\n");
const COMPLETED = lines[lines.length - 1]!;

// A stand-in `codex` that reads its whole prompt, saves it, starts a child
// of its own, prints `body` (a JavaScript expression of the text, evaluated
// in the stand-in), then exits with `code`, or stays alive when `code` is null.
function standIn(body: string, code: number | null = 0): string {
  const dir = mkdtempSync(join(tmpdir(), "oq-codex-stand-in-"));
  const bin = join(dir, "codex");
  writeFileSync(
    bin,
    [
      `#!${process.execPath}`,
      "const { spawn } = require('node:child_process');",
      "const { appendFileSync, realpathSync } = require('node:fs');",
      "const snapshot = realpathSync(process.cwd());",
      "let prompt = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (c) => (prompt += c));",
      "process.stdin.on('end', () => {",
      "  appendFileSync(__filename + '.prompts', JSON.stringify(prompt) + '\\n');",
      "  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "  appendFileSync(__filename + '.pids', `${process.pid} ${child.pid} `);",
      `  process.stdout.write(${body}, () => { ${code === null ? "setInterval(() => {}, 1000);" : `process.exit(${code});`} });`,
      "});",
      "",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return bin;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const pidsOf = (bin: string) => (existsSync(`${bin}.pids`) ? readFileSync(`${bin}.pids`, "utf8").trim().split(" ").map(Number) : []);
const promptsOf = (bin: string) => readFileSync(`${bin}.prompts`, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string);
const snap = () => realpathSync(mkdtempSync(join(tmpdir(), "oq-codex-snap-")));
const settle = () => new Promise((done) => setTimeout(done, 200));

async function runOnce(bin: string, deadlineMs = 30_000) {
  const session = codexDriver.start({ snapshotDir: snap(), deadline: Date.now() + deadlineMs, bin, web: false });
  const turn = await session.send("Review this.");
  await session.close();
  await settle();
  return { turn, pids: pidsOf(bin) };
}

const text = (s: string) => JSON.stringify(s);

describe("the Codex stream reader, on a recorded run", () => {
  it("1. takes the last message as the answer, the usage from turn.completed, and the commands and search the stream shows", async () => {
    const bin = standIn(`${text(RECORDED)}.split('__SNAPSHOT__').join(snapshot)`);
    const { turn, pids } = await runOnce(bin);
    expect(turn.failure).toBeNull();
    expect(JSON.parse(turn.finalText)).toEqual({ bug: "calc.py's add(a, b) returns a - b instead of a + b, so it subtracts rather than adds.", searched: true });
    expect(turn.usage).toEqual({ turns: 1, input_tokens: 52911, output_tokens: 207, cost_usd: null });
    expect(turn.calls.map((c) => [c.tool, c.ok])).toEqual([
      ["shell", false],
      ["shell", true],
      ["web_search", true],
    ]);
    expect(turn.calls[2]!.input).toEqual({ query: "python operator module add" });
    expect(pids.filter(alive)).toEqual([]);
  });

  it("2. a message followed by a failed turn is no answer", async () => {
    const failed = JSON.stringify({ type: "turn.failed", error: { message: "stream disconnected before completion" } });
    const bin = standIn(text([...lines.filter((l) => !l.includes('"turn.completed"')), failed, ""].join("\n")));
    const { turn } = await runOnce(bin);
    expect(turn.finalText).toBe("");
    expect(turn.failure).toMatch(/stopped with an error \(stream disconnected/);
  });

  it("3. a stream that ends with no terminal event is no answer", async () => {
    const bin = standIn(text([...lines.filter((l) => !l.includes('"turn.completed"')), ""].join("\n")));
    const { turn } = await runOnce(bin);
    expect(turn.finalText).toBe("");
    expect(turn.failure).toMatch(/without finishing its turn/);
  });

  it("4. a nonzero exit after a finished turn is no answer", async () => {
    const bin = standIn(text(RECORDED), 1);
    const { turn } = await runOnce(bin);
    expect(turn.finalText).toBe("");
    expect(turn.failure).toMatch(/exited \(exit 1\) before it answered/);
  });

  it("5. a correction round is a new run carrying the brief, the previous answer and the correction, in that order, and the usage adds up", async () => {
    const bin = standIn(text(RECORDED));
    const session = codexDriver.start({ snapshotDir: snap(), deadline: Date.now() + 30_000, bin, web: false });
    const first = await session.send("THE BRIEF");
    const second = await session.send("THE CORRECTION");
    await session.close();
    const prompts = promptsOf(bin);
    expect(prompts[0]).toBe("THE BRIEF");
    const p = prompts[1]!;
    const at = [p.indexOf("THE BRIEF"), p.indexOf(first.finalText), p.indexOf("THE CORRECTION")];
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(second.usage).toEqual({ turns: 2, input_tokens: 2 * 52911, output_tokens: 2 * 207, cost_usd: null });
    await settle();
    expect(pidsOf(bin).filter(alive)).toEqual([]);
  });

  it("6. a reviewer that never ends is stopped at the deadline with its whole group", async () => {
    const bin = standIn(text(""), null);
    const { turn, pids } = await runOnce(bin, 1_500);
    expect(turn.failure).toMatch(/timed out/);
    expect(pids.length).toBe(2);
    expect(pids.filter(alive)).toEqual([]);
  });

  it("7. an answer past the limit ends the turn as a failure", async () => {
    const bin = standIn(`JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'a'.repeat(3 * 1024 * 1024) } }) + '\\n' + ${text(COMPLETED)} + '\\n'`);
    const { turn, pids } = await runOnce(bin);
    expect(turn.failure).toMatch(/answer over/);
    expect(turn.finalText).toBe("");
    expect(pids.filter(alive)).toEqual([]);
  }, 60_000);
});

describe("the Codex command line and environment", () => {
  it("8. web off disables web search; web on uses the cached search; shell commands get no network either way", () => {
    const off = codexArgs("/snap", false);
    const on = codexArgs("/snap", true);
    expect(off).toContain('web_search="disabled"');
    expect(on).not.toContain('web_search="disabled"');
    expect(on).toContain('web_search="cached"');
    for (const args of [off, on]) {
      expect(args.join(" ")).not.toMatch(/network/);
      expect(args).toContain('default_permissions="openqodex_review"');
      expect(args[args.indexOf("-C") + 1]).toBe("/snap");
    }
  });

  it("9. the environment keeps what Codex needs and drops tokens and session ties", () => {
    const env = codexEnv({ PATH: "/bin", HOME: "/h", CODEX_HOME: "/h/.codex", GITHUB_TOKEN: "t", OPENAI_API_KEY: "k", CODEX_THREAD_ID: "x", CODEX_SANDBOX: "seatbelt", CLAUDECODE: "1" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", CODEX_HOME: "/h/.codex", [DEPTH_ENV]: "1" });
  });

  it("10. inside Codex's own sandbox, detection says Codex cannot start and runs nothing", async () => {
    const d = await detectCodex("/nowhere", { CODEX_SANDBOX: "seatbelt", PATH: "" });
    expect(d).toMatchObject({ ok: false, missing: expect.stringMatching(/inside its own sandbox/) });
  });

  it("11. a Codex older than the tested version is refused", () => {
    expect(olderThanTested("0.159.9")).toBe(true);
    expect(olderThanTested("0.99.0")).toBe(true);
    expect(olderThanTested(CODEX_TESTED)).toBe(false);
    expect(olderThanTested("0.161.0")).toBe(false);
    expect(olderThanTested("1.0.0")).toBe(false);
  });
});
