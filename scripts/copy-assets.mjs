// Copies the assets that ship beside the CLI bundle into packages/cli.
// A missing source is skipped: other parts of the repo add them over time.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, "packages", "cli");

function copy(from, to) {
  const source = join(root, from);
  if (!existsSync(source)) return;
  const target = join(cli, to);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
}

const lensDir = join(root, "packages", "core", "lenses");
if (existsSync(lensDir)) {
  const target = join(cli, "lenses");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(lensDir)) {
    if (name.endsWith(".md")) cpSync(join(lensDir, name), join(target, name));
  }
}

copy("docs", "docs");
copy("skills/openqodex", "skills/openqodex");
copy("packages/scanners/toolchain.json", "toolchain.json");
copy("examples/demo-repo", "demo");
copy("README.md", "README.md");
copy("LICENSE", "LICENSE");
copy("NOTICE", "NOTICE");
