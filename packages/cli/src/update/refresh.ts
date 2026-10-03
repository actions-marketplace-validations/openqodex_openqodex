// `openqodex __refresh`, hidden: rewrites the user-scope agent files the
// installation record names, from this runtime's own templates, so the files
// always match the version being activated. Only a file, hook or section
// that is recorded and still exactly as written is changed; nothing is
// created, and no file inside a repository is touched (team sections and
// project-scope files stay pinned). The updater runs it inside install.lock,
// so it does not take the lock itself. `--probe` exits 0 and does nothing:
// the updater uses it to learn whether a release has this command.
// Prints {"updated": [...], "kept": [...]} on stdout.
import { homedir } from "node:os";
import { AGENTS } from "../agents/detect.js";
import { readText } from "../agents/files.js";
import { planInstall, type Ctx } from "../agents/plan.js";
import { loadRecord, saveRecord, serialize, type InstallRecord } from "../agents/record.js";
import { targetsFor, type Target } from "../agents/targets.js";
import { launcherPath, openqodexHomeDir, shQuote } from "../launcher.js";

function recorded(record: InstallRecord, t: Target): boolean {
  if (t.kind === "file") return record.files.some((f) => f.path === t.path);
  if (t.kind === "hook-json") return record.hooks.some((h) => h.path === t.path);
  return record.sections.some((s) => s.path === t.path);
}

export async function runRefresh(version: string): Promise<{ updated: string[]; kept: string[] }> {
  const home = openqodexHomeDir();
  const record = loadRecord(home);
  const before = serialize(record);
  const ctx: Ctx = { record, scope: "user", repoRoot: null };
  const runner = shQuote(launcherPath(home));
  const updated: string[] = [];
  const kept: string[] = [];
  try {
    for (const agent of AGENTS) {
      const { targets } = targetsFor({ agent, scope: "user", home: homedir(), repoRoot: null, version, runner });
      for (const t of targets) {
        if (t.inRepo || !recorded(record, t)) continue;
        const action = planInstall(t, ctx);
        // update and replace are the verbs for a recorded thing still as
        // written; create, merge and append would add one that is not there.
        if ((action.verb === "update" || action.verb === "replace") && action.apply) {
          if (action.guard && readText(action.guard.path) !== action.guard.before) {
            kept.push(t.path);
            continue;
          }
          await action.apply();
          updated.push(t.path);
        } else if (action.verb === "keep" || action.verb === "refuse") {
          kept.push(t.path);
        }
      }
    }
  } finally {
    saveRecord(home, record, before);
  }
  return { updated, kept };
}
