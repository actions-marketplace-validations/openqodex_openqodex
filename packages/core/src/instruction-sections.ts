// Generated from the same current and previous templates that init ships.
import { posix } from "node:path";
import shipped from "./shipped-instruction-sections.json";

// User rules contain launcherRunner(launcherPath(home)): a bare absolute
// path, or its exact POSIX single-quoted form, ending in /bin/openqodex.
// The home is configurable. A command or added prose is never a launcher.
function isLauncherRunner(runner: string): boolean {
  if (/[\0\r\n]/.test(runner)) return false;
  const quoted = runner.startsWith("'") && runner.endsWith("'");
  const path = quoted ? runner.slice(1, -1).replaceAll("'\\''", "'") : runner;
  if (!path.startsWith("/") || !path.endsWith("/bin/openqodex") || posix.normalize(path) !== path) return false;
  const rendered = /^[A-Za-z0-9_./@+-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`;
  return runner === rendered;
}

function matchesTemplate(raw: string, template: string): boolean {
  const version = /openqodex@(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)/.exec(raw)?.[1];
  if (template.includes("{{VERSION}}") && version === undefined) return false;
  const filled = version ? template.replaceAll("{{VERSION}}", version) : template;
  const at = filled.indexOf("{{LAUNCHER}}");
  if (at === -1) return raw === filled;
  const before = filled.slice(0, at);
  const after = filled.slice(at + "{{LAUNCHER}}".length);
  if (!raw.startsWith(before) || !raw.endsWith(after)) return false;
  const launcher = raw.slice(at, raw.length - after.length);
  return isLauncherRunner(launcher) && filled.replaceAll("{{LAUNCHER}}", launcher) === raw;
}

export function isShippedInstructionFile(raw: string): boolean {
  return shipped.rules.some((template) => matchesTemplate(raw, template));
}

export function stripInstructionSections(raw: string): string {
  return raw.replace(/<!-- openqodex:start -->[\s\S]*?<!-- openqodex:end -->/g, (span) => {
    return shipped.sections.some((template) => matchesTemplate(span, template)) ? "" : span;
  });
}
