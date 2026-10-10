import { describe, expect, it } from "vitest";
import { parseHadolintJson } from "./hadolint.js";

describe("parseHadolintJson", () => {
  it("empty or non-list output yields no findings instead of a parse error", () => {
    expect(parseHadolintJson("")).toEqual([]);
    expect(parseHadolintJson(JSON.stringify({}))).toEqual([]);
  });

  it("an entry without a code gets a rule id and no wiki link; one without a file or line is dropped", () => {
    const report = [
      { file: "", line: 1, level: "error", code: "DL1", message: "m" },
      { file: "Dockerfile", line: 0, level: "error", code: "DL1", message: "m" },
      { file: "Dockerfile", line: 5, level: "warning", message: "m" },
    ];
    const out = parseHadolintJson(JSON.stringify(report));
    expect(out).toHaveLength(1);
    expect(out[0].ruleId).toBe("hadolint");
    expect(out[0].reference).toBeNull();
  });
});
