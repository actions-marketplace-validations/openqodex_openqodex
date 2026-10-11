#!/usr/bin/env node
// The benchmark's model reviewer: the library's ModelReviewer contract
// (docs/library.md, packages/review/src/reviewer.ts) over the OpenAI
// Responses API, as Sid's Azure OpenAI resource serves it on its v1
// endpoint. Every model:<deployment> reviewer and the server path use it.
//
// Why the Responses API and not Chat Completions: Azure's model list
// (learn.microsoft.com, Foundry Models sold by Azure, page dated 2026-09-21,
// read 2026-10-11) gives gpt-6.1-sol "Functions, tools, and parallel tool
// calling (Responses API only)". The review loop is tool calls, so Chat
// Completions cannot carry it on this deployment.
//
// Failure list, written before the code:
// 1. A retry hidden inside complete: the provider bills two attempts and the
//    brain records one. complete makes exactly one fetch, follows no
//    Retry-After and no redirect, and throws on any failure (HTTP status, a dropped
//    connection, an answer that is not the Responses shape).
// 2. Tool call ids lost in mapping: each function_call carries the
//    library's tool call id as call_id, both ways, and each tool result is
//    a function_call_output with the same call_id and the brain's text as
//    it is (a refusal's text included). A function_call is sent back
//    without its item id: an fc_ id without its reasoning item is refused.
// 3. The key or base URL in a saved file, a log line or argv: they live only
//    in this closure and in the one request's header and URL; every thrown
//    message has both, and the host, replaced; nothing is printed except by
//    the probe, which prints neither.
// 4. The wrong header style: authHeader is required, "api-key" or "bearer",
//    never guessed.
// 5. Usage the contract cannot use: the served model is the response's
//    model; the cost is priced from prices.json with cached input at its
//    own rate and reasoning tokens inside output tokens (the Responses API
//    counts them there). A reply cut at max_output_tokens is billed, so it
//    is returned with its usage, not thrown away.
// 6. An unprobed id, a model without prices, or a key sent in clear: each is
//    a refusal when the reviewer is made.
//
// Not done here, by design: no prompt, rule, filter or retry of its own
// (the contract), no streaming, and no reasoning items carried between
// calls (the library's messages hold none; the model reasons afresh each
// call). Node's fetch gives up waiting for response headers after 300
// seconds; a call that long fails and is recorded as failed.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { baseUrlProblem, endpointSecrets, loadModelEnv, probedDeployment } from "./model-env.mjs";

const PRICES = new URL("../outside/prices.json", import.meta.url);
const AUTH_HEADERS = ["api-key", "bearer"];

const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

/**
 * A ModelReviewer for one deployment. `baseUrl` and `apiKey` come from
 * loadModelEnv (or a host that hands them in); `authHeader` is "api-key" or
 * "bearer"; `prices` is prices.json's shape (read from the file when left
 * out); `allowUnprobed` is for the session's probe only.
 */
export function createOpenAIReviewer({ model, baseUrl, apiKey, authHeader, maxOutputTokens = 32000, effort, prices, allowUnprobed = false } = {}) {
  if (typeof model !== "string" || model === "") throw new Error("refused: model must be a deployment name");
  probedDeployment(model, { allowUnprobed });
  if (typeof baseUrl !== "string" || baseUrlProblem(baseUrl) !== null) throw new Error(`refused: baseUrl ${typeof baseUrl === "string" ? baseUrlProblem(baseUrl) : "is missing"}`);
  if (typeof apiKey !== "string" || apiKey === "") throw new Error("refused: apiKey is missing");
  if (!AUTH_HEADERS.includes(authHeader)) throw new Error('refused: authHeader must be "api-key" or "bearer"');
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0) throw new Error("refused: maxOutputTokens must be a whole number above 0");
  if (effort !== undefined && (typeof effort !== "string" || effort === "")) throw new Error("refused: effort must be a reasoning effort level");
  const rates = (prices ?? JSON.parse(readFileSync(PRICES, "utf8")))?.models?.[model];
  if (rates === null || typeof rates !== "object") throw new Error(`refused: no prices for ${model} in prices.json, so its calls could not be priced`);

  const url = `${baseUrl.replace(/\/+$/, "")}/responses`;
  const headers = { "content-type": "application/json", ...(authHeader === "api-key" ? { "api-key": apiKey } : { authorization: `Bearer ${apiKey}` }) };
  const secrets = endpointSecrets(baseUrl, apiKey);
  const scrub = (text) => secrets.reduce((t, s) => t.split(s).join("[hidden]"), String(text));
  const fail = (message, extra = {}) => Object.assign(new Error(scrub(message).split("\n")[0].slice(0, 500)), extra);

  // Uncached input, cached input and output (reasoning included), each at
  // its own rate per million tokens. Null when a rate the call used is
  // unpriced: an unknown is never added as zero.
  const cost = (input, cached, output) => {
    const parts = [[input - cached, rates.input], [cached, rates.cachedInput], [output, rates.output]];
    if (parts.some(([n, rate]) => n > 0 && typeof rate !== "number")) return null;
    return parts.reduce((sum, [n, rate]) => sum + (n > 0 ? n * rate : 0), 0) / 1e6;
  };

  return {
    kind: "model",
    model,
    maxOutputTokens,
    async complete(request) {
      const body = JSON.stringify(requestBody(model, request, effort));
      let response;
      try {
        // One attempt: fetch itself never retries a request, and a redirect
        // is an error, never followed: following one sends the call, and
        // the key in its header, a second time and maybe to another origin.
        response = await fetch(url, { method: "POST", headers, body, redirect: "error" });
      } catch (error) {
        const cause = error?.cause?.code ?? error?.cause?.message ?? error?.message ?? String(error);
        // A refused connection, a dropped one, or Node's own wait for the
        // headers running out: the code says which.
        throw fail(`the request to the model endpoint failed: ${cause}`);
      }
      const text = await response.text().catch(() => "");
      if (!response.ok) {
        let code = null;
        let detail = text;
        try {
          const parsed = JSON.parse(text);
          code = typeof parsed?.error?.code === "string" ? parsed.error.code : null;
          detail = typeof parsed?.error?.message === "string" ? parsed.error.message : text;
        } catch {
          // not JSON: the text as it came
        }
        throw fail(`HTTP ${response.status}${code !== null && code !== String(response.status) ? ` (${code})` : ""}: ${detail}`, { status: response.status, code: code === null ? null : scrub(code) });
      }
      let answer;
      try {
        answer = JSON.parse(text);
      } catch {
        throw fail("the model endpoint's answer is not JSON");
      }
      if (answer?.status === "failed") throw fail(`the model endpoint answered status failed: ${answer?.error?.code ?? ""} ${answer?.error?.message ?? ""}`);
      const u = answer?.usage;
      const input = count(u?.input_tokens);
      const output = count(u?.output_tokens);
      if (input === null || output === null) throw fail("the model endpoint's answer has no usage");
      const cached = Math.min(count(u?.input_tokens_details?.cached_tokens) ?? 0, input);
      if (!Array.isArray(answer.output)) throw fail("the model endpoint's answer has no output");
      return {
        message: readOutput(answer.output),
        usage: {
          model,
          ...(typeof answer.model === "string" && answer.model !== "" ? { servedModel: answer.model } : {}),
          inputTokens: input,
          outputTokens: output,
          cacheReadTokens: cached,
          costUsd: cost(input, cached, output),
        },
      };
    },
  };
}

// The library's request as a Responses API request. The system messages
// become the instructions; the rest become input items in order.
function requestBody(model, request, effort) {
  const system = [];
  const input = [];
  for (const m of request.messages) {
    if (m.role === "system") system.push(m.text);
    else if (m.role === "user") input.push({ type: "message", role: "user", content: m.text });
    else if (m.role === "assistant") {
      if (m.text !== "") input.push({ type: "message", role: "assistant", content: m.text });
      for (const call of m.toolCalls) input.push({ type: "function_call", call_id: call.id, name: call.name, arguments: typeof call.args === "string" ? call.args : JSON.stringify(call.args) });
    } else if (m.role === "tool") input.push({ type: "function_call_output", call_id: m.toolCallId, output: m.text });
  }
  return {
    model,
    ...(system.length > 0 ? { instructions: system.join("\n\n") } : {}),
    input,
    // strict is set false: the Responses API makes a function strict by
    // default, and a strict schema must require every property, which the
    // brain's tools (optional line ranges, globs) do not.
    ...(request.tools.length > 0 ? { tools: request.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false })) } : {}),
    max_output_tokens: request.maxOutputTokens,
    ...(effort !== undefined ? { reasoning: { effort } } : {}),
    // Nothing is kept on the provider's side; no call refers to an earlier one.
    store: false,
  };
}

// The answer's output items as the library's message: the text of every
// message item (a refusal's text included), and every function call with
// its call_id. Arguments that are not JSON are handed on as the text the
// model gave; the brain's tools refuse them with a reason.
function readOutput(items) {
  let text = "";
  const toolCalls = [];
  for (const item of items) {
    if (item?.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part?.type === "output_text" && typeof part.text === "string") text += part.text;
        else if (part?.type === "refusal" && typeof part.refusal === "string") text += part.refusal;
      }
    } else if (item?.type === "function_call") {
      let args = item.arguments;
      try {
        args = JSON.parse(item.arguments);
      } catch {
        // kept as the model's text
      }
      toolCalls.push({ id: item.call_id, name: item.name, args });
    }
  }
  return { text, toolCalls };
}

// ---------- the session's probe ----------

const ECHO = {
  name: "echo",
  description: "Returns the text it is given.",
  parameters: { type: "object", properties: { text: { type: "string", description: "The text to return." } }, required: ["text"], additionalProperties: false },
};

/**
 * Two small calls to `model` through this adapter, on the settings file's
 * endpoint: the model must call the echo tool, then answer after its
 * result. Returns what boards.json records (the served model) and what the
 * calls cost. Prints nothing; never returns the key or the base URL.
 */
export async function probe(model, { env = process.env } = {}) {
  const settings = loadModelEnv({ env });
  const reviewer = createOpenAIReviewer({ model, baseUrl: settings.baseUrl, apiKey: settings.apiKey, authHeader: settings.authHeader, maxOutputTokens: 4000, effort: "low", allowUnprobed: true });
  const messages = [
    { role: "system", text: "You are a probe. Follow the user's instruction exactly." },
    { role: "user", text: "Call the echo tool once with the text openqodex. After its result, answer with that result and nothing else." },
  ];
  const call = (callId) => reviewer.complete({ callId, attempt: 1, purpose: "brief", messages, tools: [ECHO], maxOutputTokens: 4000 });
  const first = await call("probe-1");
  const echo = first.message.toolCalls.find((c) => c.name === "echo");
  const spent = [first.usage];
  const shape = { model, authHeader: settings.authHeader };
  if (echo === undefined) return { ok: false, reason: "the model did not call the tool", ...shape, servedModel: first.usage.servedModel ?? null, usage: spent };
  messages.push({ role: "assistant", text: first.message.text, toolCalls: first.message.toolCalls });
  for (const c of first.message.toolCalls) messages.push({ role: "tool", toolCallId: c.id, name: c.name, text: c === echo ? String(c.args?.text ?? "") : "refused: call echo once", ok: c === echo });
  const second = await call("probe-2");
  spent.push(second.usage);
  const ok = second.message.toolCalls.length === 0 && second.message.text.includes("openqodex");
  return { ok, ...(ok ? {} : { reason: "the model did not answer with the tool's result" }), ...shape, servedModel: second.usage.servedModel ?? first.usage.servedModel ?? null, usage: spent };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--probe") {
    process.stderr.write("Usage: node benchmark/lib/openai-reviewer.mjs --probe <deployment>\n");
    return 2;
  }
  const model = args[1];
  let result;
  try {
    result = await probe(model);
  } catch (error) {
    // Refusals are made before any call; anything else is a failed call.
    process.stderr.write(`probe failed: ${error.message}\n`);
    return error.message.startsWith("refused:") ? 2 : 1;
  }
  const sum = (k) => result.usage.reduce((t, u) => t + u[k], 0);
  const costs = result.usage.map((u) => u.costUsd);
  const line = {
    ok: result.ok,
    ...(result.ok ? {} : { reason: result.reason }),
    model,
    servedModel: result.servedModel,
    api: "responses",
    authHeader: result.authHeader,
    toolRoundTrip: result.ok,
    calls: result.usage.length,
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    costUsd: costs.includes(null) ? null : costs.reduce((t, c) => t + c, 0),
    at: new Date().toISOString(),
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
  if (!result.ok) {
    process.stderr.write(`probe failed: ${result.reason}\n`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
