// Copies the assets that ship beside the CLI bundle into packages/cli.
// Only files git tracks are copied, so a private note or a build leftover
// sitting in a source folder never reaches the package. Each destination is
// cleared first, so nothing from an earlier build survives.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, "packages", "cli");

function tracked(from) {
  return execFileSync("git", ["ls-files", "-z", "--", from], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

// `from` is a file or a folder, relative to the repo root. `keep` filters the
// files of a folder.
function copy(from, to, keep = () => true) {
  const target = join(cli, to);
  rmSync(target, { recursive: true, force: true });
  for (const file of tracked(from).filter(keep)) {
    if (!existsSync(join(root, file))) continue;
    const rest = relative(from, file);
    const destination = rest === "" ? target : join(target, rest);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(root, file), destination);
  }
}

copy("packages/core/lenses", "lenses", (file) => file.endsWith(".md"));
copy("docs", "docs");
copy("skills/openqodex", "skills/openqodex");
copy("packages/scanners/toolchain.json", "toolchain.json");
copy("examples/demo-repo", "demo");
copy("README.md", "README.md");
copy("LICENSE", "LICENSE");
copy("NOTICE", "NOTICE");
