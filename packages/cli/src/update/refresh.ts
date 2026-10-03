// `openqodex __refresh`, hidden: rewrites the user-scope agent files the
// installation record names, from this runtime's own templates, so the files
// always match the version being activated. Only a file, hook or section
// that is recorded and still exactly as written is changed; nothing is
// created, and no file inside a repository is touched (team sections and
// project-scope files stay pinned). The updater runs it inside install.lock,
// so it does not take the lock itself. `--probe` exits 0 and does nothing:
// the updater uses it to learn whether a release has this command.
// Prints {"updated": [...], "kept": [...]} on stdout.
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { AGENTS } from "../agents/detect.js";
import { readText, writeAtomic } from "../agents/files.js";
import { planInstall, type Ctx } from "../agents/plan.js";
import { loadRecord, saveRecord, serialize, type InstallRecord } from "../agents/record.js";
import { targetsFor, type Target } from "../agents/targets.js";
import { launcherPath, launcherRunner, openqodexHomeDir } from "../launcher.js";

function recorded(record: InstallRecord, t: Target): boolean {
  if (t.kind === "file") return record.files.some((f) => f.path === t.path);
  if (t.kind === "hook-json") return record.hooks.some((h) => h.path === t.path);
  // Rules are refreshed only where init recorded some: the new version's set
  // replaces the recorded one, and a developer's own rules stay.
  // A settings file the developer removed is not created again.
  if (t.kind === "allow-rules") return record.allowRules.some((r) => r.path === t.path) && readText(t.path) !== null;
  return record.sections.some((s) => s.path === t.path);
}

// All or nothing: when a write fails, every file this run already wrote is put
// back as it was, unless someone changed it since (their edit wins), and the
// record is left as it was. Then the failure is thrown.
export async function runRefresh(version: string): Promise<{ updated: string[]; kept: string[] }> {
  const home = openqodexHomeDir();
  const record = loadRecord(home);
  const before = serialize(record);
  const ctx: Ctx = { record, scope: "user", repoRoot: null };
  const runner = launcherRunner(launcherPath(home));
  const done: { path: string; was: string | null; wrote: string | null }[] = [];
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
          const was = readText(t.path);
          if (action.guard && was !== action.guard.before) {
            kept.push(t.path);
            continue;
          }
          await action.apply();
          done.push({ path: t.path, was, wrote: readText(t.path) });
        } else if (action.verb === "keep" || action.verb === "refuse") {
          kept.push(t.path);
        }
      }
    }
  } catch (error) {
    for (const d of done.reverse()) {
      if (readText(d.path) !== d.wrote) continue;
      if (d.was === null) rmSync(d.path, { force: true });
      else writeAtomic(d.path, d.was);
    }
    throw error;
  }
  saveRecord(home, record, before);
  return { updated: done.map((d) => d.path), kept };
}
