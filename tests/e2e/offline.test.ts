import { expect, it } from "vitest";
import { demo, inventory, report, run, toolsHome } from "./support.js";
import { mkdirSync } from "node:fs";

it("disables network scanners offline without changing the tools folder", () => {
  const dir = demo("offline"); mkdirSync(toolsHome, { recursive: true });
  const before = inventory(toolsHome);
  const result = run("offline-scan", dir, ["scan", "--offline", "--format", "json"]);
  expect(result.status).toBe(0);
  expect(report(dir).scanners.find((s) => s.scanner === "osv-scanner")).toMatchObject({ status: "disabled", reason: "offline, dependency lookups are off" });
  expect(inventory(toolsHome)).toEqual(before);
});
