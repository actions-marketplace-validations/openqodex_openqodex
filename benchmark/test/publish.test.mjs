// A run leaves the machine as one asset on the benchmark-data pre-release,
// and its committed index entry is the only record of it in the tree. Two
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
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
function plantedRun(runId = "2026-10-10-abc1234") {
  const run = join(tempDir("oq-publish-"), runId);
  write(join(run, "manifest.json"), JSON.stringify({ version: 2, started_at: "2026-10-10T10:00:00.000Z", build: { commit: "a".repeat(40), short: "abc1234", dirty: false, cliVersion: "0.13.0" }, configs: ["claude-graph-on"], repeat: 1, planned: 2, cases: ["demo-polyglot", "flask-path-traversal"], ended: { how: "finished", why: null } }));
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
  it("packages a run, unpacks it with tar after the sha256 and list checks, and gets every exported file back byte for byte", () => {
    const run = plantedRun();
    const out = tempDir("oq-publish-out-");
    const asset = packageRun(run, { out });
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

  it("packages the same folder to the same bytes, so the index entry committed before the upload names the asset the session uploads", () => {
    const run = plantedRun();
    const a = packageRun(run, { out: tempDir("oq-publish-out-") });
    const b = packageRun(run, { out: tempDir("oq-publish-out-") });
    expect(b.sha256).toBe(a.sha256);
    expect(b.listHash).toBe(a.listHash);
  });

  it("refuses an asset whose bytes or file list are not the ones the index entry names", () => {
    const run = plantedRun();
    const asset = packageRun(run, { out: tempDir("oq-publish-out-") });
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
  const refused = (run, env = {}) => {
    const out = tempDir("oq-publish-out-");
    let message = null;
    try {
      packageRun(run, { out, env });
    } catch (error) {
      message = error.message;
    }
    expect(readdirSync(out)).toEqual([]);
    return message;
  };

  it("refuses a run whose trace holds the case's generated secret", () => {
    const run = plantedRun();
    const spec = JSON.parse(readFileSync(join(run, "cases", "demo-polyglot.json"), "utf8"));
    const secret = generatedValue("demo-polyglot", spec.generated[0].file, spec.generated[0].kind);
    write(join(run, "samples/demo-polyglot/claude-graph-on/1/report/trace.json"), JSON.stringify({ read: `STRIPE_KEY = "${secret}"` }));
    const message = refused(run);
    expect(message).toMatch(/samples\/demo-polyglot\/claude-graph-on\/1\/report\/trace\.json:1: the generated secret of demo-polyglot/);
    expect(message).not.toContain(secret);
  });

  it("refuses a run whose stderr holds this machine's home folder", () => {
    const run = plantedRun();
    write(join(run, "samples/flask-path-traversal/claude-graph-on/1/stderr.txt"), `warning: ${join(homedir(), "Projects", "x")} is not a git repository\n`);
    expect(refused(run)).toMatch(/samples\/flask-path-traversal\/claude-graph-on\/1\/stderr\.txt:1: the home folder path/);
  });

  it("refuses a run whose transcript holds the model key or base URL, without printing either", () => {
    const run = plantedRun();
    const envFile = join(tempDir("oq-model-env-"), "azure.env");
    const key = "k3y-f0r-the-test-0123456789abcdef";
    const base = "https://test-resource.openai.example/openai/v1";
    writeFileSync(envFile, `AZURE_OPENAI_KEY=${key}\nAZURE_OPENAI_BASE=${base}\n`);
    addSample(run, "flask-path-traversal", "model-gpt-6.1-sol", { "transcript.jsonl": `{"role":"system","note":"sent with api-key ${key}"}\n` });
    const keyMessage = refused(run, { OPENQODEX_BENCH_MODEL_ENV: envFile });
    expect(keyMessage).toMatch(/samples\/flask-path-traversal\/model-gpt-6\.1-sol\/1\/transcript\.jsonl:1: a value from the model settings file/);
    expect(keyMessage).not.toContain(key);
    const run2 = plantedRun();
    addSample(run2, "flask-path-traversal", "model-gpt-6.1-sol", { "progress.jsonl": `{"at":"t","url":"${base}/responses"}\n` });
    const baseMessage = refused(run2, { OPENQODEX_BENCH_MODEL_ENV: envFile });
    expect(baseMessage).toMatch(/progress\.jsonl:1: a value from the model settings file/);
    expect(baseMessage).not.toContain(base);
  });

  it("refuses a run holding a pattern from the scrub list", () => {
    // A word from the public list, read from it: written here, it would fail the repository's own scrub.
    const word = readFileSync(join(repoRoot, "scripts", "scrub-patterns.txt"), "utf8").split("\n").map((l) => l.trim()).find((l) => /^[a-z]+$/i.test(l));
    const run = plantedRun();
    write(join(run, "samples/demo-polyglot/claude-graph-on/1/receipt.txt"), `sent to ${word}\n`);
    expect(refused(run)).toMatch(new RegExp(`receipt\\.txt:1: matches the scrub pattern ${word}`));
  });

  // A real case whose licence is not permissive: its code may be read in a
  // review, never published. The case repository is in the cache, where the
  // materialiser leaves it.
  function realCaseRun(cache) {
    const run = plantedRun();
    const name = "acme__ledger-42";
    const hash = "b".repeat(64);
    write(join(run, "cases", `${name}.json`), JSON.stringify({ id: `aacr/${name}@bbbbbbbb`, suite: "aacr", name, hash, source: { licence: { spdx: "GPL-3.0-only", class: "copyleft" } } }));
    const work = join(tempDir("oq-case-repo-"), "repo");
    mkdirSync(join(work, "ledger"), { recursive: true });
    writeFileSync(join(work, "ledger", "invoice.py"), "def invoice_total(order, rates):\n    subtotal = sum(line.amount * rates[line.currency] for line in order.lines)\n    return round(subtotal, 2)\n");
    git(work, "init", "-q");
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "Base");
    git(work, "clone", "-q", "--bare", work, join(cache, "cases", `${hash}.git`));
    return { run, name };
  }

  it("refuses a run whose transcript carries a line of a copyleft case's code", () => {
    const cache = tempDir("oq-bench-cache-");
    const { run, name } = realCaseRun(cache);
    addSample(run, name, "model-gpt-6.1-sol", { "transcript.jsonl": `{"role":"tool","content":"    2\\t    subtotal = sum(line.amount * rates[line.currency] for line in order.lines)\\n"}\n` });
    expect(refused(run, { OPENQODEX_BENCH_CACHE: cache })).toMatch(new RegExp(`samples/${name}/model-gpt-6\\.1-sol/1/transcript\\.jsonl:1: a line of ${name}'s code, whose licence class is copyleft`));
  });

  it("leaves out the brief and the trace of a copyleft case, which carry its code by design, and publishes the rest", () => {
    const cache = tempDir("oq-bench-cache-");
    const { run, name } = realCaseRun(cache);
    addSample(run, name, "model-gpt-6.1-sol");
    write(join(run, "samples", name, "model-gpt-6.1-sol", "1", "report", "brief.md"), "    subtotal = sum(line.amount * rates[line.currency] for line in order.lines)\n");
    const asset = packageRun(run, { out: tempDir("oq-publish-out-"), env: { OPENQODEX_BENCH_CACHE: cache } });
    expect(asset.left).toContain(`samples/${name}/model-gpt-6.1-sol/1/report/brief.md`);
    expect(asset.left).toContain(`samples/${name}/model-gpt-6.1-sol/1/report/trace.json`);
    const listed = execFileSync("tar", ["-tzf", asset.tarPath], { encoding: "utf8" });
    expect(listed).not.toContain(`${name}/model-gpt-6.1-sol/1/report/brief.md`);
    expect(listed).toContain(`${name}/model-gpt-6.1-sol/1/report/report.json`);
  });

  it("refuses a copyleft case whose repository is not in the cache, since its code cannot be looked for", () => {
    const { run } = realCaseRun(tempDir("oq-bench-cache-"));
    expect(refused(run, { OPENQODEX_BENCH_CACHE: tempDir("oq-bench-cache-empty-") })).toMatch(/acme__ledger-42 is copyleft and its repository is not in the cache/);
  });
});
