import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import "./global-setup.js";
import { demo, report, run } from "./support.js";

it("blocks critical findings and passes when their rule tokens are disabled", () => {
  const dir = demo("block");
  writeFileSync(join(dir, ".openqodex.yaml"), "review:\n  block_on_severity: critical\n");
  const blocked = run("block-critical", dir, ["scan", "--format", "json"]);
  expect(blocked.status).toBe(1);
  const critical = report(dir).findings.filter((f) => f.severity === "critical");
  expect(critical.length).toBeGreaterThan(0);
  writeFileSync(join(dir, ".openqodex.yaml"), `review:\n  block_on_severity: critical\n  disabled_rules:\n${[...new Set(critical.map((f) => f.source))].map((t) => `    - ${JSON.stringify(t)}`).join("\n")}\n`);
  const allowed = run("block-disabled", dir, ["scan", "--format", "json"]);
  expect(allowed.status).toBe(0);
  expect(report(dir).findings.some((f) => f.severity === "critical")).toBe(false);
}, 600_000);
