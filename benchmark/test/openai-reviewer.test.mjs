// The benchmark's model adapter (benchmark/lib/openai-reviewer.mjs): the
// library's ModelReviewer over the Azure OpenAI v1 Responses API. The model
// provider is the only stand-in: a local HTTP server that answers in the
// Responses shape and keeps every request it gets. The brain's own loop
// (callModel) and the real tool definitions come from the built package.
//
// Failures guarded, written before the code:
// 1. A 429 (or any failed call) is retried inside complete: the provider
//    bills two attempts while the brain records one. Exactly one HTTP
//    request per complete, and complete throws.
//    A redirect is not followed: following it sends the call, and the key
//    in its header, a second time and possibly to another origin.
// 2. Tool call ids are lost in mapping: a recorded two-round conversation
//    does not carry the provider's call ids back on the second round, or a
//    refused tool result loses its text.
// 3. The key or the base URL lands in a saved file, a log line or argv: in
//    a thrown message the brain records, in the reviewer object, on stdout
//    or stderr, in the request URL, or on the probe's command line or
//    output; a key under four characters, or a quoted key padded with
//    spaces (sent trimmed, so echoed trimmed), is not hidden.
// 4. An api-key resource gets a bearer header (or the reverse) and every
//    call fails as unauthorised.
// 5. The usage is not what the contract asks: the served model is lost, or
//    the cost is null or priced wrong (cached input at the full rate,
//    reasoning tokens left out of output).
// 6. An unprobed model id, a model without prices, or a base URL that sends
//    the key in clear is used.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { inspect, promisify } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callModel, MODEL_SYSTEM, TOOL_DEFINITIONS } from "../../packages/review/dist/index.js";
import { loadModelEnv } from "../lib/model-env.mjs";
import { createOpenAIReviewer } from "../lib/openai-reviewer.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

// Made at run time, so no secret scanner reading this file takes it for a real key.
const KEY = `test-model-key-${randomBytes(16).toString("hex")}`;
const SERVED = "gpt-6.1-sol-2026-09-29";
const PRICES = JSON.parse(readFileSync(new URL("../outside/prices.json", import.meta.url), "utf8")).models["gpt-6.1-sol"];
const script = new URL("../lib/openai-reviewer.mjs", import.meta.url).pathname;

// The model provider stand-in. Each answer is { status, body, headers },
// "reset" to drop the connection, or a function of the request.
const servers = [];
async function provider(answers, { only } = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const request = { method: req.method, url: req.url, headers: req.headers, body: raw === "" ? null : JSON.parse(raw) };
    requests.push(request);
    if (only === "api-key" && req.headers["api-key"] !== KEY) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "401", message: "Access denied due to invalid subscription key or wrong API endpoint." } }));
      return;
    }
    const pick = answers[Math.min(requests.length - 1, answers.length - 1)];
    const answer = typeof pick === "function" ? pick(request) : pick;
    if (answer === "reset") {
      req.socket.destroy();
      return;
    }
    res.writeHead(answer.status ?? 200, { "content-type": "application/json", ...answer.headers });
    res.end(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  servers.push(server);
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}/openai/v1`, host: `127.0.0.1:${port}`, requests };
}
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});

let written = [];
beforeEach(() => {
  written = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (written.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (written.push(String(s)), true));
});
afterEach(() => vi.restoreAllMocks());

const USAGE = { input_tokens: 1200, input_tokens_details: { cached_tokens: 200 }, output_tokens: 300, output_tokens_details: { reasoning_tokens: 100 }, total_tokens: 1500 };

// A Responses API reply: a reasoning item, the text, then each tool call.
function reply({ text = "", calls = [], usage = USAGE, status = "completed" } = {}) {
  return {
    status: 200,
    body: {
      id: `resp_${randomBytes(6).toString("hex")}`,
      object: "response",
      status,
      model: SERVED,
      output: [
        { type: "reasoning", id: "rs_1", summary: [] },
        ...(text === "" ? [] : [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }]),
        ...calls.map((c, i) => ({ type: "function_call", id: `fc_${i}`, call_id: c.id, name: c.name, arguments: typeof c.args === "string" ? c.args : JSON.stringify(c.args), status: "completed" })),
      ],
      usage,
    },
  };
}

const reviewer = (baseUrl, extra = {}) => createOpenAIReviewer({ model: "gpt-6.1-sol", baseUrl, apiKey: KEY, authHeader: "api-key", allowUnprobed: true, ...extra });
const BRIEF = "Review the change. Answer with the JSON object.";
const request = (messages, extra = {}) => ({ callId: "primary-1", attempt: 1, purpose: "brief", messages, tools: structuredClone(TOOL_DEFINITIONS), maxOutputTokens: 32000, ...extra });
const firstRound = () => [{ role: "system", text: MODEL_SYSTEM }, { role: "user", text: BRIEF }];
const rejection = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected complete to throw");
};

describe("one transport attempt per call", () => {
  it("makes exactly one HTTP request for a 429, a 500 and a dropped connection, and throws each time", async () => {
    const limited = { status: 429, headers: { "retry-after": "1" }, body: { error: { code: "429", message: "Requests to the Responses API have exceeded call rate limit. Please retry after 1 second." } } };
    for (const answer of [limited, { status: 500, body: { error: { code: "server_error", message: "The server had an error." } } }, "reset"]) {
      const fake = await provider([answer, reply({ text: "a second attempt answered" })]);
      const error = await rejection(reviewer(fake.baseUrl).complete(request(firstRound())));
      expect(fake.requests).toHaveLength(1);
      if (answer === limited) {
        expect(error.message).toMatch(/HTTP 429/);
        expect(error.status).toBe(429);
      }
    }
  });

  it("is recorded by the brain as one failed attempt, matching the one request the provider bills", async () => {
    const fake = await provider([{ status: 429, body: { error: { code: "insufficient_quota", message: "You exceeded your current quota." } } }, reply({ text: "a second attempt answered" })]);
    const caller = callModel({ reviewer: reviewer(fake.baseUrl), role: "primary", now: Date.now });
    const called = await caller.call("brief", firstRound(), () => {});
    expect(called.failure).toMatch(/^the model call failed: HTTP 429 \(insufficient_quota\)/);
    expect(caller.attempts).toHaveLength(1);
    expect(caller.attempts[0]).toMatchObject({ attempt: 1, outcome: "failed", inputTokens: null });
    expect(fake.requests).toHaveLength(1);
  });

  it("throws on a redirect instead of sending the call, and its key, again to another origin", async () => {
    const elsewhere = await provider([reply({ text: "answered at the other origin" })]);
    const fake = await provider([{ status: 307, headers: { location: `${elsewhere.baseUrl}/responses` }, body: "" }]);
    const error = await rejection(reviewer(fake.baseUrl).complete(request(firstRound())));
    expect(error.message).toMatch(/^the request to the model endpoint failed/);
    expect(fake.requests).toHaveLength(1);
    expect(elsewhere.requests).toHaveLength(0);
  });
});

describe("a recorded two-round conversation", () => {
  it("keeps every tool call id, both ways, and passes a refused tool result's text through", async () => {
    const calls = [
      { id: "call_Xa71", name: "read_file", args: { path: "src/math.ts" } },
      { id: "call_Qb02", name: "search_code", args: { pattern: "add\\(" } },
    ];
    const answer = JSON.stringify({ version: 2, change_id: "abc123def456", summary: "Changes the sum.", findings: [], dropped: [] });
    const fake = await provider([reply({ text: "Reading the changed file first.", calls }), reply({ text: answer })]);
    const model = reviewer(fake.baseUrl, { effort: "low" });

    const round1 = firstRound();
    const first = await model.complete(request(round1));
    expect(first.message.toolCalls).toEqual(calls);
    expect(first.message.text).toBe("Reading the changed file first.");

    // The transcript as the brain extends it (model-loop.ts).
    const round2 = [
      ...round1,
      { role: "assistant", text: first.message.text, toolCalls: first.message.toolCalls },
      { role: "tool", toolCallId: "call_Xa71", name: "read_file", text: "1\texport const add = (a: number, b: number) => a - b;", ok: true },
      { role: "tool", toolCallId: "call_Qb02", name: "search_code", text: "refused: the pattern is not a valid regular expression", ok: false },
    ];
    const second = await model.complete(request(round2, { callId: "primary-2" }));
    expect(second.message).toEqual({ text: answer, toolCalls: [] });

    expect(fake.requests).toHaveLength(2);
    const sent = fake.requests[1];
    expect(sent.method).toBe("POST");
    expect(sent.url).toBe("/openai/v1/responses");
    expect(sent.body.model).toBe("gpt-6.1-sol");
    expect(sent.body.instructions).toBe(MODEL_SYSTEM);
    expect(sent.body.max_output_tokens).toBe(32000);
    expect(sent.body.reasoning).toEqual({ effort: "low" });
    expect(sent.body.store).toBe(false);
    expect(sent.body.input).toEqual([
      { type: "message", role: "user", content: BRIEF },
      { type: "message", role: "assistant", content: "Reading the changed file first." },
      // No item id: an fc_ id without its reasoning item is refused by the API.
      { type: "function_call", call_id: "call_Xa71", name: "read_file", arguments: JSON.stringify({ path: "src/math.ts" }) },
      { type: "function_call", call_id: "call_Qb02", name: "search_code", arguments: JSON.stringify({ pattern: "add\\(" }) },
      { type: "function_call_output", call_id: "call_Xa71", output: "1\texport const add = (a: number, b: number) => a - b;" },
      { type: "function_call_output", call_id: "call_Qb02", output: "refused: the pattern is not a valid regular expression" },
    ]);
    expect(sent.body.tools).toEqual(TOOL_DEFINITIONS.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false })));
  });

  it("hands the brain arguments that are not JSON as the text the model gave", async () => {
    const fake = await provider([reply({ calls: [{ id: "call_bad", name: "read_file", args: "{\"path\": \"src/ma" }] })]);
    const out = await reviewer(fake.baseUrl).complete(request(firstRound()));
    expect(out.message.toolCalls).toEqual([{ id: "call_bad", name: "read_file", args: "{\"path\": \"src/ma" }]);
  });
});

describe("the key and the base URL stay out of everything saved, logged or put on a command line", () => {
  it("leaves both out of a thrown message, even when the provider's error echoes them", async () => {
    const fake = await provider([(r) => ({ status: 401, body: { error: { code: "401", message: `Access denied: key ${r.headers["api-key"]} is not valid for http://${r.headers.host}/openai/v1` } } })]);
    const error = await rejection(reviewer(fake.baseUrl).complete(request(firstRound())));
    expect(error.message).toMatch(/HTTP 401/);
    for (const shown of [error.message, String(error.stack), inspect(error), JSON.stringify({ ...error })]) {
      expect(shown).not.toContain(KEY);
      expect(shown).not.toContain(fake.baseUrl);
      expect(shown).not.toContain(fake.host);
    }
  });

  it("hides a key of under four characters when the provider's error echoes it", async () => {
    const short = "k9z";
    const fake = await provider([(r) => ({ status: 401, body: { error: { code: "401", message: `Access denied: key ${r.headers["api-key"]} is not valid` } } })]);
    const error = await rejection(reviewer(fake.baseUrl, { apiKey: short }).complete(request(firstRound())));
    expect(fake.requests[0].headers["api-key"]).toBe(short);
    expect(error.message).toMatch(/HTTP 401/);
    expect(error.message).not.toContain(short);
  });

  it("hides a quoted key padded with spaces in the settings file, in the trimmed form the header sends and the provider echoes", async () => {
    const fake = await provider([(r) => ({ status: 401, body: { error: { code: "401", message: `Access denied: key ${r.headers["api-key"]} is not valid` } } })]);
    const file = join(tempDir("oq-model-env-"), "azure.env");
    writeFileSync(file, `AZURE_OPENAI_KEY="  ${KEY}\t "\nAZURE_OPENAI_BASE_URL=${fake.baseUrl}\n`);
    const settings = loadModelEnv({ env: { OPENQODEX_BENCH_MODEL_ENV: file } });
    const model = createOpenAIReviewer({ model: "gpt-6.1-sol", baseUrl: settings.baseUrl, apiKey: settings.apiKey, authHeader: settings.authHeader, allowUnprobed: true });
    const error = await rejection(model.complete(request(firstRound())));
    expect(fake.requests[0].headers["api-key"]).toBe(KEY);
    expect(error.message).toMatch(/HTTP 401/);
    expect(error.message).not.toContain(KEY);
  });

  it("leaves both out of a thrown message when the endpoint cannot be reached", async () => {
    const fake = await provider([reply({ text: "unused" })]);
    for (const server of servers.splice(0)) await new Promise((done) => server.close(done));
    const error = await rejection(reviewer(fake.baseUrl).complete(request(firstRound())));
    expect(error.message).toMatch(/^the request to the model endpoint failed: ECONNREFUSED$/);
    for (const shown of [error.message, String(error.stack), inspect(error)]) {
      expect(shown).not.toContain(KEY);
      expect(shown).not.toContain(fake.host);
    }
  });

  it("keeps both out of the reviewer object, the response, the request URL and the process's output", async () => {
    const fake = await provider([reply({ text: "done" })]);
    const model = reviewer(fake.baseUrl);
    const out = await model.complete(request(firstRound()));
    for (const shown of [JSON.stringify(model), inspect(model, { depth: 5 }), JSON.stringify(out)]) {
      expect(shown).not.toContain(KEY);
      expect(shown).not.toContain(fake.host);
    }
    expect(fake.requests[0].url).toBe("/openai/v1/responses");
    expect(JSON.stringify(fake.requests[0].body)).not.toContain(KEY);
    expect(written).toEqual([]);
  });

  it("runs the session's probe with neither value on its command line or in its output", async () => {
    const calls = [{ id: "call_probe", name: "echo", args: { text: "openqodex" } }];
    const fake = await provider([reply({ calls }), reply({ text: "openqodex" })]);
    const settings = join(tempDir("oq-model-env-"), "azure.env");
    writeFileSync(settings, `AZURE_OPENAI_KEY=${KEY}\nAZURE_OPENAI_BASE_URL=${fake.baseUrl}\n`);
    const args = [script, "--probe", "gpt-6.1-sol"];
    const { stdout, stderr } = await promisify(execFile)(process.execPath, args, { env: { ...process.env, OPENQODEX_BENCH_MODEL_ENV: settings } });
    for (const shown of [args.join(" "), stdout, stderr]) {
      expect(shown).not.toContain(KEY);
      expect(shown).not.toContain(fake.host);
    }
    const line = JSON.parse(stdout.trim().split("\n").at(-1));
    expect(line).toMatchObject({ ok: true, model: "gpt-6.1-sol", servedModel: SERVED, api: "responses", authHeader: "api-key", toolRoundTrip: true });
    expect(line.costUsd).toBeGreaterThan(0);
    // The probe's second request carried the tool call id back.
    expect(fake.requests[1].body.input.filter((i) => i.call_id === "call_probe").map((i) => i.type)).toEqual(["function_call", "function_call_output"]);
  });

  it("fails the probe when the model answers without calling the tool", async () => {
    const fake = await provider([reply({ text: "openqodex" })]);
    const settings = join(tempDir("oq-model-env-"), "azure.env");
    writeFileSync(settings, `AZURE_OPENAI_KEY=${KEY}\nAZURE_OPENAI_BASE_URL=${fake.baseUrl}\n`);
    const error = await rejection(promisify(execFile)(process.execPath, [script, "--probe", "gpt-6.1-sol"], { env: { ...process.env, OPENQODEX_BENCH_MODEL_ENV: settings } }));
    expect(error.code).toBe(1);
    expect(error.stdout + error.stderr).toMatch(/did not call the tool/);
    expect(error.stdout + error.stderr).not.toContain(KEY);
  });
});

describe("the header style", () => {
  it("sends the key in an api-key header to an api-key resource, never as a bearer token", async () => {
    const fake = await provider([reply({ text: "done" })], { only: "api-key" });
    const out = await reviewer(fake.baseUrl).complete(request(firstRound()));
    expect(out.message.text).toBe("done");
    expect(fake.requests[0].headers["api-key"]).toBe(KEY);
    expect(fake.requests[0].headers.authorization).toBeUndefined();
  });

  it("sends a bearer token only when asked, and that call fails as unauthorised on an api-key resource", async () => {
    const fake = await provider([reply({ text: "done" })], { only: "api-key" });
    const error = await rejection(reviewer(fake.baseUrl, { authHeader: "bearer" }).complete(request(firstRound())));
    expect(fake.requests[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(fake.requests[0].headers["api-key"]).toBeUndefined();
    expect(error.message).toMatch(/HTTP 401/);
    expect(error.message).not.toContain(KEY);
  });

  it("refuses a missing or unknown header style instead of picking one", () => {
    expect(() => reviewer("https://test-resource.openai.example/openai/v1", { authHeader: undefined })).toThrow(/authHeader must be "api-key" or "bearer"/);
    expect(() => reviewer("https://test-resource.openai.example/openai/v1", { authHeader: "x-api-key" })).toThrow(/authHeader must be "api-key" or "bearer"/);
  });
});

describe("usage as the contract asks", () => {
  it("records the served model and prices the call from prices.json: cached input at its own rate, reasoning inside output", async () => {
    const fake = await provider([reply({ text: "done" })]);
    const out = await reviewer(fake.baseUrl).complete(request(firstRound()));
    const cost = ((1200 - 200) * PRICES.input + 200 * PRICES.cachedInput + 300 * PRICES.output) / 1e6;
    expect(out.usage).toEqual({ model: "gpt-6.1-sol", servedModel: SERVED, inputTokens: 1200, outputTokens: 300, cacheReadTokens: 200, costUsd: cost });
  });

  it("is accepted by the brain, which records the served model and the cost on the attempt", async () => {
    const fake = await provider([reply({ text: "done" })]);
    const caller = callModel({ reviewer: reviewer(fake.baseUrl), role: "primary", now: Date.now });
    const called = await caller.call("brief", firstRound(), () => {});
    expect(called.response.message.text).toBe("done");
    expect(caller.attempts).toHaveLength(1);
    expect(caller.attempts[0]).toMatchObject({ outcome: "ok", servedModel: SERVED, inputTokens: 1200, outputTokens: 300, cacheReadTokens: 200 });
    expect(caller.attempts[0].costUsd).toBeGreaterThan(0);
  });

  it("returns the usage of a reply cut at max_output_tokens, which the provider bills", async () => {
    const fake = await provider([reply({ text: "{\"version\": 2, \"chan", status: "incomplete" })]);
    const out = await reviewer(fake.baseUrl).complete(request(firstRound()));
    expect(out.message.text).toBe("{\"version\": 2, \"chan");
    expect(out.usage.outputTokens).toBe(300);
  });
});

describe("refusals at creation", () => {
  it("refuses a model id boards.json does not record as a probed deployment", () => {
    expect(() => createOpenAIReviewer({ model: "gpt-6.1", baseUrl: "https://test-resource.openai.example/openai/v1", apiKey: KEY, authHeader: "api-key" })).toThrow(/^refused: gpt-6\.1 is not a deployment boards\.json records/);
  });

  it("refuses a model with no prices, since its calls could not be priced", () => {
    const prices = { models: {} };
    expect(() => reviewer("https://test-resource.openai.example/openai/v1", { prices })).toThrow(/no prices for gpt-6\.1-sol/);
  });

  it("refuses a base URL that sends the key in clear over a network, without printing it", () => {
    const plain = "http://test-resource.openai.example/openai/v1";
    let message = "";
    try {
      reviewer(plain);
    } catch (error) {
      message = error.message;
    }
    expect(message).toMatch(/baseUrl is not an https URL/);
    expect(message).not.toContain("test-resource.openai.example");
  });
});
