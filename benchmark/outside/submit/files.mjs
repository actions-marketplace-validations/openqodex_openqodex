// Shared disk and type checks for offline submission preparation.
// The failure list and executable checks are in benchmark/test/board-submit.test.mjs.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const need = (ok, label) => { if (!ok) throw new Error(label); };
export const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
export const string = (v) => typeof v === "string" && v.length > 0;
export const number = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
export const integer = (v) => Number.isInteger(v) && v >= 0;
export const array = (v, label) => { need(Array.isArray(v), `${label} must be an array`); return v; };
export function inside(root, name) {
  const base = realpathSync(root);
  const path = resolve(base, name);
  let existing = path;
  while (!existsSync(existing)) existing = dirname(existing);
  const rel = relative(base, realpathSync(existing));
  const lexical = relative(base, path);
  need(!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../") && !isAbsolute(lexical) && lexical !== ".." && !lexical.startsWith("../"), `${name} leaves its folder`);
  return path;
}
export const read = (root, name) => JSON.parse(readFileSync(inside(root, name), "utf8"));
export const write = (root, name, body) => {
  const path = inside(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`);
};
export function newOutput(out, source) {
  out = resolve(out);
  need(!existsSync(out), `${out} exists already; choose a new output folder`);
  let parent = dirname(out);
  while (!existsSync(parent)) parent = dirname(parent);
  out = resolve(realpathSync(parent), relative(parent, out));
  const rel = relative(realpathSync(source), out);
  need(rel === ".." || rel.startsWith("../") || isAbsolute(rel), "output must be outside the source folder");
  mkdirSync(out, { recursive: true });
  return out;
}
export function main(url, build, check) {
  if (!process.argv[1] || realpathSync(process.argv[1]) !== fileURLToPath(url)) return;
  try {
    const args = process.argv.slice(2);
    if (args.length === 2 && args[0] === "--check") {
      console.log(check(resolve(args[1])));
    } else {
      need(args.length === 3 && args[1] === "--out", "usage: <run folder> --out <folder> | --check <folder>");
      console.log(build(resolve(args[0]), resolve(args[2])));
      console.log(check(resolve(args[2])));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
