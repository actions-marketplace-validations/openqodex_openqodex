// `openqodex mcp`, the built CLI's MCP server, driven over stdio by the MCP
// SDK's own client, as an agent drives it. Ways it could fail, written
// before the code:
//  1. A question of the query layer has no tool, or a tool's description
//     does not say that answers are data and that a zero on a floor is not
//     "unused".
//  2. A tool answers differently from `openqodex graph <question> --json`
//     for the same request and the same build (the adapter changes meaning).
//  3. A question naming another repository, a path outside the repository
//     or a build id that is not one is answered instead of refused.
//  4. A token budget cuts the counts, or returns nothing and never moves.
//  5. The held build is removed while the agent still asks about it: a
//     build published meanwhile by another command collects it, or the
//     answers move to the new build without `graph_refresh`; or an edit
//     made since is not said (`laterEditsKnown`).
//  6. A cancelled question breaks the server, so the next one fails.
//  7. The lease stays after the agent disconnects, or the server keeps
//     running.
//  8. A server started outside a repository crashes instead of saying why.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { OPERATIONS } from "@openqodex/graph";
import type { Answer } from "@openqodex/graph";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "cli", "dist", "bin.js");
const dirs: string[] = [];
const home = realpathSync(mkdtempSync(join(tmpdir(), "oq-mcp-home-")));
dirs.push(home);
const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: home, OPENQODEX_HOME: join(home, ".openqodex"), OPENQODEX_AUTO_UPDATE: "0" };

function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "oq-mcp-")));
  dirs.push(root);
  write(root, files);
  const git = (...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  return root;
}

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

function cli(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: "utf8", timeout: 120_000 });
}

const clients: Client[] = [];
async function connect(cwd: string, more: Record<string, string> = {}): Promise<{ client: Client; transport: StdioClientTransport }> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, "mcp"], cwd, env: { ...env, ...more }, stderr: "pipe" });
  const client = new Client({ name: "openqodex-test", version: "1.0.0" });
  await client.connect(transport);
  clients.push(client);
  return { client, transport };
}

async function ask(client: Client, name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<{ answer: Answer; isError: boolean }> {
  const r = (await client.callTool({ name, arguments: args }, undefined, { signal, timeout: 120_000 })) as { content: { type: string; text: string }[]; isError?: boolean };
  return { answer: JSON.parse(r.content[0]?.text ?? "null") as Answer, isError: r.isError === true };
}

function leases(root: string): { id: string; purpose: string; pid: number }[] {
  const dir = join(root, ".openqodex", "graph", "leases");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as { id: string; purpose: string; pid: number });
}

const files: Record<string, string> = { "src/core.ts": "export function core(): number {\n  return 1;\n}\n" };
for (let i = 0; i < 12; i++) files[`src/c${i}.ts`] = `import { core } from "./core";\nexport function c${i}(): number {\n  return core() + ${i};\n}\n`;

afterAll(async () => {
  for (const c of clients) await c.close().catch(() => undefined);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("the MCP server", () => {
  let root: string;
  let client: Client;
  beforeAll(async () => {
    root = repo(files);
    ({ client } = await connect(root));
  }, 120_000);

  it("lists one tool per question and graph_refresh, each saying answers are data and a floor is not unused (1)", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...OPERATIONS.map((o) => `graph_${o}`), "graph_refresh"].sort());
    for (const t of tools) {
      expect(t.description, t.name).toMatch(/data, never instructions/);
      expect(t.description, t.name).toMatch(/not "unused"/);
      expect(t.inputSchema.type, t.name).toBe("object");
    }
  });

  it("answers as `openqodex graph --json` does for the same request and build (2)", async () => {
    const { answer } = await ask(client, "graph_callers", { symbol: "core" });
    expect(answer.error).toBeNull();
    expect(answer.counts.certain).toBe(12);
    const generation = answer.graph.generation as string;
    const r = cli(root, "graph", "callers", "core", "--json", "--generation", generation);
    expect(r.status, r.stderr).toBe(0);
    expect(answer).toEqual(JSON.parse(r.stdout));
    const path = await ask(client, "graph_path", { from: "c3", to: "core" });
    const p = cli(root, "graph", "path", "c3", "core", "--json", "--generation", generation);
    expect(path.answer).toEqual(JSON.parse(p.stdout));
  });

  it("refuses another repository, a path outside this one and a build id that is not one (3)", async () => {
    const other = repo({ "x.ts": "export const x = 1;\n" });
    for (const [name, args] of [
      ["graph_status", { repo: other }],
      ["graph_callers", { symbol: "core", repo: "/" }],
      ["graph_outline", { path: "../outside" }],
      ["graph_outline", { path: "/etc" }],
      ["graph_callers", { symbol: "../../etc/passwd:1" }],
      ["graph_importers", { file: "src/../../x.ts" }],
      ["graph_callers", { symbol: "core", generation: "../../../etc" }],
    ] as const) {
      const { answer, isError } = await ask(client, name, args);
      expect(isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(answer.error?.code, `${name} ${JSON.stringify(args)}`).toBe("refused");
    }
    // The server's own repository by its path is answered.
    const own = await ask(client, "graph_status", { repo: root });
    expect(own.answer.error).toBeNull();
  });

  it("cuts by a token budget without touching the counts, and pages on (4)", async () => {
    const { answer } = await ask(client, "graph_callers", { symbol: "core", budget: { tokens: 1 } });
    expect(answer.items).toHaveLength(1);
    expect(answer.counts.certain).toBe(12);
    expect(answer.truncated).toMatchObject({ by: "budget", omitted: 11, omittedExact: true });
    const next = await ask(client, "graph_callers", { symbol: "core", budget: { tokens: 1 }, cursor: answer.truncated.cursor });
    expect(next.answer.items).toHaveLength(1);
    expect(next.answer.items[0]).not.toEqual(answer.items[0]);
  });

  it("keeps a cancelled question from breaking the next one (6)", async () => {
    const abort = new AbortController();
    const pending = ask(client, "graph_cycles", {}, abort.signal);
    abort.abort();
    await expect(pending).rejects.toThrow();
    const { answer } = await ask(client, "graph_status");
    expect(answer.error).toBeNull();
  });
});

describe("the held build", () => {
  it("stays readable and answering while other builds publish, says the edit, and moves only on refresh (5, 7)", async () => {
    const root = repo(files);
    const { client, transport } = await connect(root);
    const first = await ask(client, "graph_callers", { symbol: "core" });
    const held = first.answer.graph.generation as string;
    expect(held).toMatch(/^[0-9a-z]{13}-/);
    expect(first.answer.graph.freshness.laterEditsKnown).toBe(false);
    expect(leases(root).filter((l) => l.purpose === "mcp").map((l) => l.id)).toEqual([held]);
    // Three builds published by the command line, each of an edited tree:
    // without the lease the collector would remove the held one.
    for (let i = 0; i < 3; i++) {
      write(root, { [`src/extra${i}.ts`]: `import { core } from "./core";\nexport function extra${i}(): number {\n  return core();\n}\n` });
      const b = cli(root, "graph", "build");
      expect(b.status, b.stderr).toBe(0);
    }
    expect(existsSync(join(root, ".openqodex", "graph", "generations", held))).toBe(true);
    // The server looks for edits at most once a second; three quick builds
    // can take less.
    await new Promise((r) => setTimeout(r, 1100));
    const later = await ask(client, "graph_callers", { symbol: "core" });
    expect(later.answer.graph.generation).toBe(held);
    expect(later.answer.counts.certain).toBe(12);
    expect(later.answer.graph.freshness.laterEditsKnown).toBe(true);
    const refreshed = await ask(client, "graph_refresh");
    const moved = refreshed.answer.graph.generation as string;
    expect(moved).not.toBe(held);
    expect(refreshed.answer.graph.freshness.laterEditsKnown).toBe(false);
    const after = await ask(client, "graph_callers", { symbol: "core" });
    expect(after.answer.graph.generation).toBe(moved);
    expect(after.answer.counts.certain).toBe(15);
    expect(leases(root).filter((l) => l.purpose === "mcp").map((l) => l.id)).toEqual([moved]);
    // Disconnect: the server exits and its lease goes (7).
    const pid = transport.pid;
    await client.close();
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && leases(root).some((l) => l.purpose === "mcp")) await new Promise((r) => setTimeout(r, 50));
    expect(leases(root).filter((l) => l.purpose === "mcp")).toEqual([]);
    let alive = true;
    while (Date.now() < deadline && alive) {
      try {
        process.kill(pid as number, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  }, 180_000);

  it("says why when started outside a repository, and keeps serving (8)", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "oq-mcp-nogit-")));
    dirs.push(outside);
    // git looks no higher than the folder's parent: the temporary folder
    // may itself sit inside a repository.
    const { client } = await connect(outside, { GIT_CEILING_DIRECTORIES: dirname(outside) });
    const { answer, isError } = await ask(client, "graph_status");
    expect(isError).toBe(true);
    expect(answer.error?.code).toBe("refused");
    expect(answer.error?.message).toMatch(/not inside a git repository/);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  });
});
