// Generated from the same current and previous templates that init ships.
import shipped from "./shipped-instruction-sections.json";

export function stripInstructionSections(raw: string): string {
  return raw.replace(/<!-- openqodex:start -->[\s\S]*?<!-- openqodex:end -->/g, (span) => {
    const version = /openqodex@(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)/.exec(span)?.[1];
    return shipped.sections.some((template) => (version ? template.replaceAll("{{VERSION}}", version) : template) === span) ? "" : span;
  });
}
