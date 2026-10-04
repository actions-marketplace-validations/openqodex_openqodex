// The reviewer keys of the user config, <openqodex home>/config.yaml:
//   reviewer: auto | claude | codex | cursor   which agent reviews (the
//                                              --reviewer flag wins)
//   reviewer_web: on | off                     whether the reviewer gets its
//                                              agent's web tools
// A value openqodex does not know stops the review with the file named,
// rather than reviewing with a setting the developer did not choose.
import { readFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { OpenQodexError } from "@openqodex/core";
import { openqodexHomeDir } from "../launcher.js";
import { userConfigPath } from "../update/state.js";
import { REVIEWER_NAMES } from "./driver.js";

// The one place the default lives. On (owner's decision, 2026-10-04): the
// reviewer can look up a library or an advisory while it reviews. A reviewer
// that reads private code and untrusted text and can open web addresses can
// be talked into sending the code out, so `reviewer_web: off` removes the web
// tools (docs/security.md).
export const DEFAULT_REVIEWER_WEB: "on" | "off" = "on";

export type ReviewerSettings = { reviewer: string; web: boolean };

export function readReviewerSettings(home: string = openqodexHomeDir()): ReviewerSettings {
  const path = userConfigPath(home);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { reviewer: "auto", web: DEFAULT_REVIEWER_WEB === "on" };
    throw new OpenQodexError(`${path} cannot be read: ${(error as Error).message}`);
  }
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) throw new OpenQodexError(`${path} does not parse as YAML; fix it or remove it`);
  const data: unknown = doc.toJS();
  const map = data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const reviewer = map.reviewer ?? "auto";
  if (typeof reviewer !== "string" || !["auto", ...REVIEWER_NAMES].includes(reviewer)) {
    throw new OpenQodexError(`${path}: reviewer must be auto or one of ${REVIEWER_NAMES.join(", ")}, not ${String(reviewer)}`);
  }
  const web = map.reviewer_web ?? DEFAULT_REVIEWER_WEB;
  if (web !== "on" && web !== "off" && web !== true && web !== false) {
    throw new OpenQodexError(`${path}: reviewer_web must be on or off, not ${String(web)}`);
  }
  return { reviewer, web: web === "on" || web === true };
}
