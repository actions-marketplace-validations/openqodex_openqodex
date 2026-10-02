import type { ScannerSeverity, Severity } from "./types.js";

// Lowest first. The one scale the developer sees.
export const SEVERITIES: readonly Severity[] = ["info", "nitpick", "minor", "major", "critical"];

export function severityRank(s: Severity): number {
  return SEVERITIES.indexOf(s);
}

export function atOrAbove(s: Severity, threshold: Severity): boolean {
  return severityRank(s) >= severityRank(threshold);
}

const SCANNER_TO_REVIEW: Record<ScannerSeverity, Severity> = {
  critical: "critical",
  high: "major",
  medium: "minor",
  low: "nitpick",
  info: "info",
};

export function mapScannerSeverity(s: ScannerSeverity): Severity {
  return SCANNER_TO_REVIEW[s];
}
