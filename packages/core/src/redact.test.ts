import { describe, expect, it } from "vitest";
import { REDACTED, fingerprintSecrets, redactByFingerprint, redactSecrets } from "./redact.js";

const SECRET = ["sk", "live", "abcDEF123456ghiJKL7890mn"].join("_");

describe("redact", () => {
  it("removes every occurrence of a known secret", () => {
    const text = `key = "${SECRET}" and again ${SECRET}.`;
    const out = redactSecrets(text, [SECRET]);
    expect(out).not.toContain(SECRET);
    expect(out).toBe(`key = "${REDACTED}" and again ${REDACTED}.`);
  });

  it("removes a secret from text using only its fingerprint", () => {
    const fingerprints = fingerprintSecrets([SECRET]);
    expect(JSON.stringify(fingerprints)).not.toContain(SECRET);
    const out = redactByFingerprint(`rotate ${SECRET} now`, fingerprints);
    expect(out).toBe(`rotate ${REDACTED} now`);
  });

  it("two secrets that overlap in the text are both removed, with no tail of either left behind", () => {
    const first = "ABCDEFGHIJ";
    const second = "JKLMNOPQR";
    const text = "key ABCDEFGHIJKLMNOPQR end";
    expect(redactSecrets(text, [first, second])).toBe(`key ${REDACTED} end`);
    expect(redactByFingerprint(text, fingerprintSecrets([first, second]))).toBe(`key ${REDACTED} end`);
  });

  // A scanner matches a private key whole; any one of its lines, quoted
  // alone (in a summary, a suggested change, a file the key was copied to),
  // is still the secret.
  const PEM = ["-----BEGIN RSA PRIVATE KEY-----", "MIIEowIBAAKCAQEAq7BFUpkGp3LQmlQBmpP2Wvs7Y0dQ9XDu1cJx0j4Q2PbTnZ5", "x4yWm9lHk1oNn2E8sR7dQwUy3aXhY5tTq6Ff0yG7bLc9dK1mN2pQ3rS4tU5vW6xY", "-----END RSA PRIVATE KEY-----"].join("\n");
  const BODY = PEM.split("\n")[1]!;

  it("a line of a multi-line secret quoted alone is redacted, by the secret and by its saved fingerprints", () => {
    const summary = `The change commits a key; its first line is ${BODY}.`;
    expect(redactSecrets(summary, [PEM])).not.toContain(BODY.slice(0, 20));
    expect(redactByFingerprint(summary, fingerprintSecrets([PEM]))).not.toContain(BODY.slice(0, 20));
  });

  it("a shorter secret inside a line of a multi-line secret does not break that line's redaction and leave its start behind", () => {
    const inner = BODY.slice(30);
    const text = `context\n${BODY}\nmore`;
    const out = redactSecrets(text, [inner, PEM]);
    expect(out).toBe(`context\n${REDACTED}\nmore`);
  });

  it("text without a secret is unchanged, and a very short secret is ignored so it cannot shred the report", () => {
    expect(redactByFingerprint("nothing here", fingerprintSecrets([SECRET]))).toBe("nothing here");
    expect(redactSecrets("a b c", ["b"])).toBe("a b c");
    expect(fingerprintSecrets(["b"])).toEqual([]);
  });
});
