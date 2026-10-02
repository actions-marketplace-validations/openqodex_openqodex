import { beforeAll, afterAll } from "vitest";
import { mkdirSync } from "node:fs";
import { root, run, toolsHome, printReceipt, installed } from "./support.js";

// Imported by each group. Vitest runs files serially, and the shared marker
// avoids a second install when a test file has a separate module isolate.
beforeAll(() => {
  if (process.env.OPENQODEX_E2E_OFFLINE === "1" || installed()) return;
  mkdirSync(toolsHome, { recursive: true });
  const result = run("doctor-install", root, ["doctor", "--install"], { tools: toolsHome, timeout: 1_200_000 });
  if (result.status !== 0) throw new Error(`doctor --install exited ${result.status}: ${result.stderr}`);
}, 1_200_000);
afterAll(printReceipt);
