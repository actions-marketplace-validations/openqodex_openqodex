// The detached install process for tests, shaped like the CLI's hidden
// `openqodex __install <tool>` entry: argv is [node, this file, "__install", tool].
import { runInstallWorker } from "../dist/index.js";

process.exitCode = await runInstallWorker(process.argv[3]);
