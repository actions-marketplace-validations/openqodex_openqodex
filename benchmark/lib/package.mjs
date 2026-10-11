// The build a run benchmarks (run.mjs --package): the checkout's own build
// (`local`, the default, whose commit benchmark/build-cli.mjs records), or a
// package build as users install it:
//   npm:<version>     the published openqodex at that version, fetched once
//                     with `npm pack` into the cache
//   file:<path.tgz>   a packed build, as `npm pack` writes it (a release
//                     candidate before it is published)
// A package build is unpacked once into
// $OPENQODEX_BENCH_CACHE/packages/openqodex-<first 16 hex of the tarball's
// sha256>/package/, beside its record.json, and a run uses its dist/bin.js
// and dist/lib.js.
//
// Failure list, written before the code:
// 1. A run on a package build is recorded as the checkout's commit, or
//    without the package's version and sha: the record names the package,
//    its version, the tarball's sha256 and sha512 integrity and its size,
//    and run.mjs records no commit for it.
// 2. The tarball the registry served is not the one the run uses (a cache
//    file edited, or a download cut short): the registry's integrity is
//    kept beside the cached tarball and checked against its bytes on every
//    use.
// 3. A tarball holds another package or another version than asked: its
//    package.json must name openqodex, at the version asked for npm, and
//    the unpacked folder must hold dist/bin.js and dist/lib.js.
// 4. A half-unpacked folder is used: a package is unpacked in a temp folder
//    beside its place, checked, given its record last, and renamed into
//    place whole.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { cacheRoot } from "./licence.mjs";

export const PACKAGE_NAME = "openqodex";
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** A --package value: { kind: "local" }, { kind: "npm", version } or { kind: "file", path }; throws on anything else. */
export function parsePackageSpec(spec) {
  if (spec === "local") return { kind: "local" };
  if (typeof spec === "string" && spec.startsWith("npm:")) {
    const version = spec.slice(4);
    if (!VERSION.test(version)) throw new Error(`--package npm:<version> takes a version such as 0.12.0, not ${JSON.stringify(version)}`);
    return { kind: "npm", version };
  }
  if (typeof spec === "string" && spec.startsWith("file:") && spec.endsWith(".tgz")) return { kind: "file", path: resolve(spec.slice(5)) };
  throw new Error(`--package takes local, npm:<version> or file:<path to a .tgz npm pack wrote>, not ${JSON.stringify(spec)}`);
}

const integrityOf = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const said = (r) => `${r.stderr ?? ""}`.trim().split("\n").filter(Boolean).slice(-3).join(" | ") || `exit ${r.status ?? r.signal}`;

// The published tarball of `version`, from the cache or fetched with npm
// pack (failure 2): { path, registryIntegrity }.
function npmTarball(version, cache) {
  const dir = join(cache, "packages", "npm");
  const path = join(dir, `${PACKAGE_NAME}-${version}.tgz`);
  const meta = join(dir, `${PACKAGE_NAME}-${version}.json`);
  if (!existsSync(path) || !existsSync(meta)) {
    mkdirSync(dir, { recursive: true });
    const temp = mkdtempSync(join(dir, ".fetch-"));
    try {
      const r = spawnSync("npm", ["pack", `${PACKAGE_NAME}@${version}`, "--json", "--pack-destination", temp], { cwd: temp, encoding: "utf8", maxBuffer: 1 << 26 });
      if (r.error) throw new Error(`npm could not be started: ${r.error.message}`);
      if (r.status !== 0) throw new Error(`npm pack ${PACKAGE_NAME}@${version} failed: ${said(r)}`);
      const answer = JSON.parse(r.stdout)[0];
      if (answer?.name !== PACKAGE_NAME || answer?.version !== version || !String(answer?.integrity ?? "").startsWith("sha512-")) throw new Error(`npm pack answered for ${answer?.name}@${answer?.version} with integrity ${answer?.integrity}, not ${PACKAGE_NAME}@${version} with a sha512 integrity`);
      renameSync(join(temp, answer.filename), path);
      writeFileSync(meta, `${JSON.stringify({ name: answer.name, version: answer.version, integrity: answer.integrity, shasum: answer.shasum ?? null, fetchedAt: new Date().toISOString() }, null, 2)}\n`);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
  const registryIntegrity = JSON.parse(readFileSync(meta, "utf8")).integrity;
  const got = integrityOf(readFileSync(path));
  if (got !== registryIntegrity) throw new Error(`${path} has integrity ${got}, not the ${registryIntegrity} the registry gave; move it and ${basename(meta)} to the Trash to fetch it again`);
  return { path, registryIntegrity };
}

/**
 * The package build `spec` names, unpacked in the cache: { dir, cli, lib,
 * record }, where record is what the manifest's `package` holds. Null for
 * `local`. Throws when it cannot be fetched, read or checked.
 */
export function preparePackage(spec, { cache = cacheRoot() } = {}) {
  const p = parsePackageSpec(spec);
  if (p.kind === "local") return null;
  const from = p.kind === "npm" ? npmTarball(p.version, cache) : { path: p.path, registryIntegrity: null };
  if (!existsSync(from.path)) throw new Error(`there is no file ${from.path}`);
  const bytes = readFileSync(from.path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const integrity = integrityOf(bytes);
  const root = join(cache, "packages");
  const dir = join(root, `${PACKAGE_NAME}-${sha256.slice(0, 16)}`);
  const found = (where) => {
    const record = JSON.parse(readFileSync(join(where, "record.json"), "utf8"));
    if (record.sha256 !== sha256) throw new Error(`${where} holds a package with sha256 ${record.sha256}, not ${sha256}; move it to the Trash`);
    const pkg = join(where, "package");
    return { dir: pkg, cli: join(pkg, "dist", "bin.js"), lib: join(pkg, "dist", "lib.js"), record: { spec: p.kind === "npm" ? spec : `file:${basename(from.path)}`, ...record, registryIntegrity: from.registryIntegrity } };
  };
  if (existsSync(join(dir, "record.json"))) return found(dir);
  mkdirSync(root, { recursive: true });
  const temp = mkdtempSync(join(root, ".unpack-"));
  let manifest;
  try {
    const r = spawnSync("tar", ["-xzf", from.path, "-C", temp], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`tar could not unpack ${basename(from.path)}: ${said(r)}`);
    try {
      manifest = JSON.parse(readFileSync(join(temp, "package", "package.json"), "utf8"));
    } catch {
      throw new Error(`${basename(from.path)} holds no package/package.json`);
    }
    if (manifest.name !== PACKAGE_NAME) throw new Error(`${basename(from.path)} is the package ${manifest.name}, not ${PACKAGE_NAME}`);
    if (p.kind === "npm" && manifest.version !== p.version) throw new Error(`${basename(from.path)} holds version ${manifest.version}, not ${p.version}`);
    for (const f of ["dist/bin.js", "dist/lib.js"]) if (!existsSync(join(temp, "package", f))) throw new Error(`${basename(from.path)} holds no ${f}`);
    const record = { name: manifest.name, version: manifest.version, sha256, integrity, bytes: statSync(from.path).size };
    writeFileSync(join(temp, "record.json"), `${JSON.stringify(record, null, 2)}\n`);
    try {
      renameSync(temp, dir);
    } catch (error) {
      // Another run put the same package in place first.
      if (!existsSync(join(dir, "record.json"))) throw error;
    }
    return found(dir);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
