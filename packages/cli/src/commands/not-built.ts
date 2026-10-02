import { EXIT_TOOL_FAILED } from "../exit-codes.js";

export function notBuilt(name: string): number {
  process.stderr.write(`openqodex ${name}: not built yet\n`);
  return EXIT_TOOL_FAILED;
}
