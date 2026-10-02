// Fails when a tracked file contains private material. The patterns live in
// scripts/scrub-patterns.txt, one case-insensitive regular expression per line.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const patternFile = "scripts/scrub-patterns.txt";
const excluded = new Set([patternFile, "scripts/scrub.mjs"]);

const patterns = readFileSync(join(root, patternFile), "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"))
  .map((source) => ({ source, regex: new RegExp(source, "i") }));

const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter((file) => file && !excluded.has(file));

let hits = 0;
for (const file of files) {
  const path = join(root, file);
  if (!existsSync(path)) continue;
  const buffer = readFileSync(path);
  // No file is exempt. UTF-16 text is decoded; anything else is read as UTF-8,
  // which still exposes ASCII patterns inside a binary file.
  const utf16 = buffer.length >= 2 && ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff));
  const text = utf16 ? new TextDecoder(buffer[0] === 0xff ? "utf-16le" : "utf-16be").decode(buffer) : buffer.toString("utf8");
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    for (const { source, regex } of patterns) {
      if (regex.test(line)) {
        console.error(`${file}:${index + 1}: matches ${source}`);
        hits += 1;
      }
    }
  });
}

if (hits) {
  console.error(`scrub: ${hits} hit(s) in tracked files`);
  process.exit(1);
}
console.log(`scrub: ${files.length} tracked files clean`);
