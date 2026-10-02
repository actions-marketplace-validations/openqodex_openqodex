// The custom scanner trust flow end to end, with a real scanner from its real
// GitHub release (actionlint 1.7.12, about 2 MB, with an upstream checksums
// file) and the OpenQodex home folder in a temp directory. Needs the network.
//
// Ways it could fail, written before the code:
// 1. An entry nobody approved runs, or something is downloaded or installed
//    for it during a scan.
// 2. Resolving installs or executes the download instead of leaving it in
//    quarantine, or skips the upstream checksum when the release has one.
// 3. A quarantined file swapped or altered between resolve and approve is installed.
// 4. Approve does not install under tools/custom/<name>/<version>/, leaves the
//    quarantine behind, or records no approval.
// 5. The approved adapter does not run the installed binary, does not pass the
//    matching changed files, treats the tool's exit 1 on findings as a
//    failure, or returns findings under another source.
// 6. Editing the entry's run line keeps it running without a new approval.
// 7. Revoking keeps it running.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "@openqodex/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approve, customAdapters, resolveCustomArtifact, revoke, trustState } from "../src/custom/index.js";

const yaml = (run: string) => `
scanners:
  custom:
    - source: https://github.com/rhysd/actionlint
      version: "1.7.12"
      run: ${JSON.stringify(run)}
      format: json-map
      map: { items: ".", file: filepath, line: line, rule: kind, message: message }
      paths: [".github/workflows/*.yml"]
`;
const RUN = "actionlint -no-color -format '{{json .}}' {target}";

let home: string;
let repo: string;
const savedHome = process.env.OPENQODEX_HOME;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "oq-home-"));
  repo = mkdtempSync(join(tmpdir(), "oq-repo-"));
  process.env.OPENQODEX_HOME = home;
  mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(repo, ".github", "workflows", "ci.yml"),
    ["on: push", "jobs:", "  test:", "    runs-on: ubuntu-latest", "    steps:", "      - run: echo ${{ github.no_such_field }}", ""].join("\n"),
  );
});

afterAll(() => {
  if (savedHome === undefined) delete process.env.OPENQODEX_HOME;
  else process.env.OPENQODEX_HOME = savedHome;
});

describe("custom scanner trust flow", () => {
  it("skips, quarantines, installs on approval, runs, and stops after an edit or a revoke", { timeout: 180_000 }, async () => {
    const config = parseConfig(yaml(RUN)).config;
    const changed = [".github/workflows/ci.yml"];

    // 1: not approved, skipped, nothing fetched.
    const [before] = customAdapters(repo, config);
    expect(before?.skipped).toMatchObject({ scanner: "custom:actionlint", status: "untrusted", reason: "not approved yet: run `openqodex trust`" });
    expect(existsSync(join(home, "quarantine"))).toBe(false);
    expect(existsSync(join(home, "tools"))).toBe(false);

    // 2: resolve downloads to quarantine only, checked against upstream checksums.
    const artifact = await resolveCustomArtifact(config.custom[0]!);
    expect(artifact).toMatchObject({ version: "1.7.12", checksumSource: "upstream", binary: "actionlint" });
    expect(artifact.assetName).toMatch(/^actionlint_1\.7\.12_(darwin|linux)_(arm64|amd64)\.tar\.gz$/);
    expect(artifact.quarantinePath!.startsWith(join(home, "quarantine"))).toBe(true);
    expect(statSync(artifact.quarantinePath!).mode & 0o111).toBe(0);
    expect(existsSync(join(home, "tools"))).toBe(false);
    expect(trustState(repo, config)[0]?.state).toBe("untrusted");

    // 3: an altered quarantine file is refused and nothing is installed or trusted.
    const aside = join(home, "original.tar.gz");
    copyFileSync(artifact.quarantinePath!, aside);
    appendFileSync(artifact.quarantinePath!, "x");
    await expect(approve(repo, config.custom[0]!, artifact)).rejects.toThrow(/changed after it was checked/);
    expect(existsSync(join(home, "tools", "custom", "actionlint", "1.7.12"))).toBe(false);
    expect(trustState(repo, config)[0]?.state).toBe("untrusted");
    copyFileSync(aside, artifact.quarantinePath!);

    // 4: approve installs and records.
    await approve(repo, config.custom[0]!, artifact);
    const row = trustState(repo, config)[0]!;
    expect(row.state).toBe("trusted");
    expect(row.record?.artifact.binary).toBe(join(home, "tools", "custom", "actionlint", "1.7.12", "actionlint"));
    expect(existsSync(artifact.quarantinePath!)).toBe(false);
    expect(JSON.parse(readFileSync(join(home, "trust.json"), "utf8")).records).toHaveLength(1);

    // 5: the approved adapter runs on the changed workflow file.
    const [adapter] = customAdapters(repo, config);
    expect(adapter?.skipped).toBeNull();
    expect(adapter?.wants(["README.md"])).toBe(false);
    expect(adapter?.wants(changed)).toBe(true);
    const result = await adapter!.run({ repoDir: repo, changedPaths: [...changed, "README.md"] });
    expect(result.error).toBeNull();
    expect(result.version).toBe("1.7.12");
    expect(result.findings).toContainEqual(
      expect.objectContaining({ source: "custom:actionlint", filePath: ".github/workflows/ci.yml", lineStart: 6, ruleId: "expression" }),
    );

    // 6: an edited run line is skipped until approved again.
    const edited = parseConfig(yaml(`${RUN} -verbose`)).config;
    expect(trustState(repo, edited)[0]?.state).toBe("changed");
    expect(customAdapters(repo, edited)[0]?.skipped).toMatchObject({
      status: "untrusted",
      reason: "changed since it was approved: run `openqodex trust`",
    });

    // 7: revoke.
    revoke(repo, "actionlint");
    expect(customAdapters(repo, config)[0]?.skipped?.reason).toBe("not approved yet: run `openqodex trust`");
  });
});
