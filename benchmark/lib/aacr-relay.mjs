// AACR's vLLM and sampling fields are not accepted by Azure's reasoning model.
// Keep the pinned evaluator intact and its process free of the Azure key.
//
// Failure list, written before the code (benchmark/test/aacr-board.test.mjs):
// 1. Stripping a top-level field rewrites other JSON bytes or nested fields.
// 2. The key uses bearer auth or leaks through logs, errors or counters.
// 3. Binding or the first upstream 401/404 lets evaluation rounds start.
// 4. Requests, removals or upstream statuses are missing from eval.json.
// 5. Another local process spends the key through the relay while a run lasts.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

// Find top-level members without reserializing their values. Commas inside
// strings, arrays and nested objects do not split a member. JSON.parse
// validates the body first; slices retain numbers, escapes and whitespace.
function adaptParameters(body) {
  const parsed = JSON.parse(body);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected a JSON object");
  const open = body.indexOf("{");
  const end = body.lastIndexOf("}");
  const members = [];
  let start = open + 1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < end; i++) {
    const c = body[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      members.push(body.slice(start, i));
      start = i + 1;
    }
  }
  members.push(body.slice(start, end));
  const changes = { chat_template_kwargs: 0, temperature: 0, top_p: 0, max_tokens: 0 };
  const kept = members.flatMap((member) => {
    const name = /^\s*("(?:[^"\\]|\\.)*")\s*:/.exec(member);
    const field = name ? JSON.parse(name[1]) : null;
    if (["chat_template_kwargs", "temperature", "top_p"].includes(field)) {
      changes[field]++;
      return [];
    }
    if (field === "max_tokens") {
      changes.max_tokens++;
      return [member.replace(name[1], '"max_completion_tokens"')];
    }
    return [member];
  });
  return { body: Object.values(changes).every((n) => n === 0) ? body : body.slice(0, open + 1) + kept.join(",") + body.slice(end), changes };
}

/** A loopback-only relay with opaque credentials and counters safe to save. */
export async function startRelay(settings) {
  const apiKey = randomBytes(32).toString("hex");
  const expected = Buffer.from(`Bearer ${apiKey}`);
  const stats = { relay: true, requests: 0, stripped: 0, parameterChanges: { chat_template_kwargs: 0, temperature: 0, top_p: 0, max_tokens: 0 }, upstreamStatuses: {} };
  const target = new URL(`${settings.baseUrl.replace(/\/+$/, "")}/chat/completions`);
  const request = target.protocol === "https:" ? httpsRequest : httpRequest;
  const server = createServer(async (req, res) => {
    // Only the evaluator holds the placeholder; any other caller is refused before anything is forwarded.
    const given = Buffer.from(req.headers.authorization ?? "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    stats.requests++;
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const adapted = adaptParameters(Buffer.concat(chunks).toString("utf8"));
      stats.stripped += adapted.changes.chat_template_kwargs;
      for (const [name, count] of Object.entries(adapted.changes)) stats.parameterChanges[name] += count;
      const upstream = request(target, {
        method: "POST",
        headers: { "content-type": "application/json", [settings.authHeader]: settings.apiKey },
      }, (response) => {
        const status = response.statusCode;
        stats.upstreamStatuses[status] = (stats.upstreamStatuses[status] ?? 0) + 1;
        res.writeHead(status, response.headers);
        response.on("error", () => res.destroy());
        response.pipe(res);
      });
      // Never surface a transport error, which can name the real endpoint.
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502).end("AACR judge relay: upstream connection failed");
        else res.destroy();
      });
      res.on("close", () => upstream.destroy());
      upstream.end(adapted.body);
    } catch {
      res.writeHead(400).end("AACR judge relay: invalid request body");
    }
  });
  await new Promise((up, fail) => {
    server.once("error", () => fail(new Error("AACR judge relay: cannot bind on 127.0.0.1; stopped before round 1")));
    server.listen(0, "127.0.0.1", up);
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    apiKey,
    counts: () => ({ ...stats, parameterChanges: { ...stats.parameterChanges }, upstreamStatuses: { ...stats.upstreamStatuses } }),
    close: () => new Promise((down) => {
      server.close(down);
      server.closeAllConnections();
    }),
  };
}

/** Check the judge through the same route before starting any evaluation. */
export async function checkRelay(relay, model) {
  const response = await fetch(`${relay.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${relay.apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply yes." }], temperature: 0.7, max_tokens: 40000, top_p: 0.95, chat_template_kwargs: { enable_thinking: false } }),
  });
  const body = await response.text();
  if (!response.ok) {
    let message = null;
    try {
      const error = JSON.parse(body);
      message = error.error?.message ?? error.message;
    } catch {
      // A non-JSON response supplies no upstream message.
    }
    const detail = typeof message === "string" ? `: ${message}` : "";
    throw new Error(`AACR judge relay: upstream returned ${response.status} on the first call${detail}; stopped before round 1`);
  }
}
