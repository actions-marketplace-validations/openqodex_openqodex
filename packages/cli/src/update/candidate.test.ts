// Which npm releases the self-update may install. The input is literal
// registry metadata in the shape npm serves for the full package document.
//
// Failure list, written before the code:
//   1. A version published less than 24 hours ago is offered (the age rule
//      is the containment window for a stolen publish token).
//   2. A prerelease (0.3.0-beta.1) is offered.
//   3. A deprecated version is offered.
//   4. A version lower than or equal to the running one is offered, so the
//      updater could roll an install back.
//   5. A version whose tarball is not on registry.npmjs.org under
//      /openqodex/-/ is offered, so the download could come from anywhere.
//   6. A version whose engines.node needs a newer Node than the running one
//      is offered, and the install would not start.
//   7. A version with no sha512 integrity or no registry attestation URL is
//      offered, so it could never be verified.
//   8. A version on another major is offered once the major is above 0.
//   9. A version or engines range that does not parse is offered instead of
//      skipped.
//  10. Two eligible versions do not come back highest first, so the caller
//      would install an older one or could not fall back to the next.
//  11. A release's declared contract (package.json "openqodex") is misread,
//      or a release from before contracts reads as having one.
//  13. A release at or below the skip_version a rollback left is offered,
//      so the update brings back the release just rolled back from; or one
//      above it is not, so updates stop.
//  12. The background worker installs a release that changes the agent
//      contract or the config format, or does not leave the newest such
//      release for a foreground update while it installs a lower one that
//      keeps the contract.

import { describe, expect, it } from "vitest";
import { byContract, contractChange, selectCandidates } from "./candidate.js";

const HOUR = 60 * 60 * 1000;
const now = Date.parse("2026-10-10T12:00:00.000Z");
const ago = (hours: number) => new Date(now - hours * HOUR).toISOString();

function release(version: string, extra: Record<string, unknown> = {}) {
  return {
    name: "openqodex",
    version,
    engines: { node: ">=22" },
    dist: {
      tarball: `https://registry.npmjs.org/openqodex/-/openqodex-${version}.tgz`,
      integrity: "sha512-H8vzFRcJkV8L92GMeR8LGw8cdxKDBKfG1ZX0o4UpGfaMl6ULBfO67YCw1jookROJfL9apikmZvWYARv9nJ03bA==",
      attestations: {
        url: `https://registry.npmjs.org/-/npm/v1/attestations/openqodex@${version}`,
        provenance: { predicateType: "https://slsa.dev/provenance/v1" },
      },
    },
    ...extra,
  };
}

function metadata(entries: Array<[ReturnType<typeof release>, string]>) {
  return {
    name: "openqodex",
    versions: Object.fromEntries(entries.map(([r]) => [r.version, r])),
    time: Object.fromEntries(entries.map(([r, t]) => [r.version, t])),
  };
}

const opts = { current: "0.2.0", now, nodeVersion: "22.23.3" };
const versions = (m: unknown, o: Parameters<typeof selectCandidates>[1] = opts) => selectCandidates(m, o).map((c) => c.version);

describe("selectCandidates", () => {
  it("a release 23 hours old is not offered and one 25 hours old is (failure 1)", () => {
    expect(versions(metadata([[release("0.3.0"), ago(23)]]))).toEqual([]);
    expect(versions(metadata([[release("0.3.0"), ago(25)]]))).toEqual(["0.3.0"]);
  });

  it("a prerelease is not offered (failure 2)", () => {
    expect(versions(metadata([[release("0.3.0-beta.1"), ago(48)]]))).toEqual([]);
  });

  it("a deprecated version is not offered (failure 3)", () => {
    expect(versions(metadata([[release("0.3.0", { deprecated: "broken install" }), ago(48)]]))).toEqual([]);
  });

  it("a lower or equal version is not offered (failure 4)", () => {
    expect(versions(metadata([[release("0.1.0"), ago(96)], [release("0.2.0"), ago(48)]]))).toEqual([]);
  });

  it("a tarball outside registry.npmjs.org/openqodex/-/ is not offered (failure 5)", () => {
    const elsewhere = release("0.3.0");
    elsewhere.dist.tarball = "https://example.com/openqodex/-/openqodex-0.3.0.tgz";
    const plain = release("0.3.1");
    plain.dist.tarball = "http://registry.npmjs.org/openqodex/-/openqodex-0.3.1.tgz";
    const other = release("0.3.2");
    other.dist.tarball = "https://registry.npmjs.org/evil/-/openqodex-0.3.2.tgz";
    expect(versions(metadata([[elsewhere, ago(48)], [plain, ago(48)], [other, ago(48)]]))).toEqual([]);
  });

  it("a version that needs a newer Node is not offered (failure 6)", () => {
    expect(versions(metadata([[release("0.3.0", { engines: { node: ">=24" } }), ago(48)]]))).toEqual([]);
    expect(versions(metadata([[release("0.3.0", { engines: { node: ">=22.30.0" } }), ago(48)]]))).toEqual([]);
    expect(versions(metadata([[release("0.3.0", { engines: { node: ">=22.20" } }), ago(48)]]))).toEqual(["0.3.0"]);
  });

  it("a version with no sha512 integrity or no registry attestation URL is not offered (failure 7)", () => {
    const sha1 = release("0.3.0");
    sha1.dist.integrity = "sha1-RSTodFSV6ODeTkfvLsJXc1yWrqs=";
    const noAttestation = release("0.3.1");
    (noAttestation.dist as Record<string, unknown>).attestations = undefined;
    const foreignAttestation = release("0.3.2");
    foreignAttestation.dist.attestations.url = "https://example.com/-/npm/v1/attestations/openqodex@0.3.2";
    expect(versions(metadata([[sha1, ago(48)], [noAttestation, ago(48)], [foreignAttestation, ago(48)]]))).toEqual([]);
  });

  it("another major is not offered above 0, and any higher 0.x is offered at 0 (failure 8)", () => {
    const m = metadata([[release("1.4.0"), ago(48)], [release("2.0.0"), ago(48)], [release("1.3.1"), ago(48)]]);
    expect(versions(m, { ...opts, current: "1.3.0" })).toEqual(["1.4.0", "1.3.1"]);
    expect(versions(metadata([[release("0.9.0"), ago(48)], [release("1.0.0"), ago(48)]]))).toEqual(["0.9.0"]);
  });

  it("a version, time or engines range that does not parse is skipped (failure 9)", () => {
    const m = metadata([
      [release("0.3"), ago(48)],
      [release("0.03.0"), ago(48)],
      [release("0.4.0", { engines: { node: "^22 || ^24" } }), ago(48)],
      [release("0.5.0"), "yesterday"],
    ]);
    expect(versions(m)).toEqual([]);
    expect(versions(metadata([[release("0.3.0"), ago(48)]]), { ...opts, current: "zero" })).toEqual([]);
    expect(selectCandidates(null, opts)).toEqual([]);
  });

  it("eligible versions come back highest first with what the caller needs (failure 10)", () => {
    const m = metadata([[release("0.3.0"), ago(72)], [release("0.10.0"), ago(48)], [release("0.4.1"), ago(30)]]);
    const found = selectCandidates(m, opts);
    expect(found.map((c) => c.version)).toEqual(["0.10.0", "0.4.1", "0.3.0"]);
    expect(found[0]).toEqual({
      version: "0.10.0",
      tarball: "https://registry.npmjs.org/openqodex/-/openqodex-0.10.0.tgz",
      integrity: release("0.10.0").dist.integrity,
      attestationsUrl: "https://registry.npmjs.org/-/npm/v1/attestations/openqodex@0.10.0",
      publishedAt: ago(48),
      contract: null,
    });
  });

  it("reads the contract each release declares, and none for a release from before contracts (failure 11)", () => {
    const m = metadata([
      [release("0.3.0"), ago(48)],
      [release("0.4.0", { openqodex: { agentContract: 2, configFormat: 1 } }), ago(48)],
      [release("0.5.0", { openqodex: { agentContract: "2", configFormat: 1 } }), ago(48)],
      [release("0.6.0", { openqodex: { agentContract: 0, configFormat: 1 } }), ago(48)],
    ]);
    const found = Object.fromEntries(selectCandidates(m, opts).map((c) => [c.version, c.contract]));
    expect(found).toEqual({ "0.3.0": null, "0.4.0": { agent: 2, config: 1 }, "0.5.0": null, "0.6.0": null });
  });
});

describe("skip_version", () => {
  it("a release at or below the one a rollback left is not offered, and the next one above it is (failure 13)", () => {
    // Updated to 0.3.1, rolled back to 0.3.0: skip_version is 0.3.1.
    const m = metadata([[release("0.3.1"), ago(72)], [release("0.3.2"), ago(48)]]);
    expect(versions(m, { ...opts, current: "0.3.0", skip: "0.3.1" })).toEqual(["0.3.2"]);
    expect(versions(m, { ...opts, current: "0.3.0", skip: "0.3.2" })).toEqual([]);
    expect(versions(m, { ...opts, current: "0.3.0", skip: null })).toEqual(["0.3.2", "0.3.1"]);
  });
});

describe("byContract", () => {
  const keep = { agent: 1, config: 1 };
  const m = metadata([
    [release("0.9.1", { openqodex: { agentContract: 1, configFormat: 1 } }), ago(72)],
    [release("0.9.2", { openqodex: { agentContract: 1, configFormat: 1 } }), ago(48)],
    [release("0.10.0", { openqodex: { agentContract: 2, configFormat: 1 } }), ago(48)],
    [release("0.11.0", { openqodex: { agentContract: 2, configFormat: 2 } }), ago(30)],
  ]);
  const all = selectCandidates(m, { ...opts, current: "0.9.0" });

  it("installs only releases with the contract kept, and leaves the newest other one for a foreground update (failure 12)", () => {
    const { install, held } = byContract(all, keep);
    expect(install.map((c) => c.version)).toEqual(["0.9.2", "0.9.1"]);
    expect(held?.version).toBe("0.11.0");
    expect(contractChange(held!.contract, keep)).toBe("how agents run a review and the config format");
    expect(contractChange({ agent: 1, config: 2 }, keep)).toBe("the config format");
  });

  it("holds nothing back when every newer release keeps the contract, and holds back every release when none does (failure 12)", () => {
    expect(byContract(all.filter((c) => c.contract?.agent === 1), keep).held).toBeNull();
    const none = byContract(all, { agent: 3, config: 1 });
    expect(none.install).toEqual([]);
    expect(none.held?.version).toBe("0.11.0");
  });
});
