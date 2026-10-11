// An old run must be rescored with the scorer that wrote its stored score,
// taken from the run's own asset (_archive/<commit>/), never with today's.
// Guarded failure: an old run is rescored with today's scorer, which
// refuses its specs. The first run's own cases/demo-polyglot.json has no
// `mentions`, which today's validator requires, so today's scorer cannot
// score it at all, and a rescore that fell back to it would either fail or,
// worse, quietly score other rules.
//
// The run and its scorer come from git history (the commit the recipe names
// as holding the originals), so this test needs a full clone; in a shallow
// clone it is skipped and says why.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { repoRoot } from "../lib/cases.mjs";
import { archiveScorers, readRecipes, rescoreRun } from "../legacy/rescore.mjs";
import { loadRun } from "../score.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const RUN = "2026-10-08-752b77f";
const recipe = readRecipes().runs[RUN];
const own = recipe.scores.find((s) => s.file === "score.json");
const inHistory = (commit) => {
  try {
    execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: repoRoot, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const history = inHistory(recipe.originals.commit) && inHistory(own.scorer.commit);

// The run folder exactly as the commit holds it, in a temp results folder.
function runFromHistory() {
  const results = tempDir("oq-rescore-");
  const tar = execFileSync("git", ["archive", "--format=tar", recipe.originals.commit, `benchmark/results/${RUN}`], { cwd: repoRoot, maxBuffer: 1 << 28 });
  execFileSync("tar", ["-x", "-C", results, "--strip-components", "2"], { input: tar });
  return results;
}

describe.skipIf(!history)("an old run is rescored with the scorer that wrote its score", () => {
  it("reproduces the first run's score.json with its archived scorer, where today's scorer refuses the run's own specs", async () => {
    const results = runFromHistory();
    expect(() => loadRun(join(results, RUN))).toThrow(/mentions must be a non-empty list/);
    // Without its archive the run is refused, never scored with today's scorer instead.
    await expect(rescoreRun(RUN, { results, files: ["score.json"], docs: false })).rejects.toThrow(new RegExp(`no archived scorer _archive/${own.scorer.commit}`));
    archiveScorers(join(results, RUN), [own.scorer.commit]);
    const r = await rescoreRun(RUN, { results, files: ["score.json"], docs: false });
    expect(r.files).toHaveLength(1);
    expect(r.files[0]).toMatchObject({ file: "score.json", scorer: `_archive/${own.scorer.commit}/benchmark/score.mjs`, byConfig: "equal", differs: [] });
    expect(r.ok).toBe(true);
  });
});
