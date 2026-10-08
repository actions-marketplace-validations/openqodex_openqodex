// What the benchmark needs to know about a reviewer before it spends on
// one: its version, whether it is logged in, which model it answers with,
// and, after a failed review, whether a limit or a login wall stopped it.
//
// Failure list, written before the code:
// 1. The probe answers with a different model than the reviewer would
//    (user settings pick another model): it runs with the same isolation
//    flags as the reviewer (no setting sources) and the same environment
//    allowlist, so the model it reports is the reviewer's.
// 2. A usage limit, a rate limit or a login wall reads as a product failure
//    and the run carries on into more failures: the probe's text is checked
//    for them, and the caller stops the run at once.
// 3. The probe hangs: it has a timeout and counts as failed.
// 4. The probe costs more than a few tokens: one short prompt, no tools.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

function withInput(cmd, args, input, env, timeoutMs) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let error = null;
    const timer = setTimeout(() => {
      error = `timed out after ${timeoutMs / 1000} s`;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    child.on("error", (e) => (error = e.message));
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr, error });
    });
    child.stdin.end(input);
  });
}

// The environment the Claude Code reviewer gets (packages/cli/src/reviewers/claude.ts reviewerEnv).
const ALWAYS = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "TERM", "TZ", "CLAUDE_CONFIG_DIR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"];
const ANTHROPIC = /^ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL|MODEL|SMALL_FAST_MODEL|CUSTOM_HEADERS|DEFAULT_[A-Z_]+_MODEL)$/;

export function claudeEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (ALWAYS.includes(k) || k.startsWith("LC_") || ANTHROPIC.test(k)) out[k] = v;
  }
  return out;
}

// Words that mean the account, not the product, stopped the review.
export const BLOCKED = /usage limit|rate limit|rate_limit|limit reached|hit your limit|quota|credit balance|overloaded|not logged in|log in|login|authenticat|unauthorized|forbidden|billing/i;

export async function probeClaude({ env = process.env, timeoutMs = 120_000 } = {}) {
  const e = claudeEnv(env);
  let version = null;
  try {
    const { stdout } = await run("claude", ["--version"], { env: e, timeout: 20_000 });
    version = /\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? stdout.trim();
  } catch (error) {
    return { ok: false, blocked: false, version, model: null, text: `claude --version failed: ${String(error.message).split("\n")[0]}` };
  }
  const args = [
    "-p",
    "--output-format", "json",
    "--setting-sources", "",
    "--settings", JSON.stringify({ autoMemoryEnabled: false, hooks: {}, disableAllHooks: true }),
    "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} }),
    "--disable-slash-commands",
    "--no-session-persistence",
    // --tools takes a list, so the prompt goes on standard input, not after it.
    "--tools", "",
  ];
  const r = await withInput("claude", args, "Reply with the single word ok.", e, timeoutMs);
  const out = r.stdout;
  if (out.trim() === "") {
    const text = `${r.error ?? `exit ${r.code}`} ${r.stderr}`.trim();
    return { ok: false, blocked: BLOCKED.test(text), version, model: null, text };
  }
  let result;
  try {
    result = JSON.parse(out);
  } catch {
    return { ok: false, blocked: BLOCKED.test(out), version, model: null, text: out.slice(0, 500) };
  }
  const models = Object.keys(result.modelUsage ?? {});
  const text = String(result.result ?? "");
  const ok = result.is_error !== true && /\bok\b/i.test(text);
  return { ok, blocked: !ok && BLOCKED.test(text), version, model: models.length === 1 ? models[0] : models.length === 0 ? null : models, text: text.slice(0, 500), costUsd: result.total_cost_usd ?? null };
}

export async function probeCodex({ env = process.env } = {}) {
  try {
    const { stdout } = await run("codex", ["--version"], { env, timeout: 20_000 });
    return { ok: true, blocked: false, version: /\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? stdout.trim(), model: env.OPENQODEX_BENCH_CODEX_MODEL ?? null, text: "" };
  } catch (error) {
    return { ok: false, blocked: false, version: null, model: null, text: `codex --version failed: ${String(error.message).split("\n")[0]}` };
  }
}

export function probeReviewer(name, opts) {
  if (name === "claude") return probeClaude(opts);
  if (name === "codex") return probeCodex(opts);
  return Promise.resolve({ ok: false, blocked: false, version: null, model: null, text: `no probe for reviewer ${name}` });
}

// A review the reviewer did not finish because its process failed, timed
// out or could not start, as opposed to a review the product judged
// incomplete (an unread range, a failed answer check).
export const REVIEWER_FAILED = /^(the reviewer (timed out|stopped|exited|failed|is no longer running)|could not start the reviewer|no reviewer process)/;
