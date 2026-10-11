#!/usr/bin/env node
// The image's readiness check, run while the image builds and again by
// check-build.sh in the finished image, where it finds every scanner
// installed and only checks them. It installs
// every built-in scanner of the openqodex version in package.json, cargo-deny
// included, into /opt/openqodex/tools with the package's own
// preinstallScanners, and proves each one with its check case. It exits 1 and
// names each scanner that is not ready, so an image that would silently lack
// a scanner never builds.
//
// Readiness covers the scanners only. The dependency caches a case needs (the
// crates of its Cargo.lock for cargo-deny, the modules of its go.mod for
// golangci) are not part of it and are not in the image: they are fetched per
// case and recorded with that case.
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { preinstallScanners, toolchainHash } from "openqodex";

const INSTALL_ROOT = "/opt/openqodex/tools";
const READINESS = "/opt/openqodex/readiness.json";

const version = createRequire(import.meta.url)("openqodex/package.json").version;
const hash = toolchainHash();
console.log(`openqodex ${version}, toolchain ${hash}, node ${process.version}, ${process.platform}-${process.arch}`);

const started = Date.now();
const result = await preinstallScanners({ installRoot: INSTALL_ROOT, require: "all", onProgress: (line) => console.log(line) });
const seconds = Math.round((Date.now() - started) / 1000);

for (const tool of result.tools) {
  if (tool.ok) console.log(`ready: ${tool.scanner} ${tool.version}: ${tool.detail}`);
  else console.error(`not ready: ${tool.scanner}: ${tool.detail}`);
}
const ready = result.tools.filter((tool) => tool.ok).length;
console.log(`${ready} of ${result.tools.length} built-in scanners ready in ${seconds} s (openqodex ${version})`);

if (result.ok) {
  const perCaseCaches = "not in the image: the Cargo crates and Go modules a case needs are fetched per case and recorded with it";
  writeFileSync(READINESS, `${JSON.stringify({ openqodex: version, toolchainHash: hash, installRoot: INSTALL_ROOT, seconds, tools: result.tools, perCaseCaches }, null, 2)}\n`);
} else {
  process.exitCode = 1;
}
