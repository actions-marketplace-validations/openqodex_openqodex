import { expect, it } from "vitest";
import { extract } from "../src/extract.js";
import { parserFor } from "../src/parser.js";
import { isFileFacts } from "../src/safe-fs.js";

it.each(["promise", "awaited"])("refuses a cached TypeRef with a non-boolean %s flag", async (flag) => {
  const parser = await parserFor("typescript");
  const tree = parser.parse("export async function find(): Promise<Item> { return new Item(); }");
  if (!tree) throw new Error("no tree");
  const facts = extract(tree, "typescript");
  const result = facts.defs.find((d) => d.name === "find")?.results?.[0];
  expect(result).toBeDefined();
  expect(isFileFacts(facts)).toBe(true);
  Object.assign(result as object, { [flag]: "x" });
  expect(isFileFacts(facts)).toBe(false);
});
