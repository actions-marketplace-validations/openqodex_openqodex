// Generated from the same current and previous templates that init ships.
import shipped from "./shipped-instruction-sections.json";

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
  return launcher.length > 0 && !/[\0\r\n]/.test(launcher) && filled.replaceAll("{{LAUNCHER}}", launcher) === raw;
}

export function isShippedInstructionFile(raw: string): boolean {
  return shipped.rules.some((template) => matchesTemplate(raw, template));
}

export function stripInstructionSections(raw: string): string {
  return raw.replace(/<!-- openqodex:start -->[\s\S]*?<!-- openqodex:end -->/g, (span) => {
    return shipped.sections.some((template) => matchesTemplate(span, template)) ? "" : span;
  });
}
