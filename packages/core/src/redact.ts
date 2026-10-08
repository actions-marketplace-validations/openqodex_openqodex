import { createHash } from "node:crypto";
import type { SecretFingerprint } from "./types.js";

export const REDACTED = "[redacted]";

// Shorter matches are too likely to hit ordinary text.
const MIN_SECRET_LENGTH = 6;

type Span = [start: number, end: number];

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// The texts redaction looks for: each secret, and each line of a secret that
// spans several lines (a private key), trimmed, as a piece of its own. A
// line of a key quoted alone (in a summary, a hunk that holds only part of
// the key, a file the key was copied to) is still the secret. Every span of
// every text is found on the original before any is replaced (replaceSpans),
// so a short secret inside a longer piece never breaks the piece's match.
function usable(secrets: string[]): string[] {
  const pieces = secrets.filter((s) => s.includes("\n")).flatMap((s) => s.split("\n").map((l) => l.replace(/\r$/, "").trim()));
  return [...new Set([...secrets, ...pieces])].filter((s) => s.length >= MIN_SECRET_LENGTH);
}

// Replaces every span, merging spans that overlap or touch. All matches are
// found on the original text first, so one secret overlapping another is
// removed whole instead of leaving its tail behind.
function replaceSpans(text: string, spans: Span[], mark: (secret: string) => string = () => REDACTED): string {
  if (spans.length === 0) return text;
  spans.sort((a, b) => a[0] - b[0]);
  let out = "";
  let cursor = 0;
  let [start, end] = spans[0] as Span;
  for (const [s, e] of spans.slice(1)) {
    if (s <= end) {
      end = Math.max(end, e);
      continue;
    }
    out += text.slice(cursor, start) + mark(text.slice(start, end));
    cursor = end;
    [start, end] = [s, e];
  }
  return out + text.slice(cursor, start) + mark(text.slice(start, end)) + text.slice(end);
}

function spansOf(text: string, secrets: string[]): Span[] {
  const spans: Span[] = [];
  for (const secret of usable(secrets)) {
    for (let at = text.indexOf(secret); at !== -1; at = text.indexOf(secret, at + 1)) {
      spans.push([at, at + secret.length]);
    }
  }
  return spans;
}

// The texts redactSecrets removes for these secrets: each secret and each
// line of a multi-line one. A caller checks its output against these.
export function secretTexts(secrets: string[]): string[] {
  return usable(secrets);
}

// Replace every occurrence of each secret.
export function redactSecrets(text: string, secrets: string[]): string {
  return replaceSpans(text, spansOf(text, secrets));
}

// The same, line by line: each line of a multi-line secret (a private key)
// becomes its own marker and every line break stays, so the lines below keep
// the numbers the scanners and the diff gave them.
export function redactSecretsKeepingLines(text: string, secrets: string[]): string {
  return replaceSpans(text, spansOf(text, secrets), (secret) =>
    secret
      .split("\n")
      .map((line) => (line === "" || line === "\r" ? line : line.endsWith("\r") ? `${REDACTED}\r` : REDACTED))
      .join("\n"),
  );
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
  const spans: Span[] = [];
  for (const [length, hashes] of byLength) {
    for (let i = 0; i + length <= text.length; i += 1) {
      if (hashes.has(sha256(text.slice(i, i + length)))) spans.push([i, i + length]);
    }
  }
  return replaceSpans(text, spans);
}
