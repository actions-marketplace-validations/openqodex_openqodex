import { mkdirSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { Report } from "@openqodex/core";
import { demo, listing, report, run, toolsHome } from "./support.js";

describe("scan --offline", () => {
  let status: number | null; let found: Report; let before: Record<string, string>; let after: Record<string, string>;
  beforeAll(() => {
    const dir = demo("offline"); mkdirSync(toolsHome, { recursive: true });
    before = listing(toolsHome);
    status = run("offline-scan", dir, ["scan", "--offline", "--format", "json"]).status;
    after = listing(toolsHome);
    found = report(dir);
  }, 300_000);

  it("disables the three scanners the demo needs that need the network, and says why", () => {
    expect(status).toBe(0);
    expect(found.scanners.filter((s) => s.status === "disabled").map((s) => [s.scanner, s.reason])).toEqual([
      ["semgrep", "offline, the rule packs need the network"],
      ["osv-scanner", "offline, dependency lookups are off"],
      ["kubeconform", "offline, schema downloads are off"],
    ]);
  });
  it("downloads or writes nothing in the tools folder", () => {
    expect(after).toEqual(before);
  });
});
