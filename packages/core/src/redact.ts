import { createHash } from "node:crypto";
import type { SecretFingerprint } from "./types.js";

export const REDACTED = "[redacted]";

// Shorter matches are too likely to hit ordinary text.
const MIN_SECRET_LENGTH = 6;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function usable(secrets: string[]): string[] {
  return [...new Set(secrets)].filter((s) => s.length >= MIN_SECRET_LENGTH);
}

// Replace every occurrence of each secret. Longest first, so a secret that
// contains another is removed whole.
export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of usable(secrets).sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join(REDACTED);
  }
  return out;
}

export function fingerprintSecrets(secrets: string[]): SecretFingerprint[] {
  return usable(secrets).map((s) => ({ length: s.length, sha256: sha256(s) }));
}

// Redact without knowing the secrets: slide a window of each fingerprint's
// length over the text and replace the windows whose hash matches. Meant for
// short text (a finding's title, description and suggested change).
export function redactByFingerprint(text: string, fingerprints: SecretFingerprint[]): string {
  const byLength = new Map<number, Set<string>>();
  for (const f of fingerprints) {
    const set = byLength.get(f.length) ?? new Set<string>();
    set.add(f.sha256);
    byLength.set(f.length, set);
  }
  let out = text;
  for (const length of [...byLength.keys()].sort((a, b) => b - a)) {
    const hashes = byLength.get(length);
    if (!hashes) continue;
    let result = "";
    let i = 0;
    while (i < out.length) {
      if (i + length <= out.length && hashes.has(sha256(out.slice(i, i + length)))) {
        result += REDACTED;
        i += length;
      } else {
        result += out[i];
        i += 1;
      }
    }
    out = result;
  }
  return out;
}
