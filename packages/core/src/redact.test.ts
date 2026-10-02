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

  it("leaves text without the secret unchanged and ignores very short secrets", () => {
    expect(redactByFingerprint("nothing here", fingerprintSecrets([SECRET]))).toBe("nothing here");
    expect(redactSecrets("a b c", ["b"])).toBe("a b c");
    expect(fingerprintSecrets(["b"])).toEqual([]);
  });
});
