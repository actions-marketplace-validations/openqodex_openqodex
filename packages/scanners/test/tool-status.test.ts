// What doctor and the resolver say about a scanner the build has no install
// recipe for. Ways it could fail, written before the code:
// 1. A scanner with no recipe that does not run inside OpenQodex is reported
//    as ready or built in, so doctor claims a scanner this build cannot run.
// 2. The resolver answers such a scanner as if it ran inside OpenQodex.
// 3. The scanner that does run inside OpenQodex (sqllint) is reported as
//    anything but built in and ready.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createToolResolver, toolStatuses } from "../src/toolchain/index.js";
import { loadToolchain } from "../src/toolchain/table.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

// Removes the temp folders this file made.
afterAll(removeTempDirs);

const NO_RECIPE = "no install recipe; this build cannot run it";

describe("a scanner with no install recipe", () => {
  const table = loadToolchain();
  const saved = table.tools.zizmor;
  const savedHome = process.env.OPENQODEX_HOME;
  // A build that lacks zizmor's recipe, in an empty home.
  beforeEach(() => {
    delete table.tools.zizmor;
    process.env.OPENQODEX_HOME = tempDir("oq-tool-status-");
  });
  afterEach(() => {
    if (saved) table.tools.zizmor = saved;
    if (savedHome === undefined) delete process.env.OPENQODEX_HOME;
    else process.env.OPENQODEX_HOME = savedHome;
  });

  it("is never reported ready or built in; only the in-process scanner is (1, 3)", async () => {
    const statuses = await toolStatuses();
    expect(statuses.find((s) => s.scanner === "zizmor")).toEqual({ scanner: "zizmor", state: "unsupported", version: "none", detail: NO_RECIPE });
    expect(statuses.find((s) => s.scanner === "sqllint")).toEqual({ scanner: "sqllint", state: "ready", version: "built in", detail: "runs inside openqodex" });
  }, 60_000);

  it("resolves as not installed with that reason (2)", async () => {
    expect(await createToolResolver({ allowInstall: true, installBudgetMs: 0 })("zizmor")).toEqual({ ok: false, status: "not_installed", reason: NO_RECIPE });
  });
});
