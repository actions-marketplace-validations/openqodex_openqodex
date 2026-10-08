// scripts/pin-bump.mjs moves a scanner pin in toolchain.json, the table the
// installer trusts: what it writes is the product's supply chain. A local
// server stands in for GitHub's API, its release pages and its asset host;
// the script runs as its own process, as the monthly workflow runs it.
//
// Failure list, written before the code:
//   1. An asset whose bytes differ from the sha256 GitHub publishes for it (a
//      tampered artifact) is pinned, or the run exits other than 2.
//   2. An asset whose bytes differ from the project's own checksum file is
//      pinned.
//   3. A download that redirects to a host other than GitHub's asset host is
//      followed.
//   4. An API answer that redirects, as GitHub does for a renamed or
//      transferred project, is followed.
//   5. An asset whose URL is outside the pinned owner and repository is
//      pinned.
//   6. A release under seven days old, or not newer than the pin, is taken.
//   7. A run that stops leaves toolchain.json changed or a changeset behind.
//   8. A good release is not pinned at the sha256 of its downloaded bytes, or
//      a file other than toolchain.json and one changeset changes.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const runner = join(here, "pin-bump-runner.mjs");
const PLATFORMS = { "darwin-arm64": "darwin_arm64", "darwin-x64": "darwin_amd64", "linux-x64": "linux_amd64", "linux-arm64": "linux_arm64" } as const;
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const DAY = 24 * 60 * 60 * 1000;

type Release = {
  tag: string;
  ageDays: number;
  // Bytes served per asset name; `digest` overrides the digest the API gives.
  bytes: (name: string) => Buffer;
  digest?: (name: string) => string;
  checksums?: (names: string[]) => string;
  assetUrlRepo?: string;
  redirectTo?: string;
  apiRedirect?: boolean;
};

let release: Release;
let origin = "";
let other = "";
const servers: Server[] = [];

function assetNames(version: string): string[] {
  return Object.values(PLATFORMS).map((p) => `demo_${version}_${p}.tar.gz`);
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", origin);
  const version = release.tag.slice(1);
  if (url.pathname === "/repos/acme/demo/releases") {
    if (release.apiRedirect) {
      res.writeHead(301, { location: `${origin}/repositories/1/releases?per_page=100` }).end();
      return;
    }
    const names = assetNames(version);
    const assets = names.map((name) => ({
      name,
      digest: `sha256:${release.digest ? release.digest(name) : sha(release.bytes(name))}`,
      browser_download_url: `${origin}/${release.assetUrlRepo ?? "acme/demo"}/releases/download/${release.tag}/${name}`,
    }));
    if (release.checksums) {
      const file = `demo_${version}_checksums.txt`;
      assets.push({ name: file, digest: `sha256:${sha(release.checksums(names))}`, browser_download_url: `${origin}/acme/demo/releases/download/${release.tag}/${file}` });
    }
    const published = new Date(Date.now() - release.ageDays * DAY).toISOString();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([{ tag_name: release.tag, draft: false, prerelease: false, published_at: published, html_url: `${origin}/acme/demo/releases/tag/${release.tag}`, assets }]));
    return;
  }
  const download = /^\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/([^/]+)$/.exec(url.pathname);
  if (download) {
    res.writeHead(302, { location: `${release.redirectTo ?? origin}/blob/${download[1]}` }).end();
    return;
  }
  const blob = /^\/blob\/([^/]+)$/.exec(url.pathname);
  if (blob) {
    const name = blob[1]!;
    const names = assetNames(version);
    res.writeHead(200).end(name.endsWith("_checksums.txt") && release.checksums ? release.checksums(names) : release.bytes(name));
    return;
  }
  res.writeHead(404).end();
}

async function listen(): Promise<string> {
  const server = createServer(handle);
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  origin = await listen();
  other = await listen();
});
afterAll(() => {
  for (const s of servers) s.close();
});

// A repo root holding only the pinned table, with demo 1.0.0 in it.
function repoRoot(): { root: string; table: string; before: string } {
  const root = mkdtempSync(join(tmpdir(), "oq-pin-bump-"));
  mkdirSync(join(root, "packages", "scanners"), { recursive: true });
  mkdirSync(join(root, ".changeset"));
  const assets = Object.fromEntries(
    Object.entries(PLATFORMS).map(([platform, p]) => [
      platform,
      { name: `demo_1.0.0_${p}.tar.gz`, url: `https://example.invalid/demo_1.0.0_${p}.tar.gz`, sha256: "0".repeat(64), archive: "tar.gz", binaryPath: "demo" },
    ]),
  );
  const text = `${JSON.stringify({ schema: 1, tools: { demo: { version: "1.0.0", method: "github-release", repo: "acme/demo", tag: "v1.0.0", binary: "demo", assets } } }, null, 2)}\n`;
  const table = join(root, "packages", "scanners", "toolchain.json");
  writeFileSync(table, text);
  return { root, table, before: text };
}

function files(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name), `${rel}${e.name}/`);
      else out.push(`${rel}${e.name}`);
    }
  };
  walk(root, "");
  return out.sort();
}

async function bump(root: string): Promise<{ code: number | null; stderr: string }> {
  const options = { root, api: origin, web: origin, assetOrigins: [origin] };
  const child = spawn(process.execPath, [runner, JSON.stringify(options), "--apply", "demo"], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
  const code = await new Promise<number | null>((done) => child.on("close", done));
  return { code, stderr };
}

const good = (): Release => ({
  tag: "v2.0.0",
  ageDays: 30,
  bytes: (name) => Buffer.from(`the real ${name}`),
  checksums: (names) => names.map((n) => `${sha(Buffer.from(`the real ${n}`))}  ${n}`).join("\n") + "\n",
});

describe("pin-bump stops on an artifact or a source it cannot trust, and changes nothing", () => {
  const cases: [string, () => Release, RegExp][] = [
    ["a tampered artifact: its bytes differ from the sha256 GitHub publishes (1)", () => ({ ...good(), checksums: undefined, bytes: (n) => Buffer.from(`tampered ${n}`), digest: (n) => sha(Buffer.from(`the real ${n}`)) }), /sha256/],
    ["bytes that differ from the project's own checksum file (2)", () => ({ ...good(), checksums: (names) => names.map((n) => `${"a".repeat(64)}  ${n}`).join("\n") + "\n" }), /checksum file/],
    ["a download that redirects to another host (3)", () => ({ ...good(), redirectTo: other }), /redirect/],
    ["an API answer that redirects, as for a renamed or transferred project (4)", () => ({ ...good(), apiRedirect: true }), /redirect/],
    ["an asset outside the pinned owner and repository (5)", () => ({ ...good(), assetUrlRepo: "mallory/demo" }), /outside/],
  ];
  for (const [name, make, reason] of cases) {
    it(name, async () => {
      release = make();
      const { root, table, before } = repoRoot();
      const r = await bump(root);
      expect(r.code, r.stderr).toBe(2);
      expect(r.stderr).toMatch(reason);
      expect(readFileSync(table, "utf8")).toBe(before);
      expect(files(root)).toEqual(["packages/scanners/toolchain.json"]);
    });
  }
});

describe("pin-bump takes only a release that is due (6)", () => {
  it("leaves the pin for a release under seven days old or not newer", async () => {
    for (const r of [{ ...good(), ageDays: 3 }, { ...good(), tag: "v1.0.0" }]) {
      release = r;
      const { root, table, before } = repoRoot();
      const out = await bump(root);
      expect(out.code, out.stderr).toBe(0);
      expect(readFileSync(table, "utf8")).toBe(before);
      expect(files(root)).toEqual(["packages/scanners/toolchain.json"]);
    }
  });
});

describe("pin-bump pins a good release (8)", () => {
  it("pins the sha256 of the downloaded bytes and writes only the table and one changeset", async () => {
    release = good();
    const { root, table } = repoRoot();
    const r = await bump(root);
    expect(r.code, r.stderr).toBe(0);
    const demo = JSON.parse(readFileSync(table, "utf8")).tools.demo;
    expect(demo).toMatchObject({ version: "2.0.0", tag: "v2.0.0", repo: "acme/demo" });
    expect(demo.assets["linux-x64"]).toEqual({
      name: "demo_2.0.0_linux_amd64.tar.gz",
      url: `${origin}/acme/demo/releases/download/v2.0.0/demo_2.0.0_linux_amd64.tar.gz`,
      sha256: sha(Buffer.from("the real demo_2.0.0_linux_amd64.tar.gz")),
      archive: "tar.gz",
      binaryPath: "demo",
    });
    expect(files(root)).toEqual([".changeset/pin-demo-2-0-0.md", "packages/scanners/toolchain.json"]);
  });
});
