// search_code's search, run in a worker thread so a pattern that backtracks
// without end can be stopped: a regular expression cannot be interrupted on
// the thread that runs it, and a worker can be ended at once. The worker
// only reads snapshot files; it starts no program.
import { Worker } from "node:worker_threads";

export type SearchMatch = { path: string; line: number; text: string };
export type SearchResult = { matches: SearchMatch[]; limited: boolean } | { stopped: true } | { error: string };

// The worker reads each listed file without following a link, skips one
// that is over the size bound, holds a NUL byte or is not UTF-8 text, and
// tests the pattern on every line. It stops at `maxMatches`.
const WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");
const { root, files, pattern, maxMatches, maxFileBytes, maxText } = workerData;
const re = new RegExp(pattern);
const matches = [];
let limited = false;
outer: for (const rel of files) {
  let buf = null;
  let fd = -1;
  try {
    fd = fs.openSync(path.join(root, rel), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (st.isFile() && st.size <= maxFileBytes) buf = fs.readFileSync(fd);
  } catch {
    buf = null;
  } finally {
    if (fd !== -1) fs.closeSync(fd);
  }
  if (buf === null || buf.includes(0)) continue;
  const text = buf.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(buf)) continue;
  const lines = text.split("\\n");
  if (text.endsWith("\\n")) lines.pop();
  for (let i = 0; i < lines.length; i++) {
    if (!re.test(lines[i])) continue;
    matches.push({ path: rel, line: i + 1, text: lines[i].slice(0, maxText) });
    if (matches.length >= maxMatches) {
      limited = true;
      break outer;
    }
  }
}
parentPort.postMessage({ matches, limited });
`;

// How long one search may run before it is stopped.
export const SEARCH_MS = 5_000;

export function searchFiles(args: { root: string; files: string[]; pattern: string; maxMatches: number; maxFileBytes: number; maxText: number }): Promise<SearchResult> {
  return new Promise((done) => {
    let settled = false;
    const finish = (result: SearchResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      done(result);
    };
    const worker = new Worker(WORKER, { eval: true, workerData: args, resourceLimits: { maxOldGenerationSizeMb: 256 }, stdout: true, stderr: true });
    const timer = setTimeout(() => finish({ stopped: true }), SEARCH_MS);
    worker.once("message", (m: { matches: SearchMatch[]; limited: boolean }) => finish(m));
    worker.once("error", (e: Error) => finish({ error: e.message.split("\n")[0] ?? "the search failed" }));
    worker.once("exit", () => finish({ error: "the search ended without an answer" }));
  });
}
