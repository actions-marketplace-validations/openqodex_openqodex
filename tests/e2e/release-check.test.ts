import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractArchive } from "../../packages/scanners/src/toolchain/fetch.js";
import { fetchAttestations, fetchTarball } from "../../packages/cli/src/update/fetch.js";
import { verifyRelease } from "../../packages/cli/src/update/verify.js";
import { skipNetwork } from "./support.js";
import { verifiedRelease } from "../../scripts/self-update-check-lib.mjs";
import { removeTempDirs, tempDir } from "../temp-dirs.mjs";

afterAll(removeTempDirs);

// How the release check (scripts/check-self-update.mjs) gets a published
// package before it runs it, against the real npm registry: by exact
// version, checked as the updater checks a release, and unpacked only then.
// The verifier is this repository's own fetch, verification and unpacking.
//
// Ways it could fail, written before the code:
//  a. A release whose registry entry names other bytes, such as an older
//     signed release posing as a newer one, is unpacked and so could run.
//  b. A real release of this repository is refused, so the check never runs.

const offline = skipNetwork("release-check");
const verifier = { fetchAttestations, fetchTarball, verifyRelease, extractArchive };

describe.skipIf(offline)("the release check's own check of a release", () => {
  let metadata: { versions: Record<string, unknown> };
  beforeAll(async () => {
    metadata = (await (await fetch("https://registry.npmjs.org/openqodex")).json()) as typeof metadata;
  }, 60_000);

  it("a. refuses 0.8.1 whose registry entry names 0.7.1's tarball, and unpacks nothing", async () => {
    const dir = realpathSync(tempDir("oq-release-check-"));
    const posing = { versions: { ...metadata.versions, "0.8.1": metadata.versions["0.7.1"] } };
    await expect(verifiedRelease("0.8.1", posing, join(dir, "0.8.1"), verifier)).rejects.toThrow(/did not verify, so nothing of it runs/);
    expect(existsSync(join(dir, "0.8.1", "package"))).toBe(false);
  }, 120_000);

  it("b. checks and unpacks the real 0.8.1", async () => {
    const dir = realpathSync(tempDir("oq-release-check-"));
    const bin = await verifiedRelease("0.8.1", metadata, join(dir, "0.8.1"), verifier);
    expect(bin).toBe(join(dir, "0.8.1", "package", "dist", "bin.js"));
    expect(readdirSync(join(dir, "0.8.1", "package"))).toContain("package.json");
  }, 120_000);
});
