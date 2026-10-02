import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const bin = join(root, "packages", "cli", "dist", "bin.js");
const { version } = JSON.parse(
  readFileSync(join(root, "packages", "cli", "package.json"), "utf8"),
) as { version: string };

function cli(...args: string[]) {
  return spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" });
}

describe("openqodex binary", () => {
  beforeAll(() => {
    if (!existsSync(bin)) throw new Error(`${bin} is missing. Run pnpm build first.`);
  });

  it("prints its version and exits 0", () => {
    const result = cli("--version");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(version);
  });

  it("exits 2 on an unknown command", () => {
    const result = cli("nonsense");
    expect(result.status).toBe(2);
  });
});
