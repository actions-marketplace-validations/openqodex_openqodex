// A run leaves the machine as one asset on the benchmark-data pre-release,
// and its committed index entry is the only record of it in the tree. Three
// failures are guarded here, each on a run folder of the shape run.mjs
// writes, built in a temp folder:
// 1. A published run cannot be fetched back to the same files: the asset
//    is packaged, checked by its sha256 and file list, unpacked again, and
//    every exported file must come back byte for byte. The same folder must
//    package to the same bytes twice, because the index entry is committed
//    before the session uploads the asset.
// 2. An exported file carrying a secret, a home path, the model key or
//    third-party code is published: each one in any exported file, a
//    transcript line included, refuses the publish, and the refusal never
//    prints the key.
// 3. A run that holds a case whose licence nobody verified (GitHub names
//    none it can classify) is published: such a case is for private runs
//    only, and the publish is refused with every such case named.
// codeLines failure list, written before its tests and code:
// 1. A quote from an old commit refuses a run, although neither reviewed
//    tree holds it. Only the pinned head and base trees must be searched.
// 2. A head-only line or a deleted base-only line escapes inspection.
// 3. A missing materialised record, head or base prints Git's multiline
//    error or permits publishing. Refuse in one line without an asset.
// 4. Memory grows with unrelated history. A large old blob must not be
//    read or indexed, even under a small heap.
// 5. A large reviewed tree exhausts the heap. Index the run, never tree lines.
// 6. A fingerprint hit alone refuses unrelated text. Confirm the full line.
// 7. A window after the first character or with Unicode is missed.
// 8. A source line inside a longer name refuses unrelated text: the index
//    ignores word edges, so the hit must still check them.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { casesRoot, generatedValue, git, repoRoot } from "../lib/cases.mjs";
import { hashFolder } from "../lib/index.mjs";
import { packageRun } from "../publish-run.mjs";
import { extractAsset } from "../fetch-run.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

// One review of one case, with every file a sample folder holds.
function addSample(run, name, config, extra = {}) {
  const dir = join(run, "samples", name, config, "1");
  write(join(dir, "sample.json"), JSON.stringify({ case: name, config, repeat: 1, attempt: 1, exit: 0, wallMs: 21000, status: "complete" }));
  write(join(dir, "stderr.txt"), "");
  write(join(dir, "receipt.txt"), "Reviewing the change against HEAD: 2 files\n");
  for (const file of ["report.json", "scan.json", "submission.json", "reviewer.json", "manifest.json"]) write(join(dir, "report", file), JSON.stringify({ file }));
  write(join(dir, "report", "brief.md"), "# Review brief\n\n## The changed lines\n");
  write(join(dir, "report", "trace.json"), JSON.stringify({ calls: [] }));
  // A rendering of report.json: it stays on the machine that ran.
  write(join(dir, "report", "report.html"), "<html></html>");
  for (const [file, text] of Object.entries(extra)) write(join(dir, file), text);
  return dir;
}

// A planted run: its manifest, its own copy of each spec, two samples, the
// rows and a score, the way run.mjs and score.mjs leave them.
function plantedRun(runId = "2026-10-10-abc1234", manifest = {}) {
  const run = join(tempDir("oq-publish-"), runId);
  write(join(run, "manifest.json"), JSON.stringify({ version: 2, started_at: "2026-10-10T10:00:00.000Z", build: { commit: "a".repeat(40), short: "abc1234", dirty: false, cliVersion: "0.13.0" }, configs: ["claude-graph-on"], repeat: 1, planned: 2, cases: ["demo-polyglot", "flask-path-traversal"], ended: { how: "finished", why: null }, ...manifest }));
  for (const name of ["demo-polyglot", "flask-path-traversal"]) {
    write(join(run, "cases", `${name}.json`), readFileSync(join(casesRoot, name, "case.json"), "utf8"));
    addSample(run, name, "claude-graph-on");
  }
  write(join(run, "rows.jsonl"), '{"case":"demo-polyglot"}\n{"case":"flask-path-traversal"}\n');
  write(join(run, "score.json"), JSON.stringify({ byConfig: {} }));
  return run;
}

const files = (dir) => {
  const out = [];
  const walk = (rel) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(path);
      else out.push(path);
    }
  };
  walk("");
  return out.sort();
};

describe("a published run comes back as the same files", () => {
  it("packages a run, unpacks it with tar after the sha256 and list checks, and gets every exported file back byte for byte", async () => {
    const run = plantedRun();
    const out = tempDir("oq-publish-out-");
    const asset = await packageRun(run, { out });
    expect(asset.files).toBeGreaterThan(10);
    expect(asset.left).toEqual(["samples/demo-polyglot/claude-graph-on/1/report/report.html", "samples/flask-path-traversal/claude-graph-on/1/report/report.html"]);
    const into = tempDir("oq-fetch-");
    const back = extractAsset(asset.tarPath, { sha256: asset.sha256, listHash: asset.listHash, files: asset.files }, into, "2026-10-10-abc1234");
    expect(back).toBe(join(into, "2026-10-10-abc1234"));
    const exported = files(run).filter((p) => !asset.left.includes(p));
    expect(files(back)).toEqual(exported);
    for (const p of exported) expect(readFileSync(join(back, p)).equals(readFileSync(join(run, p)))).toBe(true);
    expect(hashFolder(back).listHash).toBe(asset.listHash);
  });

  it("packages the same folder to the same bytes, so the index entry committed before the upload names the asset the session uploads", async () => {
    const run = plantedRun();
    const a = await packageRun(run, { out: tempDir("oq-publish-out-") });
    const b = await packageRun(run, { out: tempDir("oq-publish-out-") });
    expect(b.sha256).toBe(a.sha256);
    expect(b.listHash).toBe(a.listHash);
  });

  it("refuses an asset whose bytes or file list are not the ones the index entry names", async () => {
    const run = plantedRun();
    const asset = await packageRun(run, { out: tempDir("oq-publish-out-") });
    const bytes = readFileSync(asset.tarPath);
    bytes[bytes.length - 20] ^= 0xff;
    const bad = join(tempDir("oq-publish-bad-"), "2026-10-10-abc1234.tar.gz");
    writeFileSync(bad, bytes);
    const into = tempDir("oq-fetch-");
    expect(() => extractAsset(bad, { sha256: asset.sha256, listHash: asset.listHash, files: asset.files }, into, "2026-10-10-abc1234")).toThrow(/sha256/);
    expect(() => extractAsset(asset.tarPath, { sha256: asset.sha256, listHash: "0".repeat(64), files: asset.files }, into, "2026-10-10-abc1234")).toThrow(/file list/);
    expect(existsSync(join(into, "2026-10-10-abc1234"))).toBe(false);
  });
});

describe("nothing private or third-party leaves in an asset", () => {
  const refused = async (run, env = {}) => {
    const out = tempDir("oq-publish-out-");
    let message = null;
    try {
      await packageRun(run, { out, env });
    } catch (error) {
      message = error.message;
    }
    expect(readdirSync(out)).toEqual([]);
    return message;
  };

  it("refuses a run whose trace holds the case's generated secret", async () => {
    const run = plantedRun();
    const spec = JSON.parse(readFileSync(join(run, "cases", "demo-polyglot.json"), "utf8"));
    const secret = generatedValue("demo-polyglot", spec.generated[0].file, spec.generated[0].kind);
    write(join(run, "samples/demo-polyglot/claude-graph-on/1/report/trace.json"), JSON.stringify({ read: `STRIPE_KEY = "${secret}"` }));
    const message = await refused(run);
    expect(message).toMatch(/samples\/demo-polyglot\/claude-graph-on\/1\/report\/trace\.json:1: the generated secret of demo-polyglot/);
    expect(message).not.toContain(secret);
  });

  it("refuses a run whose stderr holds this machine's home folder", async () => {
    const run = plantedRun();
    write(join(run, "samples/flask-path-traversal/claude-graph-on/1/stderr.txt"), `warning: ${join(homedir(), "Projects", "x")} is not a git repository\n`);
    expect(await refused(run)).toMatch(/samples\/flask-path-traversal\/claude-graph-on\/1\/stderr\.txt:1: the home folder path/);
  });

  it("refuses a run whose transcript holds the model key or base URL, without printing either", async () => {
    const run = plantedRun();
    const envFile = join(tempDir("oq-model-env-"), "azure.env");
    // Made at run time, so no secret scanner reading this file takes it for a real key.
    const key = `test-model-key-${randomBytes(16).toString("hex")}`;
    const base = "https://test-resource.openai.example/openai/v1";
    writeFileSync(envFile, `AZURE_OPENAI_KEY=${key}\nAZURE_OPENAI_BASE=${base}\n`);
    addSample(run, "flask-path-traversal", "model-gpt-6.1-sol", { "transcript.jsonl": `{"role":"system","note":"sent with api-key ${key}"}\n` });
    const keyMessage = await refused(run, { OPENQODEX_BENCH_MODEL_ENV: envFile });
    expect(keyMessage).toMatch(/samples\/flask-path-traversal\/model-gpt-6\.1-sol\/1\/transcript\.jsonl:1: a value from the model settings file/);
    expect(keyMessage).not.toContain(key);
    const run2 = plantedRun();
    addSample(run2, "flask-path-traversal", "model-gpt-6.1-sol", { "progress.jsonl": `{"at":"t","url":"${base}/responses"}\n` });
    const baseMessage = await refused(run2, { OPENQODEX_BENCH_MODEL_ENV: envFile });
    expect(baseMessage).toMatch(/progress\.jsonl:1: a value from the model settings file/);
    expect(baseMessage).not.toContain(base);
  });

  it("refuses a run holding a pattern from the scrub list", async () => {
    // A word from the public list, read from it: written here, it would fail the repository's own scrub.
    const word = readFileSync(join(repoRoot, "scripts", "scrub-patterns.txt"), "utf8").split("\n").map((l) => l.trim()).find((l) => /^[a-z]+$/i.test(l));
    const run = plantedRun();
    write(join(run, "samples/demo-polyglot/claude-graph-on/1/receipt.txt"), `sent to ${word}\n`);
    expect(await refused(run)).toMatch(new RegExp(`receipt\\.txt:1: matches the scrub pattern ${word}`));
  });

  // A real case whose licence is not permissive: its code may be read in a
  // review, never published. The case repository is in the cache, where the
  // materialiser leaves it.
  function realCaseRun(cache, extraFiles = {}) {
    const run = plantedRun();
    const name = "acme__ledger-42";
    const hash = "b".repeat(64);
    write(join(run, "cases", `${name}.json`), JSON.stringify({ id: `aacr/${name}@bbbbbbbb`, suite: "aacr", name, hash, source: { licence: { spdx: "GPL-3.0-only", class: "copyleft" } } }));
    const work = join(tempDir("oq-case-repo-"), "repo");
    mkdirSync(join(work, "ledger"), { recursive: true });
    writeFileSync(join(work, "ledger", "invoice.py"), "def invoice_total(order, rates):\n    subtotal = sum(line.amount * rates[line.currency] for line in order.lines)\n    return round(subtotal, 2)\n");
    // A short function: each of its lines is shorter than any length cutoff would allow.
    writeFileSync(join(work, "ledger", "fees.py"), "def fee(x):\n    return x * 3\n");
    for (const [file, text] of Object.entries(extraFiles)) write(join(work, file), text);
    git(work, "init", "-q");
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "Base");
    const base = git(work, "rev-parse", "HEAD").trim();
    const repo = join(cache, "cases", `${hash}.git`);
    git(work, "clone", "-q", "--bare", work, repo);
    write(join(repo, "materialised.json"), JSON.stringify({ base, head: base }));
    return { run, name, repo, work, base };
  }

  // Three real commits: old, merge base, then head. The dataset's target
  // branch tip need not be the merge base, so use the materialised record.
  function reviewedTrees(cache, oldText = "historical_total = calculate_obsolete_invoice(order)\n") {
    const fixture = realCaseRun(cache);
    const { work, repo, base } = fixture;
    write(join(work, "old.py"), oldText);
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "Unrelated history");
    const old = git(work, "rev-parse", "HEAD").trim();
    git(work, "reset", "--hard", base);
    write(join(work, "deleted.py"), "deleted_total = calculate_base_invoice(order)\n");
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "Reviewed base");
    const reviewedBase = git(work, "rev-parse", "HEAD").trim();
    git(work, "rm", "-q", "deleted.py");
    write(join(work, "head.py"), "current_total = calculate_head_invoice(order)\n");
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "Reviewed head");
    const head = git(work, "rev-parse", "HEAD").trim();
    git(work, "push", "-q", repo, `${old}:refs/heads/history`, `${head}:refs/heads/review`);
    write(join(repo, "materialised.json"), JSON.stringify({ base: reviewedBase, head }));
    return { ...fixture, base: reviewedBase, head };
  }

  // --out names a folder this file removes; without it the tool makes its own.
  const dryRun = (run, cache, nodeArgs = []) => spawnSync(process.execPath, [...nodeArgs, join(repoRoot, "benchmark/publish-run.mjs"), run, "--dry-run", "--out", tempDir("oq-publish-out-")], {
    encoding: "utf8",
    env: { ...process.env, OPENQODEX_BENCH_CACHE: cache, OPENQODEX_BENCH_MODEL_ENV: join(cache, "absent.env") },
  });

  it("does not refuse a quote found only in unrelated history", async () => {
    const cache = tempDir("oq-bench-cache-");
    const { run, name } = reviewedTrees(cache);
    addSample(run, name, "claude-graph-on", { "receipt.txt": "historical_total = calculate_obsolete_invoice(order)\n" });
    expect((await packageRun(run, { out: tempDir("oq-publish-out-"), env: { OPENQODEX_BENCH_CACHE: cache } })).files).toBeGreaterThan(10);
  });

  it.each([
    ["head-only", "current_total = calculate_head_invoice(order)"],
    ["deleted base-only", "deleted_total = calculate_base_invoice(order)"],
  ])("refuses a dry run quoting a %s line with exit 1", (_kind, line) => {
    const cache = tempDir("oq-bench-cache-");
    const { run, name } = reviewedTrees(cache);
    addSample(run, name, "claude-graph-on", { "report/report.json": JSON.stringify({ quote: line }) });
    const result = dryRun(run, cache);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`a line of ${name}'s code`);
    expect(result.stdout).toBe("");
  });

  it.each(["head", "base"])("refuses a cache missing the pinned %s commit in one line", (kind) => {
    const cache = tempDir("oq-bench-cache-");
    const { run, repo, name, base, head } = reviewedTrees(cache);
    write(join(repo, "materialised.json"), JSON.stringify({ base, head, [kind]: "f".repeat(40) }));
    const result = dryRun(run, cache);
    expect(result.status).toBe(1);
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toContain(name);
    expect(result.stderr).toContain(kind);
    expect(result.stdout).toBe("");
  });

  it("refuses a cache without its materialised record in one line", async () => {
    const cache = tempDir("oq-bench-cache-");
    const { run, repo } = realCaseRun(cache);
    unlinkSync(join(repo, "materialised.json"));
    const result = dryRun(run, cache);
    expect(result.status).toBe(1);
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toContain("materialised record");
  });

  it("does not read a large blob held only in history", async () => {
    const cache = tempDir("oq-bench-cache-");
    const old = Array.from({ length: 100000 }, (_, i) => `historical_${i} = calculate_obsolete_invoice_${i}(order, rates, customer)`).join("\n");
    const { run } = reviewedTrees(cache, old);
    const result = spawnSync(process.execPath, ["--max-old-space-size=128", "--input-type=module", "-e", `
      import { packageRun } from "./benchmark/publish-run.mjs";
      const asset = await packageRun(process.argv[1], { out: process.argv[2] });
      console.log(asset.files);
    `, run, tempDir("oq-publish-out-")], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, OPENQODEX_BENCH_CACHE: cache, OPENQODEX_BENCH_MODEL_ENV: join(cache, "absent.env") },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(Number(result.stdout.trim())).toBeGreaterThan(10);
  });

  it("keeps memory bounded by the run when a reviewed tree holds many unique lines", () => {
    const cache = tempDir("oq-bench-cache-");
    const large = Array.from({ length: 400000 }, (_, i) => `reviewed_${i} = calculate_invoice_${i}(order, rates, customer)`).join("\n");
    const { run } = realCaseRun(cache, { "large.py": large });
    const result = spawnSync(process.execPath, ["--max-old-space-size=96", "--input-type=module", "-e", `
      import { packageRun } from "./benchmark/publish-run.mjs";
      const asset = await packageRun(process.argv[1], { out: process.argv[2] });
      console.log(asset.files);
    `, run, tempDir("oq-publish-out-")], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, OPENQODEX_BENCH_CACHE: cache, OPENQODEX_BENCH_MODEL_ENV: join(cache, "absent.env") },
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it("confirms the full line after a matching fingerprint", async () => {
    const cache = tempDir("oq-bench-cache-");
    const { run, name } = realCaseRun(cache, { "same.py": "shared_prefix_with_24_chars = licensed_value(order)\n" });
    addSample(run, name, "claude-graph-on", { "receipt.txt": "shared_prefix_with_24_chars = unrelated_value(order)\n" });
    expect((await packageRun(run, { out: tempDir("oq-publish-out-"), env: { OPENQODEX_BENCH_CACHE: cache } })).files).toBeGreaterThan(10);
  });

  it("does not refuse a source line found only inside a longer name, as the matcher before the index did not", async () => {
    const cache = tempDir("oq-bench-cache-");
    const { run, name } = realCaseRun(cache, { "edge.py": "total = calculate_invoice(order, rates)\n" });
    addSample(run, name, "claude-graph-on", { "receipt.txt": "subtotal = calculate_invoice(order, rates)\n" });
    expect((await packageRun(run, { out: tempDir("oq-publish-out-"), env: { OPENQODEX_BENCH_CACHE: cache } })).files).toBeGreaterThan(10);
  });

  it("finds a Unicode line in a later window of decoded run text", async () => {
    const cache = tempDir("oq-bench-cache-");
    const line = 'invoice_total = calculate_invoice(order, "価格😀")';
    const { run, name } = realCaseRun(cache, { "unicode.py": `${line}\n` });
    addSample(run, name, "claude-graph-on", { "report/report.json": JSON.stringify({ quote: `The finding quotes ${line} here.` }) });
    expect(await refused(run, { OPENQODEX_BENCH_CACHE: cache })).toContain(`a line of ${name}'s code`);
  });

  it("refuses a run whose transcript carries a line of a copyleft case's code", async () => {
    const cache = tempDir("oq-bench-cache-");
    const { run, name } = realCaseRun(cache);
    addSample(run, name, "model-gpt-6.1-sol", { "transcript.jsonl": `{"role":"tool","content":"    2\\t    subtotal = sum(line.amount * rates[line.currency] for line in order.lines)\\n"}\n` });
    expect(await refused(run, { OPENQODEX_BENCH_CACHE: cache })).toMatch(new RegExp(`samples/${name}/model-gpt-6\\.1-sol/1/transcript\\.jsonl:1: a line of ${name}'s code, whose licence class is copyleft`));
  });

  it("leaves out the brief and the trace of a copyleft case, which carry its code by design, and publishes the rest", async () => {
    const cache = tempDir("oq-bench-cache-");
    const { run, name } = realCaseRun(cache);
    addSample(run, name, "model-gpt-6.1-sol");
    write(join(run, "samples", name, "model-gpt-6.1-sol", "1", "report", "brief.md"), "    subtotal = sum(line.amount * rates[line.currency] for line in order.lines)\n");
    const asset = await packageRun(run, { out: tempDir("oq-publish-out-"), env: { OPENQODEX_BENCH_CACHE: cache } });
    expect(asset.left).toContain(`samples/${name}/model-gpt-6.1-sol/1/report/brief.md`);
    expect(asset.left).toContain(`samples/${name}/model-gpt-6.1-sol/1/report/trace.json`);
    const listed = execFileSync("tar", ["-tzf", asset.tarPath], { encoding: "utf8" });
    expect(listed).not.toContain(`${name}/model-gpt-6.1-sol/1/report/brief.md`);
    expect(listed).toContain(`${name}/model-gpt-6.1-sol/1/report/report.json`);
  });

  it("refuses a copyleft line quoted behind a file name, as search_code prints it, or inline in a finding's text", async () => {
    const cache = tempDir("oq-bench-cache-");
    const { run, name } = realCaseRun(cache);
    addSample(run, name, "model-gpt-6.1-sol", { "transcript.jsonl": `{"role":"tool","content":"ledger/invoice.py:2:     subtotal = sum(line.amount * rates[line.currency] for line in order.lines)\\n"}\n` });
    expect(await refused(run, { OPENQODEX_BENCH_CACHE: cache })).toMatch(new RegExp(`samples/${name}/model-gpt-6\\.1-sol/1/transcript\\.jsonl:1: a line of ${name}'s code`));
    const cache2 = tempDir("oq-bench-cache-");
    const second = realCaseRun(cache2);
    const finding = { title: "Refunds are counted", problem: "The total is built as `subtotal = sum(line.amount * rates[line.currency] for line in order.lines)`, which counts refunded lines.", consequence: "c", fix: "f" };
    addSample(second.run, name, "model-gpt-6.1-sol", { "report/report.json": JSON.stringify({ findings: [finding] }) });
    expect(await refused(second.run, { OPENQODEX_BENCH_CACHE: cache2 })).toMatch(new RegExp(`samples/${name}/model-gpt-6\\.1-sol/1/report/report\\.json:1: a line of ${name}'s code`));
  });

  it("refuses a copyleft line shorter than any length cutoff, such as the body of a short function, read whole or behind a search's file name", async () => {
    const cache = tempDir("oq-bench-cache-");
    const { run, name } = realCaseRun(cache);
    addSample(run, name, "model-gpt-6.1-sol", { "transcript.jsonl": `{"role":"tool","content":"    return x * 3\\n"}\n` });
    expect(await refused(run, { OPENQODEX_BENCH_CACHE: cache })).toMatch(new RegExp(`transcript\\.jsonl:1: a line of ${name}'s code`));
    const cache2 = tempDir("oq-bench-cache-");
    const second = realCaseRun(cache2);
    addSample(second.run, name, "model-gpt-6.1-sol", { "transcript.jsonl": `{"role":"tool","content":"ledger/fees.py:2:     return x * 3\\n"}\n` });
    expect(await refused(second.run, { OPENQODEX_BENCH_CACHE: cache2 })).toMatch(new RegExp(`transcript\\.jsonl:1: a line of ${name}'s code`));
  });

  it("publishes a copyleft run whose repository has common short lines (`import os`, `} else {`, `return None`) that the run's prose also holds", async () => {
    const cache = tempDir("oq-bench-cache-");
    const { run, name } = realCaseRun(cache, { "ledger/util.py": "import os\nif ready:\n    pass\n} else {\nreturn None\n" });
    addSample(run, name, "model-gpt-6.1-sol", { "receipt.txt": "The handler may return None when the order is missing; import os is unused; } else { closes the branch.\n" });
    const asset = await packageRun(run, { out: tempDir("oq-publish-out-"), env: { OPENQODEX_BENCH_CACHE: cache } });
    expect(asset.files).toBeGreaterThan(10);
  });

  it("publishes a copyleft run whose repository has one-token lines, such as `1,` in a list, that the run's own JSON also holds", async () => {
    const cache = tempDir("oq-bench-cache-");
    const { run, name } = realCaseRun(cache, { "ledger/rates.py": "RATES = [\n    1,\n    2,\n]\n" });
    addSample(run, name, "model-gpt-6.1-sol");
    // The manifest holds "repeat":1,"planned":2, as every run's does.
    const asset = await packageRun(run, { out: tempDir("oq-publish-out-"), env: { OPENQODEX_BENCH_CACHE: cache } });
    expect(asset.files).toBeGreaterThan(10);
  });

  it("refuses a run with a model reviewer when the model settings file cannot be read here, since its key and base URL cannot be looked for", async () => {
    const run = plantedRun("2026-10-10-abc1234", { path: "server", configs: ["model-gpt-6.1-sol"], reviewers: { "model:gpt-6.1-sol": { version: null, model: "gpt-6.1-sol", endpoint: "azure-openai-v1" } } });
    addSample(run, "flask-path-traversal", "model-gpt-6.1-sol", { "transcript.jsonl": `{"role":"system","note":"sent with api-key test-model-key-${randomBytes(16).toString("hex")}"}\n` });
    const missing = join(tempDir("oq-model-env-"), "azure.env");
    expect(await refused(run, { OPENQODEX_BENCH_MODEL_ENV: missing })).toMatch(/uses a model reviewer \(model:gpt-6\.1-sol\), and the model settings file .*azure\.env cannot be read here/);
  });

  it("refuses home folder paths of every platform, not only this machine's", async () => {
    for (const path of ["/home/alice/project/app.py", "/Users/bob/src/app.py", "C:\\Users\\carol\\src\\app.py"]) {
      const run = plantedRun();
      write(join(run, "samples/flask-path-traversal/claude-graph-on/1/stderr.txt"), `warning: ${path} is not a git repository\n`);
      expect(await refused(run)).toMatch(/samples\/flask-path-traversal\/claude-graph-on\/1\/stderr\.txt:1: a home folder path/);
    }
  });

  it("refuses a copyleft case whose repository is not in the cache, since its code cannot be looked for", async () => {
    const { run } = realCaseRun(tempDir("oq-bench-cache-"));
    expect(await refused(run, { OPENQODEX_BENCH_CACHE: tempDir("oq-bench-cache-empty-") })).toMatch(/acme__ledger-42 is copyleft and its repository is not in the cache/);
  });
});

describe("a run that holds a case whose licence nobody verified is published", () => {
  // A licence GitHub cannot name (NOASSERTION) makes a case usable for
  // private runs only; publishing is where it is refused.
  it("refuses the run before anything is packaged, naming every such case", async () => {
    const run = plantedRun();
    for (const [name, repo] of [["getsentry__sentry-67876", "getsentry/sentry"], ["elastic__elasticsearch-1", "elastic/elasticsearch"]]) {
      write(join(run, "cases", `${name}.json`), JSON.stringify({ id: `aacr/${name}@cccccccc`, suite: "aacr", name, hash: "c".repeat(64), source: { repo, licence: { spdx: "NOASSERTION", chosen: null, class: "unverified" } } }));
      addSample(run, name, "model-gpt-6.1-sol");
    }
    const out = tempDir("oq-publish-out-");
    await expect(packageRun(run, { out, env: { OPENQODEX_BENCH_CACHE: tempDir("oq-bench-cache-") } })).rejects.toThrow(/refused: [^\n]*unverified licence[^\n]*elastic__elasticsearch-1[^\n]*getsentry__sentry-67876/);
    expect(readdirSync(out)).toEqual([]);
  });
});
