// Ways picking a release asset could fail, written before the code (asset
// lists are real, saved from GitHub under fixtures/release-assets):
// 1. A checksum, signature, SBOM or package-manager file (.sha256,
//    .sigstore.json, .deb, .rpm) is picked instead of the program.
// 2. A naming style is missed: macOS-ARM64 / macOS-64bit (trivy),
//    darwin_amd64 (goreleaser), darwin_X86_64 (checkov), aarch64-apple-darwin
//    (rust), darwin.aarch64 (shellcheck), a bare binary (hadolint).
// 3. A near miss is taken: Linux-ARM (32-bit) or Linux-32bit for a 64-bit
//    machine, an x64 build for an arm64 Mac.
// 4. Several matches (tar.gz beside tar.xz, gnu beside musl) are resolved by
//    guessing instead of refusing with the candidates and the line to add.
// 5. Zero matches does not say so with the candidates and the line to add.
// 6. An `asset` pattern with {version}, {os}, {arch} does not pick exactly one,
//    or a pattern matching zero or several is accepted.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pickAsset } from "../src/custom/release.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "release-assets");
const load = (repo: string): { tag: string; assets: string[] } => JSON.parse(readFileSync(join(dir, `${repo}.json`), "utf8"));
const versionOf = (tag: string) => tag.replace(/^v/, "");

function pickAll(repo: string, pattern: string | null = null): Record<string, string> {
  const { tag, assets } = load(repo);
  const out: Record<string, string> = {};
  for (const platform of ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] as const) {
    try {
      out[platform] = pickAsset(assets, platform, { pattern, version: versionOf(tag) });
    } catch (error) {
      out[platform] = `error: ${(error as Error).message}`;
    }
  }
  return out;
}

describe("pickAsset", () => {
  it("picks trivy's archive past checksums, sigstore files, deb, rpm and the 32-bit ARM build (1, 2, 3)", () => {
    expect(pickAll("trivy")).toEqual({
      "darwin-arm64": "trivy_0.75.0_macOS-ARM64.tar.gz",
      "darwin-x64": "trivy_0.75.0_macOS-64bit.tar.gz",
      "linux-x64": "trivy_0.75.0_Linux-64bit.tar.gz",
      "linux-arm64": "trivy_0.75.0_Linux-ARM64.tar.gz",
    });
  });

  it("reads goreleaser names and skips .pem and .sig (1, 2)", () => {
    expect(pickAll("trufflehog")).toEqual({
      "darwin-arm64": "trufflehog_3.97.9_darwin_arm64.tar.gz",
      "darwin-x64": "trufflehog_3.97.9_darwin_amd64.tar.gz",
      "linux-x64": "trufflehog_3.97.9_linux_amd64.tar.gz",
      "linux-arm64": "trufflehog_3.97.9_linux_arm64.tar.gz",
    });
  });

  it("reads bare binaries and skips checksums.sha256 (1, 2)", () => {
    const picked = pickAll("hadolint");
    expect(picked["darwin-arm64"]).toBe("hadolint-macos-arm64");
    expect(picked["linux-x64"]).toBe("hadolint-linux-x86_64");
  });

  it("refuses an arm64 machine when only x86_64 exists, naming the candidates and the line to add (3, 5)", () => {
    const picked = pickAll("checkov");
    expect(picked["darwin-x64"]).toBe("checkov_darwin_X86_64.zip");
    expect(picked["linux-x64"]).toBe("checkov_linux_X86_64.zip");
    expect(picked["darwin-arm64"]).toMatch(/no release asset matches darwin-arm64/);
    expect(picked["darwin-arm64"]).toContain("checkov_darwin_X86_64.zip");
    expect(picked["darwin-arm64"]).toContain("install: { asset:");
    expect(picked["linux-arm64"]).toMatch(/no release asset matches linux-arm64/);
  });

  it("refuses several matches with the candidates, and a pattern settles it (4, 6)", () => {
    const picked = pickAll("shellcheck");
    expect(picked["darwin-arm64"]).toMatch(/2 release assets match darwin-arm64/);
    expect(picked["darwin-arm64"]).toContain("shellcheck-v0.11.0.darwin.aarch64.tar.gz");
    expect(picked["darwin-arm64"]).toContain("shellcheck-v0.11.0.darwin.aarch64.tar.xz");
    expect(picked["darwin-arm64"]).toContain("install: { asset:");
    expect(pickAll("shellcheck", "shellcheck-v{version}.{os}.{arch}.tar.xz")).toEqual({
      "darwin-arm64": "shellcheck-v0.11.0.darwin.aarch64.tar.xz",
      "darwin-x64": "shellcheck-v0.11.0.darwin.x86_64.tar.xz",
      "linux-x64": "shellcheck-v0.11.0.linux.x86_64.tar.xz",
      "linux-arm64": "shellcheck-v0.11.0.linux.aarch64.tar.xz",
    });
  });

  it("reads rust target triples and refuses gnu beside musl (2, 4)", () => {
    const picked = pickAll("ripgrep");
    expect(picked["darwin-arm64"]).toBe("ripgrep-15.2.0-aarch64-apple-darwin.tar.gz");
    expect(picked["linux-x64"]).toBe("ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz");
    expect(picked["linux-arm64"]).toMatch(/2 release assets match linux-arm64/);
  });

  it("refuses a pattern that matches zero or several assets (6)", () => {
    const { assets } = load("ripgrep");
    expect(() => pickAsset(assets, "linux-arm64", { pattern: "ripgrep-{version}-{arch}-unknown-linux-*.tar.gz", version: "15.2.0" })).toThrow(
      /matches no release asset/,
    );
    const several = load("shellcheck").assets.concat(["shellcheck-v0.11.0.DARWIN.aarch64.tar.xz"]);
    expect(() => pickAsset(several, "darwin-arm64", { pattern: "shellcheck-v{version}.{os}.{arch}.tar.xz", version: "0.11.0" })).toThrow(
      /matches 2 release assets/,
    );
  });
});
