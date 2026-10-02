// `openqodex trust [--yes] [--list] [--revoke <name>]`: approve the custom
// scanners named in .openqodex.yaml. Each untrusted or changed entry is
// resolved (downloaded to quarantine, never run), printed exactly, and
// approved only on a yes. Nothing is approved silently.
import { confirm, isCancel } from "@clack/prompts";
import { OpenQodexError } from "@openqodex/core";
import type { CustomScanner } from "@openqodex/core";
import { approve, resolveCustomArtifact, revoke, trustState } from "@openqodex/scanners";
import type { ResolvedArtifact } from "@openqodex/scanners";
import { EXIT_OK, EXIT_TOOL_FAILED } from "../exit-codes.js";
import { parseFlags } from "../flags.js";
import { loadRepo } from "../pipeline.js";

const STATE_WORDS = { trusted: "trusted", untrusted: "not approved", changed: "changed since approval" } as const;

function describe(entry: CustomScanner, artifact: ResolvedArtifact): string {
  const checksum =
    artifact.checksumSource === "upstream"
      ? "checked against the checksum file the project publishes"
      : artifact.checksumSource === "first-download"
        ? "the hash of this first download; the project publishes no checksum file to check it against"
        : "none (not a downloaded file)";
  const lines = [
    `Custom scanner ${entry.name}`,
    `  source    ${entry.source}`,
    `  version   ${artifact.version}`,
    `  install   ${entry.install.kind}`,
    `  asset     ${artifact.assetName ?? "none"}`,
    `  url       ${artifact.url ?? "none"}`,
    `  sha256    ${artifact.sha256 ?? "none"}`,
    `  checksum  ${checksum}`,
    `  binary    ${artifact.binary}`,
    `  run       ${entry.run}`,
    `  paths     ${entry.paths === null ? "every changed file" : entry.paths.join(", ")}`,
    `  target    ${entry.target}`,
  ];
  return `${lines.join("\n")}\n`;
}

export async function run(args: string[]): Promise<number> {
  const { global, bools, values } = parseFlags(args, { bools: ["--yes", "--list"], values: ["--revoke"] });
  const { repoRoot, config } = await loadRepo(global);

  const name = values.get("--revoke");
  if (name !== undefined) {
    revoke(repoRoot, name);
    process.stderr.write(`Revoked ${name}.\n`);
    return EXIT_OK;
  }

  const rows = trustState(repoRoot, config);
  if (bools.has("--list")) {
    if (rows.length === 0) process.stdout.write("No custom scanners in .openqodex.yaml.\n");
    for (const r of rows) process.stdout.write(`${r.entry.name}  ${r.entry.source}  ${STATE_WORDS[r.state]}\n`);
    return EXIT_OK;
  }

  const pending = rows.filter((r) => r.state !== "trusted");
  if (pending.length === 0) {
    process.stderr.write(rows.length === 0 ? "No custom scanners in .openqodex.yaml.\n" : "Every custom scanner is approved.\n");
    return EXIT_OK;
  }
  const yes = bools.has("--yes");
  if (!yes && !process.stdin.isTTY) {
    process.stderr.write(
      `${pending.length} custom scanner${pending.length === 1 ? " needs" : "s need"} approval. ` +
        "Run openqodex trust in a terminal to see each one and answer, or openqodex trust --yes to approve them all.\n",
    );
    return EXIT_TOOL_FAILED;
  }

  for (const row of pending) {
    const artifact = await resolveCustomArtifact(row.entry);
    process.stdout.write(describe(row.entry, artifact));
    let ok = yes;
    if (!yes) {
      const answer = await confirm({ message: `Approve ${row.entry.name} to run on this repository?`, initialValue: false });
      if (isCancel(answer)) throw new OpenQodexError("cancelled; nothing more was approved");
      ok = answer;
    }
    if (ok) {
      await approve(repoRoot, row.entry, artifact);
      process.stderr.write(`Approved ${row.entry.name}.\n`);
    } else {
      process.stderr.write(`Not approved: ${row.entry.name}. It will be skipped until you approve it.\n`);
    }
  }
  return EXIT_OK;
}
