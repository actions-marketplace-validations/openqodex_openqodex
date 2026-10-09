// Failure this guards: a timer left running by the tool resolver keeps the
// process alive for the whole install budget, so every scan takes 45 seconds
// even when nothing is installed or everything already is.
import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, expect, it } from "vitest";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const dist = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist", "index.js");

it("a process that resolved a tool with a 45 second budget exits at once, not when the budget ends", async () => {
  const home = tempDir("openqodex-exit-");
  const script = `
    const { createToolResolver } = await import(${JSON.stringify(pathToFileURL(dist).href)});
    const resolve = createToolResolver({ allowInstall: false, installBudgetMs: 45000 });
    const result = await resolve("gitleaks");
    console.log(result.ok ? "ok" : result.status);
  `;
  const started = Date.now();
  try {
    const stdout = await new Promise<string>((done, fail) => {
      execFile(
        process.execPath,
        ["--input-type=module", "-e", script],
        { env: { ...process.env, OPENQODEX_HOME: home }, timeout: 20_000 },
        (error, out) => (error ? fail(error) : done(out)),
      );
    });
    expect(stdout.trim()).toBe("not_installed");
    expect(Date.now() - started).toBeLessThan(10_000);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
