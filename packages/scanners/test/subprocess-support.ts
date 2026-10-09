// What the real-binary adapter checks share: the scanner home they install
// into, one scan of a tiny planted repo, and a proxy that logs every host a
// scanner opens a connection to. Run by the end-to-end config, not the unit
// config: tests/e2e/adapters.test.ts imports every *.subprocess.test.ts here.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseConfig } from "@openqodex/core";
import type { BuiltinScanner } from "@openqodex/core";
import { createToolResolver, runScanners } from "@openqodex/scanners";

process.env.OPENQODEX_HOME = process.env.OPENQODEX_E2E_HOME ?? join(tmpdir(), "openqodex-e2e-home");
// One throwaway user home for every file that imports this one.
process.env.OQ_SUBPROCESS_USER_HOME ??= mkdtempSync(join(tmpdir(), "oq-adapter-user-"));
process.env.HOME = process.env.OQ_SUBPROCESS_USER_HOME;

// runtime: the language runtime a scanner needs that this machine may lack,
// and the reason the product must give when it is missing. network: the case
// needs the network, and OPENQODEX_E2E_OFFLINE=1 skips it.
export type Case = { scanner: BuiltinScanner; rule: string; files: Record<string, string>; anchor: string; runtime?: RegExp; network?: true };

// The checks never install a scanner: the end-to-end setup installs every
// one first with the built CLI's `doctor --install`. An install from here
// would start this test runner again as its install worker (issue #69).
export const installedOnly = () => createToolResolver({ allowInstall: false, installBudgetMs: null });

// Every line of every planted file counts as changed, as for a new file.
export async function scan(spec: Case) {
  const repo = mkdtempSync(join(tmpdir(), `oq-adapter-${spec.scanner}-`));
  for (const [name, body] of Object.entries(spec.files)) {
    const path = join(repo, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  const paths = Object.keys(spec.files);
  const coverage = new Map(paths.map((p) => [p, new Set(readFileSync(join(repo, p), "utf8").split("\n").map((_, i) => i + 1))]));
  return runScanners({ repoDir: repo, changedPaths: paths, coverage, config: parseConfig("").config, resolveTool: installedOnly(), only: [spec.scanner] });
}

// Finds the installed scanner before a proxy is up, so only the scan's own
// connections are counted.
export async function resolveFirst(scanner: BuiltinScanner): Promise<void> {
  await installedOnly()(scanner);
}

// Runs `fn` with the proxy variables pointing at a local proxy that tunnels
// every CONNECT and refuses plain HTTP, and returns the hosts the scanners
// asked for, first seen first. A scanner that ignores the proxy variables is
// not seen here.
export async function withLoggingProxy<T>(fn: () => Promise<T>): Promise<{ result: T; hosts: string[] }> {
  const hosts: string[] = [];
  const proxy = http.createServer((req, res) => {
    try {
      hosts.push(new URL(req.url ?? "").hostname);
    } catch {
      hosts.push(req.headers.host ?? "");
    }
    res.writeHead(403).end();
  });
  proxy.on("connect", (req, socket, head) => {
    const [host, port] = (req.url ?? "").split(":");
    hosts.push(host ?? "");
    const upstream = net.connect(Number(port), host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
  const { port } = proxy.address() as net.AddressInfo;
  const names = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"];
  const saved = new Map(names.map((k) => [k, process.env[k]]));
  for (const k of names) process.env[k] = `http://127.0.0.1:${port}`;
  try {
    const result = await fn();
    return { result, hosts: [...new Set(hosts)] };
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    proxy.close();
  }
}
