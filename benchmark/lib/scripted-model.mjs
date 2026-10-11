// The scripted model: a model provider that answers from a script file, for
// tests and dry runs of the server path. It is the benchmark's only stand-in
// (run.mjs --reviewers model:scripted), built on the same idea as the
// library's own fixture model (packages/review/test/fixture-model.ts): it
// reads the brief and answers with a submission for the change and the
// candidates the brief names. It makes no network call and reads no file
// after its script.
//
// A script (version 1) holds every field below, and no other:
//   model       the name it is asked for by (the ModelReviewer's model)
//   served      the name it says answered each call, or null to name none
//   prices      { input, cachedInput, output }, dollars per million tokens,
//               which the run's budget prices its calls at (zero by default)
//   summary     the answer's summary
//   findings    findings the answer raises, in the submission's shape
//   dropReason  the reason each candidate the brief names is dropped with
//   reply       null for the submission above, or a text sent as every
//               answer in its place (an answer that fails its checks)
//
// Failure list, written before the code:
// 1. A script with a misspelt field runs as if the field were not there: an
//    unknown field, or a field of the wrong type, refuses the script.
// 2. Its usage could pass the worst case the budget reserved, which stops
//    the run as an overrun: input tokens are a quarter of the request's
//    characters (the budget reserves three bytes per character), and output
//    tokens never pass the call's maxOutputTokens.
// 3. It reports the model asked for as the one that answered: it reports
//    `served`, or no served model when the script says null.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The script model:scripted reads when no other is named. */
export const DEFAULT_SCRIPT = fileURLToPath(new URL("./scripted-model.json", import.meta.url));

/** What a scripted call costs when its script names no prices. */
export const SCRIPTED_PRICES = Object.freeze({ input: 0, cachedInput: 0, output: 0 });

const isPrice = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;

const FIELDS = {
  version: (v) => v === 1,
  model: (v) => typeof v === "string" && v !== "",
  served: (v) => v === null || (typeof v === "string" && v !== ""),
  prices: (v) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).every((k) => ["input", "cachedInput", "output"].includes(k)) && ["input", "cachedInput", "output"].every((k) => isPrice(v[k])),
  summary: (v) => typeof v === "string",
  findings: (v) => Array.isArray(v) && v.every((f) => f !== null && typeof f === "object" && !Array.isArray(f)),
  dropReason: (v) => typeof v === "string" && v !== "",
  reply: (v) => v === null || typeof v === "string",
};

/** Why a script cannot be run, one line per problem; empty when it can. */
export function scriptProblems(script) {
  if (script === null || typeof script !== "object" || Array.isArray(script)) return ["the script is not a JSON object"];
  const out = [];
  for (const key of Object.keys(script)) if (!(key in FIELDS)) out.push(`the script has a field ${JSON.stringify(key)}, which is not one of ${Object.keys(FIELDS).join(", ")}`);
  for (const [key, ok] of Object.entries(FIELDS)) if (!ok(script[key])) out.push(`the script's ${key} is missing or not what a version 1 script holds`);
  return out;
}

/** A script file, checked: { script, sha256 }. Throws naming each problem. */
export function readScript(path = DEFAULT_SCRIPT) {
  const bytes = readFileSync(path);
  let script;
  try {
    script = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`refused: the scripted model's script ${path} is not JSON`);
  }
  const problems = scriptProblems(script);
  if (problems.length > 0) throw new Error(`refused: the scripted model's script ${path} cannot be run: ${problems.join("; ")}`);
  return { script, sha256: createHash("sha256").update(bytes).digest("hex") };
}

// The submission for the change and the candidates the brief names: every
// candidate dropped with the script's reason, at its own line, and the
// script's findings raised.
function recorded(brief, script) {
  const id = /`change_id`: `([0-9a-f]{12})`/.exec(brief)?.[1] ?? "missing";
  const dropped = [...brief.matchAll(/^- (c\d+) \[([^\]]+)\] ([^:\s]+):(\d+) /gm)].map((m) => ({ candidate: m[1], reason: script.dropReason, file_path: m[3], line_number: Number(m[4]) }));
  return JSON.stringify({ version: 2, change_id: id, summary: script.summary, findings: script.findings, dropped });
}

/**
 * A ModelReviewer that answers from `script` (checked first). Every call is
 * an answer: it calls no tool.
 */
export function createScriptedReviewer(script, { maxOutputTokens = 32000 } = {}) {
  const problems = scriptProblems(script);
  if (problems.length > 0) throw new Error(`refused: the scripted model's script cannot be run: ${problems.join("; ")}`);
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0) throw new Error("refused: maxOutputTokens must be a whole number above 0");
  const p = script.prices;
  return {
    kind: "model",
    model: script.model,
    maxOutputTokens,
    async complete(request) {
      const brief = request.messages.find((m) => m.role === "user")?.text ?? "";
      const text = script.reply ?? recorded(brief, script);
      const chars = JSON.stringify(request.messages).length + JSON.stringify(request.tools ?? []).length;
      const inputTokens = Math.ceil(chars / 4);
      const outputTokens = Math.min(Math.ceil(text.length / 4), request.maxOutputTokens);
      return {
        message: { text, toolCalls: [] },
        usage: {
          model: script.model,
          ...(script.served !== null ? { servedModel: script.served } : {}),
          inputTokens,
          outputTokens,
          cacheReadTokens: 0,
          costUsd: (inputTokens * p.input + outputTokens * p.output) / 1e6,
        },
      };
    },
  };
}
