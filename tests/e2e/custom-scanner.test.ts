import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import "./global-setup.js";
import { demo, report, root, run, skipNetwork } from "./support.js";

const command = "actionlint -no-color -format '{{json .}}' {target}";
function yaml(runLine: string): string { return `scanners:\n  custom:\n    - source: https://github.com/rhysd/actionlint\n      version: "1.7.12"\n      run: ${JSON.stringify(runLine)}\n      format: json-map\n      map: { items: ".", file: filepath, line: line, rule: kind, message: message }\n      paths: [".github/workflows/*.yml"]\n`; }

it.skipIf(!existsSync(join(root, "packages/scanners/src/custom/index.ts")) || readFileSync(join(root, "packages/scanners/src/custom/index.ts"), "utf8").includes("Contract stub"))("runs a trusted GitHub release and requires new trust after its command changes", () => {
  if (skipNetwork("custom actionlint release")) return;
  const dir = demo("custom"); const home = join(dir, "../custom-home");
  writeFileSync(join(dir, ".openqodex.yaml"), yaml(command));
  const first = run("custom-untrusted", dir, ["scan", "--format", "json"], { tools: home });
  expect(first.status).toBe(0);
  expect(report(dir).scanners.find((s) => s.scanner === "custom:actionlint")?.status).toBe("untrusted");
  expect(report(dir).findings.some((f) => f.source?.startsWith("custom:actionlint:"))).toBe(false);
  expect(run("custom-trust", dir, ["trust", "--yes"], { tools: home, timeout: 180_000 }).status).toBe(0);
  expect(run("custom-trusted", dir, ["scan", "--format", "json"], { tools: home }).status).toBe(0);
  expect(report(dir).findings.some((f) => f.source?.startsWith("custom:actionlint:"))).toBe(true);
  writeFileSync(join(dir, ".openqodex.yaml"), yaml(`${command} -verbose`));
  expect(run("custom-changed", dir, ["scan", "--format", "json"], { tools: home }).status).toBe(0);
  expect(report(dir).scanners.find((s) => s.scanner === "custom:actionlint")?.status).toBe("untrusted");
}, 600_000);
