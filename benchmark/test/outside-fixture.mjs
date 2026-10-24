import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readAacrOutside, toolName } from "../lib/aacr-board.mjs";
import { tempDir } from "../../tests/temp-dirs.mjs";

export function aacrOutside(config, mean = { line: { precision: 0.4, recall: 0.5 }, semantic: null }) {
  const folder = tempDir("oq-aacr-block-");
  const write = (file, value) => { const path = join(folder, "outside/aacr", file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
  write("convert.json", { reader: "ocr", lineK: null, references: {}, withoutLine: [], folders: [{ config, repeat: 1, tool: toolName(config, 1), dir: `${config}/r1`, files: 1 }] });
  write("eval.json", { folders: [{ config, repeat: 1, mode: "llm", judgeErrors: 0, metrics: ["metrics_ocr_fixture.json"] }] });
  write(`${config}/r1/metrics_ocr_fixture.json`, { summary: { evaluated_instances: 1, missing_instances: 0, expected_notes: 5, generated_notes: 5, matched_line_notes: 2, matched_semantic_notes: 2 } });
  const block = readAacrOutside(folder, [], {});
  block.byConfig[config].mean = mean;
  return JSON.parse(JSON.stringify({ aacr: block }));
}
