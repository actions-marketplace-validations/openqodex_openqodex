// Runs scripts/pin-bump.mjs as its own process against the upstream named
// in argv[2] (a JSON object of origins), so a test can point it at a local
// server standing in for GitHub. The script itself never reads its upstream
// from the environment: only an import can change it.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { run } = await import(join(here, "..", "..", "..", "scripts", "pin-bump.mjs"));
const options = JSON.parse(process.argv[2]);
process.exitCode = await run(process.argv.slice(3), options);
