// Failure cases: a form overwrites the plain record or changes the wrong comment boundaries.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { calibrationPaths, commentsInForm, main, writeCalibration } from "../outside/calibrate.mjs";
import { judgeGreptile } from "../outside/boards/greptile-judge.mjs";

const folders = [];
const tempDir = () => { const folder = mkdtempSync(join(tmpdir(), "oq-calibration-form-")); folders.push(folder); return folder; };
afterAll(() => { for (const folder of folders) rmSync(folder, { recursive: true, force: true }); });
const startedAt = "2026-10-24T12:34:56.789Z";

it("a form variant writes under its own name and never replaces the plain record", () => {
  const root = tempDir();
  const plain = calibrationPaths("greptile", startedAt, { root });
  expect(plain.output).toBe(join(root, "index/calibration/greptile-2026-10-24.json"));
  expect(plain.run).toBe(join(root, "results/calibration-greptile-2026-10-24T12-34-56-789Z"));
  mkdirSync(join(root, "index/calibration"), { recursive: true });
  const bytes = '{"status":"complete","plain":"unchanged"}\n';
  writeFileSync(plain.output, bytes);
  for (const form of ["flat", "joined"]) {
    const variant = calibrationPaths("greptile", startedAt, { root, form });
    expect(variant.output).toBe(join(root, "index/calibration", `greptile-2026-10-24-${form}.json`));
    expect(variant.run).toBe(`${plain.run}-${form}`);
    writeCalibration(variant.output, { status: "complete" }, form);
    expect(JSON.parse(readFileSync(variant.output, "utf8"))).toEqual({ form, status: "complete" });
    expect(readFileSync(plain.output, "utf8")).toBe(bytes);
    expect(() => calibrationPaths("greptile", startedAt, { root, form })).toThrow(new RegExp(`greptile-2026-10-24-${form}\\.json exists`));
  }
  expect(() => calibrationPaths("greptile", startedAt, { root })).toThrow(/greptile-2026-10-24\.json exists/);

  const variantsOnly = tempDir();
  mkdirSync(join(variantsOnly, "index/calibration"), { recursive: true });
  for (const form of ["flat", "joined"]) writeFileSync(calibrationPaths("greptile", startedAt, { root: variantsOnly, form }).output, JSON.stringify({ form }));
  const afterVariants = calibrationPaths("greptile", startedAt, { root: variantsOnly });
  expect(afterVariants.output).toBe(join(variantsOnly, "index/calibration/greptile-2026-10-24.json"));
  writeCalibration(afterVariants.output, { status: "complete" });
  expect(JSON.parse(readFileSync(afterVariants.output, "utf8"))).toEqual({ status: "complete" });
});

it("flat and joined transform the comments as named", async () => {
  const comments = Object.freeze(["  First issue\n\n```js\nawait task()\n```  ", "Second\tissue\r\nwith impact."]);
  const expected = {
    flat: ["First issue `js await task() `", "Second issue with impact."],
    joined: [comments.join("\n\n")],
  };
  expect(commentsInForm(comments)).toEqual(comments);
  for (const form of ["flat", "joined"]) {
    expect(commentsInForm(comments, form)).toEqual(expected[form]);
    expect(commentsInForm([], form)).toEqual([]);
    const cases = [comments, []].map((bodies, i) => ({ id: `case-${i}`, comments: commentsInForm(bodies, form), truthSets: { greptile: { items: [{ text: "The callback is not awaited." }] } } }));
    const requests = [];
    const verdicts = await judgeGreptile(cases, { truthSet: "greptile", complete: async (request) => {
      requests.push(request); return { match: request.comments.length > 0 };
    } });
    expect(requests.map((r) => r.comments)).toEqual([expected[form], []]);
    expect(verdicts).toEqual([{ id: "case-0", label: "caught" }, { id: "case-1", label: "missed" }]);
  }
});

it("shows the form flag through the CLI help path without loading a judge", () => {
  const result = spawnSync(process.execPath, ["benchmark/outside/calibrate.mjs", "--board", "greptile", "--form", "flat", "--help"], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("--form flat|joined");
  expect(result.stderr).toBe("");
});

it("refuses a Martian form in one line before loading inputs or a judge", async () => {
  await expect(main(["--board", "martian", "--form", "flat"])).rejects.toThrow(/^--form is only supported for --board greptile$/);
});

it("refuses an unknown or missing form before loading inputs or a judge", async () => {
  for (const args of [["--form", "unknown"], ["--form"], ["--other", "flat"]]) {
    await expect(main(["--board", "greptile", ...args])).rejects.toThrow(/usage:.*--form flat\|joined/);
  }
});
