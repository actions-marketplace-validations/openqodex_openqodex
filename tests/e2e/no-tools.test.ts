import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { demo, report, run } from "./support.js";

it("reports missing tools with reasons while the SQL scanner still runs", () => {
  const dir = demo("no-tools"); mkdirSync(join(dir, "db"), { recursive: true });
  writeFileSync(join(dir, "db/unsafe.sql"), "CREATE FUNCTION public.do_thing() RETURNS void\nLANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN END $$;\n");
  const empty = mkdtempSync(join(tmpdir(), "oq-empty-tools-"));
  const result = run("no-tools-scan", dir, ["scan", "--no-install", "--format", "json"], { tools: empty });
  expect(result.status).toBe(0);
  const rows = report(dir).scanners;
  expect(rows.find((s) => s.scanner === "sqllint")?.status).toBe("ran");
  expect(report(dir).findings.some((f) => f.source === "sqllint:security-definer-no-search-path")).toBe(true);
  expect(rows.filter((s) => s.status === "not_installed").length).toBeGreaterThan(0);
  expect(rows.filter((s) => s.status === "not_installed").every((s) => !!s.reason)).toBe(true);
});
