// Failure cases declared before implementation: missing or floating board pins,
// unhashed data, unknown reserved lists, unprobed deployments and missing prices.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { boardProblems, azureEnvProblems } from "../outside/check-boards.mjs";

const read = (name) => JSON.parse(readFileSync(new URL(`../outside/${name}.json`, import.meta.url), "utf8"));
const metadata = () => ({ boards: read("boards"), prices: read("prices") });
const ready = () => {
  const input = metadata();
  for (const deployment of Object.values(input.boards.deployments)) {
    deployment.probed = "2026-10-10T00:00:00Z";
    deployment.served = `${deployment.id}-2026-01-01`;
  }
  return input;
};

describe("outside board pins", () => {
  it("checks metadata while leaving both deployments explicitly unprobed", () => {
    const input = metadata();
    expect(boardProblems(input.boards, input.prices)).toEqual([]);
    expect(Object.values(input.boards.deployments)).toHaveLength(2);
    for (const deployment of Object.values(input.boards.deployments)) {
      expect(deployment.probed).toBeNull();
      expect(deployment.served).toBeNull();
    }
  });

  it("refuses a run against an unpinned board commit or an unprobed model id", () => {
    const input = ready();
    expect(boardProblems(input.boards, input.prices, { ready: true })).toEqual([]);
    input.boards.boards.martian.commit = "main";
    input.boards.deployments.reviewer.probed = null;
    input.boards.deployments.judge.served = null;
    const problems = boardProblems(input.boards, input.prices, { ready: true }).join("\n");
    expect(problems).toMatch(/martian.*commit/);
    expect(problems).toMatch(/reviewer.*probed/);
    expect(problems).toMatch(/judge.*served/);
  });

  for (const [name, breakPin, message] of [
    ["a missing board", (b) => { delete b.boards.aacr; }, /aacr/],
    ["unhashed data", (b) => { delete b.boards.aacr.data[0].sha256; }, /sha256/],
    ["a floating data URL", (b) => { b.boards.aacr.data[0].url = b.boards.aacr.data[0].url.replace(b.boards.aacr.commit, "main"); }, /url/],
    ["an unknown reserved list", (b) => { b.boards.reviewbench.reservedPrUrls = null; b.boards.reviewbench.note = "Corpus unavailable"; }, /reservedPrUrls/],
    ["a duplicate reserved PR", (b) => { b.boards.martian.reservedPrUrls[1] = b.boards.martian.reservedPrUrls[0]; }, /reservedPrUrls/],
    ["a missing judge", (b) => { delete b.boards.martian.judge; }, /judge/],
    ["a deployment without a probe field", (b) => { delete b.deployments.reviewer.probed; }, /probed/],
    ["a model alias", (b) => { b.aliases.latest = "gpt-6.1-sol"; }, /aliases/],
  ]) {
    it(`refuses ${name} before a run`, () => {
      const input = ready();
      breakPin(input.boards);
      expect(boardProblems(input.boards, input.prices, { ready: true }).join("\n")).toMatch(message);
    });
  }

  it("allows an explicitly unavailable ReviewBench list only in metadata checks", () => {
    const input = metadata();
    input.boards.boards.reviewbench.reservedPrUrls = null;
    input.boards.boards.reviewbench.note = "No machine-readable corpus list is published.";
    expect(boardProblems(input.boards, input.prices)).toEqual([]);
    delete input.boards.boards.reviewbench.note;
    expect(boardProblems(input.boards, input.prices).join("\n")).toMatch(/note/);
  });

  it("refuses a missing price, source or read date", () => {
    for (const field of ["input", "cachedInput", "output", "source", "readDate"]) {
      const input = metadata();
      delete input.prices.models["gpt-6.1-sol"][field];
      expect(boardProblems(input.boards, input.prices).join("\n")).toContain(field);
    }
  });

  it("allows an explicitly unpriced meter with a search note but refuses a missing field", () => {
    const input = metadata();
    const price = input.prices.models["gpt-6.1-sol"];
    price.input = null;
    price.notes = { input: "No input meter found searching productName, meterName and skuName for gpt-6.1-sol." };
    price.meters.input = null;
    expect(boardProblems(input.boards, input.prices)).toEqual([]);
    delete price.notes.input;
    expect(boardProblems(input.boards, input.prices).join("\n")).toMatch(/input.*note/);
    price.notes.input = "No input meter found searching for gpt-6.1-sol.";
    delete price.input;
    expect(boardProblems(input.boards, input.prices).join("\n")).toContain("input");
  });

  it("refuses a found price without its exact meter provenance", () => {
    for (const field of ["meterName", "productName", "region", "unitOfMeasure", "readDate", "source"]) {
      const input = metadata();
      delete input.prices.models["gpt-6.1-sol"].meters.input[field];
      expect(boardProblems(input.boards, input.prices).join("\n")).toContain(field);
    }
  });

  it("checks both Azure fields without returning their contents", () => {
    const base = "https://example.invalid/openai/v1";
    const key = "test-only-value";
    expect(azureEnvProblems(`AZURE_OPENAI_BASE_URL=${base}\nAZURE_OPENAI_API_KEY=${key}\n`)).toEqual([]);
    for (const content of ["", `AZURE_OPENAI_BASE_URL=${base}`, `AZURE_OPENAI_API_KEY=${key}`, 'AZURE_OPENAI_BASE_URL=""\nAZURE_OPENAI_API_KEY=']) {
      const problems = azureEnvProblems(content).join("\n");
      expect(problems).not.toBe("");
      expect(problems).not.toContain(base);
      expect(problems).not.toContain(key);
    }
  });
});
