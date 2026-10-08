// `openqodex trust` approves a custom scanner by the hash of its parsed
// entry, every default filled in (customEntryHash). A release that changes
// one of those defaults, or the shape of the parsed entry, changes the hash
// of every entry on every machine: each approved scanner then reads as
// "changed since approval" and stops running until `openqodex trust` runs
// again.
//
// Ways it could fail, written before the code:
//  1. A change to a default of a custom entry (timeout_seconds, target,
//     format, install) ships without anyone noticing that it revokes every
//     approval. This hash is pinned: a change that moves it must ship a
//     changeset telling users to run `openqodex trust` again, and update it.
import { describe, expect, it } from "vitest";
import { customEntryHash, parseConfig } from "../src/config.js";

const MINIMAL = "scanners:\n  custom:\n    - source: https://github.com/aquasecurity/trivy\n      run: trivy config --format sarif --output {report} {target}\n";

describe("the custom scanner approval hash", () => {
  it("of the minimal entry is pinned, so a release that changes a filled-in default cannot revoke every approval unnoticed (failure 1)", () => {
    const entry = parseConfig(MINIMAL).config.custom[0]!;
    expect(customEntryHash(entry)).toBe("96c0e919c9b36a7788f76c80a635bf0647b26cb51d5dec3d16c7222dd9cd42a1");
  });
});
