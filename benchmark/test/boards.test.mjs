// Failure cases declared before implementation: missing or floating board pins,
// unhashed data, unknown reserved lists, unprobed deployments and missing prices.
// Review failures: encoded traversal, multiline assignments, floating judges,
// invalid dataset counts, mismatched meters and impossible calendar dates.
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
  it("checks metadata with both deployments probed from this Mac (2026-10-11), served as their own ids", () => {
    const input = metadata();
    expect(boardProblems(input.boards, input.prices)).toEqual([]);
    expect(Object.values(input.boards.deployments)).toHaveLength(2);
    for (const deployment of Object.values(input.boards.deployments)) {
      expect(Number.isFinite(Date.parse(deployment.probed))).toBe(true);
      expect(deployment.served).toBe(deployment.id);
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

  it("refuses an encoded data path that removes the pinned commit", () => {
    const input = metadata();
    const board = input.boards.boards.aacr;
    const path = "%2e%2e/main/dataset/positive_samples.json";
    board.data.push({
      ...board.data[0], path,
      url: `https://raw.githubusercontent.com/${board.repo}/${board.commit}/${path}`,
    });
    expect(boardProblems(input.boards, input.prices).join("\n")).toMatch(/aacr.*data\[2\].*url/);
  });

  it("refuses an empty Azure base assignment followed by a nonempty key", () => {
    expect(azureEnvProblems("AZURE_OPENAI_BASE_URL=\nAZURE_OPENAI_API_KEY=test-only-value\n"))
      .toEqual(["azure.env is missing a nonempty base URL field"]);
  });

  it("refuses judge sources outside the board's pinned repository and commit", () => {
    for (const id of ["reviewbench", "martian", "aacr"]) {
      for (const change of ["commit", "repo", "traversal"]) {
        const input = metadata();
        const board = input.boards.boards[id];
        board.judge.source = change === "repo"
          ? board.judge.source.replace(board.repo, "other/repository")
          : board.judge.source.replace(board.commit, change === "commit" ? "main" : `${board.commit}/%2e%2e/main`);
        expect(boardProblems(input.boards, input.prices).join("\n")).toMatch(new RegExp(`${id}.*judge`));
      }
    }
  });

  it("refuses missing or invalid dataset PR counts", () => {
    for (const count of [undefined, "unknown", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      for (const [id, index] of [["aacr", 0], ["martian", 0], ["reviewbench", 1]]) {
        const input = metadata();
        const file = input.boards.boards[id].data[index];
        if (count === undefined) delete file.prCount;
        else file.prCount = count;
        expect(boardProblems(input.boards, input.prices).join("\n")).toMatch(new RegExp(`${id}.*prCount`));
      }
    }
  });

  it("refuses meters with the wrong unit, token direction, model or rate scope", () => {
    for (const id of ["gpt-6.1-sol", "gpt-5.2"]) {
      for (const field of ["input", "cachedInput", "output"]) {
        for (const change of ["unit", "direction", "model", "deploymentType", "region", "context"]) {
          const input = metadata();
          const price = input.prices.models[id];
          const meter = price.meters[field];
          if (change === "unit") meter.unitOfMeasure = "1K";
          if (change === "direction") price.meters[field] = price.meters[field === "output" ? "input" : "output"];
          if (change === "model") price.meters[field] = input.prices.models[id === "gpt-5.2" ? "gpt-6.1-sol" : "gpt-5.2"].meters[field];
          if (change === "deploymentType") price.deploymentType = "Regional Standard";
          if (change === "region") meter.region = "West Europe";
          if (change === "context") price.context = "Long context";
          expect(boardProblems(input.boards, input.prices).join("\n")).toContain(`${id}.${field}`);
        }
      }
    }
  });

  it("refuses an impossible calendar read date in boards, prices and meters", () => {
    for (const target of ["board", "price", "meter"]) {
      const input = metadata();
      const price = input.prices.models["gpt-6.1-sol"];
      const entry = target === "board" ? input.boards.boards.aacr : target === "price" ? price : price.meters.input;
      entry.readDate = "2026-02-30";
      expect(boardProblems(input.boards, input.prices).join("\n")).toMatch(/readDate/);
      entry.readDate = "2024-02-29";
      expect(boardProblems(input.boards, input.prices)).toEqual([]);
    }
  });
});
