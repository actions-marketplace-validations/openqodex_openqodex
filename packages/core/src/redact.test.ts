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

  it("text without a secret is unchanged, and a very short secret is ignored so it cannot shred the report", () => {
    expect(redactByFingerprint("nothing here", fingerprintSecrets([SECRET]))).toBe("nothing here");
    expect(redactSecrets("a b c", ["b"])).toBe("a b c");
    expect(fingerprintSecrets(["b"])).toEqual([]);
  });
});
