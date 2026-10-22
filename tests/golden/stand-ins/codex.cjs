// Model provider stand-in, using the stream test's complete stdin and JSON events.
const { cpSync, existsSync, readFileSync, realpathSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex-cli 0.160.0"); process.exit(0); }
if (args[0] === "login") { console.log("Logged in using ChatGPT"); process.exit(0); }
// The provider binary also answers the driver's preflight command. Only the
// inside file and completion marker are returned. This scripted provider is
// not a test of the real Codex operating system sandbox.
if (args[0] === "sandbox") {
  const sh = args.lastIndexOf("sh");
  process.stdout.write(readFileSync(args[sh + 1], "utf8"));
  console.log(args[sh + 4]);
  process.exit(0);
}
const folder = dirname(__filename);
const snapshot = realpathSync(process.cwd());
writeFileSync(join(folder, "snapshot-path"), snapshot);
// A copy of the snapshot as the reviewer is given it, after the run took its
// hash: the harness checks that hash and records it normalised. A correction
// round starts the provider again and keeps the first copy.
const copy = join(folder, "snapshot");
try { cpSync(snapshot, copy, { recursive: true, force: false, errorOnExist: false, filter: (path) => path !== join(snapshot, ".git") }); }
catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error; }
// Answers are derived from the brief's ids and frozen planted locations.
// The quotes come from the snapshot at those locations, never live scanners.
const frozen = JSON.parse(readFileSync(join(folder, "submission.json"), "utf8"));
let initialBrief = null;
let answerRound = 0;
function answerForPrompt(prompt) {
  initialBrief ??= prompt.split("## Your answer so far")[0];
  const brief = initialBrief;
  const first = brief.split("\n")[0];
  const kind = /verif/i.test(first) ? "verify" : /find/i.test(first) ? "find" : "single";
  answerRound++;
  const change_id = /`change_id`:\s*`([0-9a-f]+)`/.exec(brief)?.[1] ?? /["`]?change_id["`]?\s*[:=]\s*["`]?([0-9a-f]{12,64})/.exec(brief)?.[1] ?? frozen.change_id;
  if (kind === "single") return JSON.stringify({ ...frozen, change_id });
  const hunks = [...brief.matchAll(/^###\s+(h\d+)\s+(.+?)\s+(\d+)-(\d+)/gm)].map((m) => ({ id: m[1], file: m[2], start: Number(m[3]), end: Number(m[4]) }));
  if (kind === "find") {
    const unit = /\b(u\d+)\b/.exec(first)?.[1] ?? /(?:unit|review unit)[`"\s:*]+(u\d+)/i.exec(brief)?.[1];
    if (!unit) throw new Error("find brief has no unit id");
    const pass = /\b(local|contracts)\b/.exec(first)?.[1] ?? /(?:pass)[`"\s:*]+(local|contracts)/i.exec(brief)?.[1];
    if (!pass) throw new Error("find brief has no pass");
    if (process.env.OPENQODEX_STANDIN_FAIL_FINDER === `${unit}:${pass}`) throw new Error("selected finder fails in both sessions");
    const candidates = [];
    const seen = new Set();
    const list = existsSync(join(folder, "find-answers.json")) ? Object.values(JSON.parse(readFileSync(join(folder, "find-answers.json"), "utf8"))).flat() : frozen.findings;
    for (const f of list) {
      if (!hunks.some((h) => h.file === f.file_path && f.line_number >= h.start && f.line_number <= h.end)) continue;
      const key = `${f.file_path}:${f.line_number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const quote = readFileSync(join(snapshot, f.file_path), "utf8").split("\n")[f.line_number - 1];
      if (!quote?.trim()) continue;
      candidates.push({ severity: f.severity, category: f.category, confidence: 0.8, file_path: f.file_path, line_number: f.line_number, line_end: f.line_end, title: f.title, claim: f.problem, evidence: [{ file_path: f.file_path, line_number: f.line_number, quote }] });
    }
    return JSON.stringify({ version: "find-1", change_id, unit, examined: hunks.map((h) => h.id), analysis: hunks.map((h) => ({ hunk: h.id, changed: "The planted operation changes here.", could_break: "Unsafe inputs can affect this operation." })), candidates });
  }
  const candidates = new Map();
  // Prefer structured candidates when the brief renders them as JSON.
  for (const block of brief.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)) {
    let value;
    try { value = JSON.parse(block[1]); } catch { continue; }
    const walk = (v) => {
      if (!v || typeof v !== "object") return;
      if (/^[ck]\d+$/.test(v.id ?? "")) candidates.set(v.id, v);
      for (const child of Object.values(v)) if (child && typeof child === "object") { if (Array.isArray(child)) child.forEach(walk); else walk(child); }
    };
    walk(value);
  }
  // The scanner list keeps the single-pass candidate row format.
  for (const m of brief.matchAll(/^- ([ck]\d+) \[([^\]]+)\] ([^:\s]+):(\d+) /gm)) candidates.set(m[1], { id: m[1], file_path: m[3], line_number: Number(m[4]) });
  for (const m of brief.matchAll(/^###\s+([ck]\d+)\b([^\n]*)\n([\s\S]*?)(?=^###\s|$(?![\s\S]))/gm)) {
    if (candidates.has(m[1])) continue;
    const location = /([^\s`]+\.[a-zA-Z0-9]+):(\d+)/.exec(m[2] + "\n" + m[3]);
    if (location) candidates.set(m[1], { id: m[1], file_path: location[1], line_number: Number(location[2]) });
  }
  if (!candidates.size) throw new Error("verify brief has no candidate ids");
  const unresolved = process.env.OPENQODEX_STANDIN_UNRESOLVED_SCANNER === "1" && answerRound === 1;
  const verdicts = [...candidates].map(([id, c]) => {
    const details = c.candidate ?? c;
    const file_path = details.file_path ?? details.filePath;
    const line_number = details.line_number ?? details.lineStart;
    const template = frozen.findings.find((f) => f.file_path === file_path && f.line_number === line_number) ?? frozen.findings[0];
    return { id, verdict: unresolved && id.startsWith("c") ? "unresolved" : "confirmed", reason: "The planted operation is unsafe on this changed line.", severity: template.severity, confidence: 1, file_path, line_number, title: template.title, problem: template.problem, consequence: template.consequence, fix: template.fix, tier: "finding" };
  });
  for (const v of verdicts) {
    if (!v.id.startsWith("k")) continue;
    const scanner = verdicts.find((s) => s.id.startsWith("c") && s.file_path === v.file_path && s.line_number === v.line_number);
    if (scanner) v.duplicate_of = scanner.id;
  }
  return JSON.stringify({ version: "verify-1", change_id, verdicts });
}

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (part) => { prompt += part; });
process.stdin.on("end", () => {
  // Codex replays the transcript in a new process for each answer.
  answerRound = (prompt.match(/## openqodex replied to that answer/g) ?? []).length;
  const answer = answerForPrompt(prompt);
  const emit = (event) => console.log(JSON.stringify(event));
  emit({ type: "thread.started", thread_id: `golden-codex-session-${process.pid}` });
  emit({ type: "turn.started" });
  emit({ type: "item.completed", item: { id: "golden-read", type: "command_execution", command: "/bin/cat app/server.py", aggregated_output: readFileSync(join(snapshot, "app/server.py"), "utf8"), exit_code: 0, status: "completed" } });
  emit({ type: "item.completed", item: { id: "golden-answer", type: "agent_message", text: answer } });
  emit({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 500 } });
});
