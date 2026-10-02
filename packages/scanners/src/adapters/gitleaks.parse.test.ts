// Reading a gitleaks report. Pure: the report shape is real gitleaks 8 JSON
// output (captured from a run on a two-secret file), with the secrets built
// at run time so this file holds no secret-shaped literal.
//
// Failure list, written before the tests:
//   1. A finding's message carries the matched secret or the matched line.
//   2. The matched secrets are not returned for redaction, or an entry with
//      no secret adds an empty string.
//   3. A path under the staging folder is not made repo-relative.
//   5. A description holding a long secret is cut before it is redacted, so
//      the first part of the secret survives the cut.

import { describe, expect, it } from "vitest";
import { parseGitleaksJson, parseGitleaksSecrets } from "./gitleaks.js";

const STAGE = "/tmp/openqodex-gitleaks-src-abc";
const AWS = ["AKIA", "QWERTYUIOPASDFGH"].join("");
const GENERIC = ["zq8Xk2Lm9Pq4", "Rs7Tv1Wx3Yz5Ab6Cd0Ef"].join("");

const REPORT = JSON.stringify([
  {
    RuleID: "aws-access-token",
    Description:
      "Identified a pattern that may indicate AWS credentials, risking unauthorized cloud resource access and data breaches on AWS platforms.",
    StartLine: 2,
    EndLine: 2,
    StartColumn: 13,
    EndColumn: 32,
    Match: AWS,
    Secret: AWS,
    File: `${STAGE}/app.py`,
    SymlinkFile: "",
    Commit: "",
    Entropy: 3.9841838,
    Tags: [],
    Fingerprint: `${STAGE}/app.py:aws-access-token:2`,
  },
  {
    RuleID: "generic-api-key",
    Description: "Detected a Generic API Key, potentially exposing access to various services and sensitive operations.",
    StartLine: 3,
    EndLine: 3,
    StartColumn: 2,
    EndColumn: 45,
    Match: `api_key = "${GENERIC}"`,
    Secret: GENERIC,
    File: `${STAGE}/app.py`,
    SymlinkFile: "",
    Commit: "",
    Entropy: 4.875,
    Tags: [],
    Fingerprint: `${STAGE}/app.py:generic-api-key:3`,
  },
  { RuleID: "no-secret", Description: "x", StartLine: 4, EndLine: 4, File: `${STAGE}/app.py`, Secret: "" },
]);

describe("parseGitleaksJson", () => {
  it("never puts the secret or the matched line in a message (1)", () => {
    const findings = parseGitleaksJson(REPORT, STAGE);
    expect(findings).toHaveLength(3);
    const text = JSON.stringify(findings);
    expect(text).not.toContain(AWS);
    expect(text).not.toContain(GENERIC);
    expect(findings[1]).toMatchObject({ ruleId: "generic-api-key", severity: "high", lineStart: 3 });
  });

  it("makes staging paths repo-relative (3)", () => {
    expect(parseGitleaksJson(REPORT, STAGE).map((f) => f.filePath)).toEqual(["app.py", "app.py", "app.py"]);
  });

});

describe("parseGitleaksSecrets", () => {
  it("returns every matched secret and skips empty ones (2)", () => {
    expect(parseGitleaksSecrets(REPORT)).toEqual([AWS, GENERIC]);
  });
});

describe("redaction before the cut", () => {
  it("redacts the secret before trimming the message (5)", () => {
    const long = "Q".repeat(5) + ["x9", "k2"].join("").repeat(150);
    const json = JSON.stringify([
      { RuleID: "custom", Description: `found ${long}`, StartLine: 1, EndLine: 1, File: `${STAGE}/a.txt`, Secret: long },
    ]);
    const [finding] = parseGitleaksJson(json, STAGE, parseGitleaksSecrets(json));
    expect(finding.message).toBe("found [redacted]");
  });
});
