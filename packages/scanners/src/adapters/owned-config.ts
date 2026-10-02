// A config file OpenQodex writes for a scanner, so the scanner never loads
// one from the repo. Some tools let a repo config run code (rubocop's
// `require`, oxlint's JavaScript plugins) or write files (brakeman's output
// files); a builtin scanner never gets that from the code under review.
// The file lives in a temp folder outside the repo and is removed after use.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function withOwnedConfig<T>(
  fileName: string,
  content: string,
  use: (configPath: string, dir: string) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openqodex-config-"));
  try {
    const configPath = path.join(dir, fileName);
    await fs.writeFile(configPath, content);
    return await use(configPath, dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
