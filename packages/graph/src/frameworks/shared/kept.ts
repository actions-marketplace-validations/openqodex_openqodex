// What the Django and Rails plugins keep of a string literal in their
// cached facts.
//
// The facts of every file are cached under .openqodex/graph and feed the
// review packet and the brief, and each plugin reads every file of its
// language, so a literal kept for no reason would copy a secret written
// anywhere in the code into those places. A fact keeps a literal only where
// resolve reads its value, and then only through `keptText`: cut to
// MAX_KEPT characters with a marker, with every key-shaped token replaced
// by core's redaction marker, and dropped whole when its percent-encoded
// form hides one. Downstream, the packet and the brief also pass every
// string through core's redaction of the secrets the scanners found.
import { REDACTED } from "@openqodex/core";

// The longest literal a fact keeps. The route matchers read at most 512
// characters, so a cut literal, longer with its marker, is never matched.
export const MAX_KEPT = 512;
const CUT = "...";

// Prefixes of keys and tokens that common services issue.
const KEY_PREFIXES = ["sk_live_", "sk_test_", "rk_live_", "rk_test_", "pk_live_", "pk_test_", "whsec_", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "glpat-", "xoxa-", "xoxb-", "xoxp-", "xoxr-", "xoxs-", "xapp-", "AKIA", "ASIA", "AIza", "sq0atp-", "sq0csp-", "shpat_", "shpca_", "shppa_", "shpss_", "npm_", "dop_v1_"];

const isTokenChar = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45;

// Whether a run of letters, digits, "_" and "-" looks like a key: it
// starts with a known key prefix and goes on for eight characters or more,
// or one of its pieces between "_" and "-" is an opaque blob of sixteen
// characters or more with at least two digits and two letters (a hex or
// base64 secret, never a word or a slug of words).
export function keyShaped(run: string): boolean {
  for (const p of KEY_PREFIXES) if (run.startsWith(p) && run.length >= p.length + 8) return true;
  let start = 0;
  for (let i = 0; i <= run.length; i++) {
    const c = i < run.length ? run.charCodeAt(i) : 95;
    if (c !== 95 && c !== 45) continue;
    if (i - start >= 16) {
      let digits = 0;
      let letters = 0;
      for (let j = start; j < i; j++) {
        const d = run.charCodeAt(j);
        if (d >= 48 && d <= 57) digits++;
        else letters++;
      }
      if (digits >= 2 && letters >= 2) return true;
    }
    start = i + 1;
  }
  return false;
}

// The text with every key-shaped run replaced by the redaction marker.
function scrub(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (!isTokenChar(s.charCodeAt(i))) {
      out += s[i];
      i++;
      continue;
    }
    let j = i;
    while (j < s.length && isTokenChar(s.charCodeAt(j))) j++;
    const run = s.slice(i, j);
    out += keyShaped(run) ? REDACTED : run;
    i = j;
  }
  return out;
}

// The value of a hexadecimal digit's character code, or -1.
function hexValue(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  const l = c | 32;
  return l >= 97 && l <= 102 ? l - 87 : -1;
}

// The text with its %XX escapes decoded, as a server would read it.
function decoded(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const hi = hexValue(s.charCodeAt(i + 1));
    const lo = hexValue(s.charCodeAt(i + 2));
    if (s[i] === "%" && hi >= 0 && lo >= 0) {
      out += String.fromCharCode(hi * 16 + lo);
      i += 2;
    } else out += s[i];
  }
  return out;
}

// A literal as a fact keeps it: key-shaped runs replaced with the
// redaction marker, then cut to MAX_KEPT characters with a marker. Null
// when the literal's percent-decoded form holds a key: it is dropped whole.
export function keptText(s: string): string | null {
  if (s.includes("%") && scrub(decoded(s)) !== decoded(s)) return null;
  const t = scrub(s);
  return t.length > MAX_KEPT ? `${t.slice(0, MAX_KEPT)}${CUT}` : t;
}

// A path as the plugins read it, a route path in a route table or a
// request a test makes: no scheme, user, password or host, and nothing
// from the first "?" or "#" on; then kept as `keptText` keeps it.
export function pathText(s: string): string | null {
  let p = s;
  const scheme = p.indexOf("://");
  if (scheme >= 0) {
    const slash = p.indexOf("/", scheme + 3);
    p = slash < 0 ? "/" : p.slice(slash);
  }
  for (const stop of ["?", "#"]) {
    const at = p.indexOf(stop);
    if (at >= 0) p = p.slice(0, at);
  }
  return keptText(p);
}

// A dotted name, such as a Python module path or a model reference
// (`mysite.urls`, `auth.User`): identifiers joined by dots, with no
// key-shaped part.
export function dottedText(s: string): string | null {
  if (s.length === 0 || s.length > 256) return null;
  let start = true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const letter = (c | 32) >= 97 && (c | 32) <= 122;
    if (c === 46) {
      if (start) return null;
      start = true;
      continue;
    }
    if (letter || c === 95 || (!start && c >= 48 && c <= 57)) {
      start = false;
      continue;
    }
    return null;
  }
  return start || keptText(s) !== s ? null : s;
}
