// Codex as the reviewer: not enabled. With codex-cli 0.160.0 its read-only
// permission profile kept reads inside the snapshot, but two properties the
// review needs failed with the real binary (docs/internal-reviewer-drivers.md):
// the developer's own ~/.codex/AGENTS.md reaches the model with no switch to
// leave it out, and commands the shell runs inside the code tool do not all
// appear in the --json event stream, so the trace cannot check every read.
// `--reviewer codex` names it and gets this reason; `auto` passes it by.
import type { Detected, ReviewerDriver, ReviewerSession } from "./driver.js";

export const CODEX_NOT_ENABLED =
  "not enabled: Codex loads your global ~/.codex/AGENTS.md into every run with no switch to leave it out, and its event stream does not show every command, so openqodex cannot check what the reviewer read";

async function detect(): Promise<Detected> {
  return { ok: false, missing: CODEX_NOT_ENABLED, fix: "use Claude Code as the reviewer (--reviewer claude)" };
}

function start(): ReviewerSession {
  throw new Error(CODEX_NOT_ENABLED);
}

export const codexDriver: ReviewerDriver = { name: "codex", detect, start };
