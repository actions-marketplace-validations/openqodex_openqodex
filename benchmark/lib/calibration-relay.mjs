// Only the relay child loads model settings. Its parent receives loopback
// credentials and safe counters over IPC, never the upstream key or URL.
// Failure cases: benchmark/test/calibration-failures.md and aacr-board.test.mjs.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startRelay, checkRelay } from "./aacr-relay.mjs";

export async function relayClient() {
  const child = spawn("/bin/sh", ["-c", 'ulimit -c 0 && exec "$0" "$@"', process.execPath, fileURLToPath(import.meta.url), "--serve"], { stdio: ["ignore", "ignore", "ignore", "ipc"], env: process.env });
  const controller = new AbortController();
  let next = 0;
  const pending = new Map();
  const ready = await new Promise((resolve, reject) => {
    child.on("error", () => reject(new Error("judge relay: could not start child")));
    child.on("exit", (code) => { const error = new Error(`judge relay: child exited ${code}`); reject(error); for (const p of pending.values()) p.reject(error); });
    child.on("message", (m) => {
      if (m.error) {
        const error = new Error(m.error); controller.abort(error); reject(error);
        for (const p of pending.values()) p.reject(error);
      } else if (m.ready) resolve(m);
      else if (pending.has(m.id)) { pending.get(m.id).resolve(m.counts); pending.delete(m.id); }
    });
  });
  return {
    model: ready.model, settings: { baseUrl: ready.baseUrl, apiKey: ready.apiKey, authHeader: "authorization" }, signal: controller.signal,
    async complete(prompt, request) {
      controller.signal.throwIfAborted();
      const response = await fetch(`${ready.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ready.apiKey}` }, body: JSON.stringify({ model: ready.model, messages: [{ role: "system", content: prompt }, { role: "user", content: JSON.stringify(request) }], response_format: { type: "json_object" }, max_completion_tokens: 1000 }), signal: controller.signal });
      if (!response.ok) throw new Error(`judge relay: upstream returned ${response.status}; stopped`);
      const answer = await response.json();
      try { return JSON.parse(answer.choices[0].message.content); } catch { throw new Error("malformed judge verdict"); }
    },
    counts: () => new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); child.send({ id, op: "counts" }); }),
    close: () => new Promise((resolve) => { if (child.exitCode !== null) resolve(); else { child.once("exit", resolve); child.send({ op: "close" }); } }),
  };
}

async function serve() {
  const { loadModelEnv, probedDeployment, endpointSecrets } = await import("./model-env.mjs");
  const { redactor } = await import("./board-files.mjs");
  const settings = loadModelEnv();
  const model = probedDeployment("gpt-5.2").id;
  const safeError = (error) => {
    let safe = ""; const filter = redactor(endpointSecrets(settings.baseUrl, settings.apiKey), (s) => { safe += s; });
    filter.write(error.message); filter.end(); process.send({ error: safe });
  };
  const relay = await startRelay(settings, { trackUsage: true, onFailure: (error) => process.send({ error }) });
  process.on("disconnect", () => { relay.close().finally(() => process.exit()); });
  process.on("message", async (m) => {
    if (m.op === "counts") process.send({ id: m.id, counts: relay.counts() });
    else if (m.op === "close") { await relay.close(); process.exit(); }
  });
  try { await checkRelay(relay, model); } catch (error) { safeError(error); await relay.close(); process.exit(2); }
  process.send({ ready: true, model, baseUrl: relay.baseUrl, apiKey: relay.apiKey });
}
if (process.argv[2] === "--serve" && process.send) serve().catch((error) => { process.send({ error: error.message }); process.exit(2); });
