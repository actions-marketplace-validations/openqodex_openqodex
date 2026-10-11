#!/usr/bin/env node
// Fetches one published run back into benchmark/results/<run-id>/:
//
//   node benchmark/fetch-run.mjs <run-id> [--into <results folder>] [--from <local .tar.gz>]
//
// It reads the run's committed index entry (benchmark/index/runs/<run-id>.json),
// downloads the asset from the URL the entry names (or takes --from), checks
// its sha256, unpacks it with the system tar into a temp folder beside the
// target, checks the file count and the list hash, and only then moves it
// into place. A legacy run's asset also holds _archive/: the scorer of each
// commit that wrote one of its score files, for benchmark/legacy/rescore.mjs.
//
// Exit codes: 0 fetched; 1 refused (the asset is not the one the entry
// names, or the run is already there); 2 the tool failed.
//
// Failure list, written before the code:
// 1. A download that is not the published asset (truncated, replaced, the
//    wrong run) is used: the sha256 is checked before unpacking, and the
//    file count and list hash after; any difference refuses it and leaves
//    nothing in the results folder.
// 2. A fetch writes over a run already on this machine, perhaps one with
//    local work: a target folder that exists is refused.
// 3. An entry with a broken shape sends the fetch to a wrong URL: the entry
//    is validated first.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { entryProblems, hashFolder, readEntry, resultsRoot, sha256 } from "./lib/index.mjs";

// Unpacks a downloaded asset into <into>/<run-id> after checking it against
// the entry's asset record ({sha256, listHash, files}). Returns the folder.
export function extractAsset(tarPath, asset, into, runId) {
  const bytes = readFileSync(tarPath);
  const got = sha256(bytes);
  if (got !== asset.sha256) throw new Error(`refused: ${tarPath} has sha256 ${got}, not the ${asset.sha256} the index entry names`);
  const target = join(into, runId);
  if (existsSync(target)) throw new Error(`refused: ${target} exists; move it away first`);
  mkdirSync(into, { recursive: true });
  const temp = mkdtempSync(join(into, `.fetch-${runId}-`));
  try {
    execFileSync("tar", ["-xzf", resolve(tarPath), "-C", temp], { stdio: ["ignore", "ignore", "pipe"] });
    const top = readdirSync(temp);
    if (top.length !== 1 || top[0] !== runId) throw new Error(`refused: the asset holds ${top.join(", ")}, not the one folder ${runId}`);
    const h = hashFolder(join(temp, runId));
    if (h.files !== asset.files || h.listHash !== asset.listHash) throw new Error(`refused: the unpacked file list (${h.files} files, list hash ${h.listHash}) is not the one the index entry names (${asset.files} files, ${asset.listHash})`);
    renameSync(join(temp, runId), target);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  return target;
}

export async function fetchRun(runId, { into = resultsRoot, from = null } = {}) {
  const entry = readEntry(runId);
  if (!entry) throw new Error(`no index entry benchmark/index/runs/${runId}.json`);
  const problems = entryProblems(entry);
  if (problems.length > 0) throw new Error(`the index entry for ${runId} is not sound:\n${problems.join("\n")}`);
  if (from) return extractAsset(from, entry.asset, into, runId);
  const temp = mkdtempSync(join(tmpdir(), `oq-fetch-${runId}-`));
  try {
    const res = await fetch(entry.asset.url, { redirect: "follow" });
    if (!res.ok) throw new Error(`downloading ${entry.asset.url} failed: HTTP ${res.status}`);
    const file = join(temp, `${runId}.tar.gz`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    return extractAsset(file, entry.asset, into, runId);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  let into = resultsRoot;
  let from = null;
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--into") into = args[++i];
    else if (args[i] === "--from") from = args[++i];
    else pos.push(args[i]);
  }
  if (pos.length !== 1 || into === undefined || from === undefined) {
    console.error("usage: node benchmark/fetch-run.mjs <run-id> [--into <results folder>] [--from <local .tar.gz>]");
    process.exit(2);
  }
  try {
    const folder = await fetchRun(pos[0], { into: resolve(into), from });
    console.log(`Fetched ${pos[0]} into ${folder}; its sha256 and file list are the ones the index entry names.`);
  } catch (error) {
    console.error(error.message);
    process.exit(error.message.startsWith("refused") ? 1 : 2);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
