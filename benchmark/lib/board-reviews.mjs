// Both boards read the same first attempt and every finding the developer
// saw, including incomplete reports. The frozen suite is the denominator.
// Failure cases are in test/greptile-run.test.mjs and martian-board.test.mjs.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { benchRoot } from "./cases.mjs";
import { nativeReviewBody } from "./claude-control.mjs";
import { boardConfigOf, boardToolName, martianBody } from "./martian-board.mjs";
import { attemptOf, findingId, judgeFieldsMissing, normPath, population, shownFindings } from "./score.mjs";
import { readCase, readSuite, realCaseId } from "./suites.mjs";

export { boardToolName, martianBody, martianToolName } from "./martian-board.mjs";

const readJsonOr = (path) => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
const dirs = (path) => existsSync(path) ? readdirSync(path, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : [];
const byName = (a, b) => a < b ? -1 : a > b ? 1 : 0;

/** Every saved attempt, in the shape score.mjs population reads. */
export function readAttempts(folder) {
  const out = [];
  for (const c of dirs(join(folder, "samples"))) {
    for (const config of dirs(join(folder, "samples", c))) {
      for (const n of dirs(join(folder, "samples", c, config))) {
        const dir = join(folder, "samples", c, config, n);
        const which = attemptOf(n);
        if (which === null) throw new Error(`${dir} is not an attempt folder (<repeat> or <repeat>-attempt<n>)`);
        out.push({ case: c, config, ...which, row: readJsonOr(join(dir, "sample.json")), report: readJsonOr(join(dir, "report", "report.json")) });
      }
    }
  }
  return out;
}

/** What happened to a planned review's first attempt. */
export const statusOf = (first) => first === null ? "unstarted" : nativeReviewBody(first.row) !== null ? first.row.status : first.report === null ? "failed" : first.report.completion?.status === "complete" ? "complete" : "incomplete";

/** A finding lacking any judge sentence holds every review of its tool. */
export function heldFindings(review) {
  return review.shown.flatMap((f, index) => {
    const lacking = judgeFieldsMissing(f);
    return lacking.length === 0 ? [] : [{ tool: review.tool, caseId: review.caseId, case: review.case, index, findingId: review.findingIds[index], lacking }];
  });
}

/** One first attempt as comments, with stable finding or native source ids. */
export function boardReview(job) {
  const first = job.first;
  const status = job.notRun ? "not-run" : statusOf(first);
  const native = nativeReviewBody(first?.row);
  const shown = shownFindings(first?.report ?? null);
  const findingIds = native !== null ? native.trim() ? [createHash("sha256").update(JSON.stringify({ caseId: job.caseId, config: job.config, repeat: job.repeat, attempt: 1, nativeBody: native })).digest("hex")] : [] : shown.map((f) => findingId(job.caseId, f));
  const comments = native !== null ? native.trim() ? [{ path: null, line: null, body: native, created_at: first.row.started_at ?? null }] : [] : shown.map((f) => ({ path: normPath(f.file_path) || null, line: Number.isInteger(f.line_number) ? f.line_number : null, body: martianBody(f), created_at: first?.row?.started_at ?? null, tier: f.tier ?? "finding" }));
  return { ...job, status, shown, native, findingIds, comments };
}

/**
 * A run's suite cases and one review per suite case per tool name. No truth
 * is read here, so Martian can log its held-out access before reading it.
 */
export function readBoardReviews(folder, { root = benchRoot } = {}) {
  const manifestBytes = readFileSync(join(folder, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const suite = readSuite(manifest.suite, { root });
  const cases = suite.file.cases.map((e) => readCase(realCaseId(manifest.suite, e.name, e.hash), { root }));
  const byId = new Map(cases.map((c) => [c.id, c]));
  const attempts = readAttempts(folder);
  const pop = population(manifest, attempts);
  const problems = [...pop.problems];
  if (pop.jobs.length === 0) problems.push("the run plans no review");
  for (const j of pop.jobs) {
    if (!byId.has(j.caseId)) throw new Error(`${j.caseId}: not in the frozen ${manifest.suite} suite`);
    if (manifest.caseHashes?.[j.case] !== byId.get(j.caseId).hash) throw new Error(`${j.caseId}: the run's case hash differs from the frozen suite`);
  }
  for (const c of cases) if (manifest.caseHashes?.[c.name] !== undefined && manifest.caseHashes[c.name] !== c.hash) throw new Error(`${c.id}: the run's case hash differs from the frozen suite`);
  const planned = new Set(pop.jobs.map((j) => j.case));
  for (const a of attempts) if (!planned.has(a.case)) problems.push(`samples/${a.case}/${a.config}: a sample of ${a.case}, which the run did not plan`);
  for (const a of pop.unplanned) if (planned.has(a.case)) problems.push(`samples/${a.case}/${a.config}/${a.repeat}: a review the run did not plan`);
  const tools = new Map();
  for (const j of pop.jobs) {
    try {
      const tool = boardToolName(j.config, j.repeat);
      const was = tools.get(tool);
      if (was && was.config !== j.config) problems.push(`${was.config} and ${j.config} would both go by the tool name ${tool}`);
      else tools.set(tool, { tool, config: j.config, repeat: j.repeat, boardConfig: boardConfigOf(j.config) });
    } catch (error) { problems.push(error.message); }
  }
  if (problems.length > 0) throw new Error([...new Set(problems)].join("; "));
  const toolRows = [...tools.values()].sort((a, b) => byName(a.tool, b.tool));
  const reviews = [];
  for (const t of toolRows) {
    const jobs = new Map(pop.jobs.filter((j) => j.config === t.config && j.repeat === t.repeat).map((j) => [j.caseId, j]));
    for (const c of cases) reviews.push(boardReview({ ...(jobs.get(c.id) ?? { case: c.name, caseId: c.id, config: t.config, repeat: t.repeat, first: null, notRun: true }), tool: t.tool }));
  }
  const held = reviews.flatMap(heldFindings);
  return { manifest, manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"), suite: { name: manifest.suite, cases: cases.map((c) => c.id) }, cases, reviews, tools: toolRows.map((t) => ({ ...t, held: held.some((h) => h.tool === t.tool) })), held };
}
