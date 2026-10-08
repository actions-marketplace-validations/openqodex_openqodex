// The files OpenQodex wrote in user scope that this version would write
// differently: exactly what the next `openqodex init` refreshes. Counted by
// init's own planner on a copy of the record, so a file the developer edited
// (which init keeps) is never counted, and neither is anything outside user
// scope: the team section and project-scope files are pinned on purpose.
// Nothing is written. An update never writes these files; it only says how
// many there are and that `init` refreshes them.
import { dirname, join, sep } from "node:path";
import { launcherFormatStale, launcherPath, launcherRunner } from "../launcher.js";
import { AGENTS } from "./detect.js";
import { readText } from "./files.js";
import { Guard } from "./guarded-fs.js";
import { claudeHome, codexHome } from "./homes.js";
import { ownedFile, planInstall, type Ctx } from "./plan.js";
import { loadRecord, type InstallRecord } from "./record.js";
import { targetsFor, type Target } from "./targets.js";

const CURSOR_RULE = join(".cursor", "rules", "openqodex.mdc");

function recorded(record: InstallRecord, t: Target): boolean {
  switch (t.kind) {
    case "file":
      return record.files.some((f) => f.path === t.path);
    case "md-section":
      return record.sections.some((s) => s.path === t.path);
    case "hook-json":
      return record.hooks.some((h) => h.path === t.path);
    case "allow-rules":
      return record.allowRules.some((r) => r.path === t.path);
  }
}

// The paths, in the order init plans them. Empty when there is no install
// record, or it cannot be read.
export function staleOwnedFiles(home: string, oqHome: string): string[] {
  let record: InstallRecord;
  try {
    record = loadRecord(oqHome);
  } catch {
    return [];
  }
  const runner = launcherRunner(launcherPath(oqHome));
  // A user-scope Cursor rule lives in a repository: the record names it.
  const cursorRepos = record.files.filter((f) => f.usesLauncher && f.path.endsWith(`${sep}${CURSOR_RULE}`)).map((f) => dirname(dirname(dirname(f.path))));
  const targets: Target[] = [];
  for (const agent of AGENTS) targets.push(...targetsFor({ agent, scope: "user", home, repoRoot: null, version: __OPENQODEX_VERSION__, runner }).targets);
  for (const repoRoot of cursorRepos) {
    const rule = targetsFor({ agent: "cursor", scope: "user", home, repoRoot, version: __OPENQODEX_VERSION__, runner }).targets.filter((t) => t.kind === "file" && t.path.endsWith(CURSOR_RULE));
    targets.push(...rule);
  }
  const guard = new Guard({ repoRoot: null, gitFolders: [], roots: [home, claudeHome(home), codexHome(home), oqHome, ...cursorRepos] });
  const ctx: Ctx = { record: structuredClone(record), scope: "user", repoRoot: null, guard };
  const stale: string[] = [];
  const seen = new Set<string>();
  for (const t of targets) {
    const key = `${t.kind} ${t.path}`;
    if (seen.has(key) || !recorded(record, t)) continue;
    seen.add(key);
    try {
      const action = planInstall(t, ctx);
      if ((action.verb === "update" || action.verb === "replace") && !stale.includes(t.path)) stale.push(t.path);
    } catch {
      // a file that cannot be read or a path init refuses: init says why
    }
  }
  const launcher = launcherPath(oqHome);
  try {
    if (ownedFile(record, launcher, readText(launcher)) && launcherFormatStale(oqHome)) stale.push(launcher);
  } catch {
    // unreadable: init says why
  }
  return stale;
}

// The line after an update and in `doctor`; null when nothing is stale.
export function staleLine(home: string, oqHome: string): string | null {
  const n = staleOwnedFiles(home, oqHome).length;
  if (n === 0) return null;
  const runner = launcherRunner(launcherPath(oqHome));
  return `${n} ${n === 1 ? "file OpenQodex wrote is" : "files OpenQodex wrote are"} from an older version; run ${runner} init to refresh them`;
}
