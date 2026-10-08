#!/usr/bin/env node
// Scores the built graph package against the correctness corpus.
//
//   node packages/graph/scripts/score.mjs [corpus folder]
//
// Prints one JSON row per case and a last row with the totals and the gate,
// and exits 1 when the gate fails (every case counts, known failures too).
// Run `pnpm --filter @openqodex/graph build` first: this scores dist/, what
// ships, while packages/graph/test/corpus.test.ts scores the source.
//
// The scorer itself is corpus/score.ts, the one the test runs, so the two
// can never score by different rules. esbuild (the bundler tsup uses)
// bundles it into a temp file with its import of the graph's source pointed
// at the built dist/index.js and @openqodex/core left to the installed
// package; nothing of the graph's source goes into the bundle.
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist", "index.js");
const corpus = resolve(process.argv[2] ?? join(here, "..", "corpus"));

const require = createRequire(import.meta.url);
const tsup = dirname(require.resolve("tsup/package.json"));
const esbuild = createRequire(join(tsup, "package.json"))("esbuild");

const out = mkdtempSync(join(tmpdir(), "oq-score-"));
const outfile = join(out, "score.mjs");
try {
  await esbuild.build({
    entryPoints: [join(here, "..", "corpus", "score.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile,
    logLevel: "error",
    plugins: [
      {
        name: "built-package",
        setup(build) {
          build.onResolve({ filter: /^\.\.\/src\/index\.js$/ }, () => ({ path: pathToFileURL(dist).href, external: true }));
          build.onResolve({ filter: /^@openqodex\/core$/ }, () => ({ path: import.meta.resolve("@openqodex/core"), external: true }));
        },
      },
    ],
  });
  const { scoreCorpus, value } = await import(pathToFileURL(outfile).href);
  const scored = await scoreCorpus(corpus);
  const v = (r) => Number(value(r).toFixed(4));
  for (const c of scored.cases) {
    const recall = Object.fromEntries(Object.entries(c.recall).map(([k, r]) => [k, v(r)]));
    console.log(JSON.stringify({ case: c.case, pass: c.pass, knownFailure: c.knownFailure, precision: v(c.precision), recall, validity: v(c.validity), gaps: v(c.gaps), cuts: v(c.cuts), controls: v(c.controls), ms: c.ms, failures: c.failures }));
  }
  const t = scored.totals;
  const counts = (r) => `${r.hit}/${r.of}`;
  console.log(
    JSON.stringify({
      totals: {
        cases: t.cases,
        passed: t.passed,
        precision: counts(t.precision),
        recall: Object.fromEntries(Object.entries(t.recall).map(([k, r]) => [k, counts(r)])),
        validity: counts(t.validity),
        gaps: counts(t.gaps),
        cuts: counts(t.cuts),
        controls: counts(t.controls),
      },
      gate: scored.gate.pass ? "pass" : "fail",
      failing: scored.gate.failing,
    }),
  );
  process.exitCode = scored.gate.pass ? 0 : 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
