// What a framework plugin keeps of a string literal in its cached facts:
// one rule for every plugin.
//
// The facts of every file are cached under .openqodex/graph and feed the
// review packet and the brief, and each plugin reads every file of its
// language, so a literal kept for no reason would copy a secret written
// anywhere in the code (an API key, a header, a test's title, a URL's user
// or query string) into those places. A plugin keeps a literal only where
// its resolve reads one, and only through this file:
// - shaped: in the form the plugin reads it in (a route path or a piece of
//   one, a request target, an HTTP method, a route name, a dotted name), and
//   nothing past a query string or a fragment;
// - bounded: cut to MAX_KEPT characters with a marker;
// - redacted: every key-shaped run replaced by core's redaction marker, and
//   the literal dropped whole when its percent-decoded form hides one.
// Every other literal is kept as a placeholder the plugin does not read.
// Downstream, the packet and the brief also pass every string through
// core's redaction of the secrets the scanners found.
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

// A shape a plugin reads in, kept by the rule: the shaped text as
// `keptText` keeps it, or null when the shape does not hold.
export function keptShape(shape: (s: string) => string | null): (s: string) => string | null {
  return (s) => {
    const t = shape(s);
    return t === null ? null : keptText(t);
  };
}

// ---------- the shapes of an HTTP router's routes and requests ----------

// The text before a fragment and before a query string (a "?" with a
// name=value after it). No route path or pattern holds either, and no
// plugin matches a request by them. A "?" with no "=" after it stays: in an
// Express path it makes a parameter optional (`/users/:id?`).
export function cutQuery(s: string): string {
  let t = s;
  const hash = t.indexOf("#");
  if (hash >= 0) t = t.slice(0, hash);
  const q = t.indexOf("?");
  if (q >= 0 && t.indexOf("=", q) >= 0) t = t.slice(0, q);
  return t;
}

// An absolute http or https URL split into its scheme and host (with no
// user or password) and its path (with no query or fragment); null when
// the text is not one.
export function urlParts(s: string): { origin: string; path: string } | null {
  const lower = s.slice(0, 8).toLowerCase();
  const scheme = lower.startsWith("https://") ? "https" : lower.startsWith("http://") ? "http" : null;
  if (scheme === null) return null;
  const rest = s.slice(scheme.length + 3);
  let end = rest.length;
  for (const stop of ["/", "?", "#"]) {
    const i = rest.indexOf(stop);
    if (i >= 0 && i < end) end = i;
  }
  const authority = rest.slice(0, end);
  const host = authority.slice(authority.lastIndexOf("@") + 1);
  let path = rest.slice(end);
  for (const stop of ["?", "#"]) {
    const i = path.indexOf(stop);
    if (i >= 0) path = path.slice(0, i);
  }
  return { origin: `${scheme}://${host}`, path };
}

// A route path or prefix as an HTTP router writes it: "", "*", or text that
// starts with "/", without a query string; an absolute URL gives its path.
function rootedShape(s: string): string | null {
  const u = urlParts(s);
  if (u) return u.path;
  const t = cutQuery(s);
  return t === "" || t === "*" || t.startsWith("/") ? t : null;
}
export const rootedPathText = keptShape(rootedShape);

// An HTTP method as written: letters only.
export const methodText = keptShape((s) => {
  if (s.length === 0 || s.length > 20) return null;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i) | 32;
    if (c < 97 || c > 122) return null;
  }
  return s;
});

// A name a route is given (`name="read_item"`): a letter or "_" first, then
// letters, digits, "_", "-" or ".".
export const nameText = keptShape((s) => {
  if (s.length === 0 || s.length > 128) return null;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const letter = (c | 32) >= 97 && (c | 32) <= 122;
    if (letter || c === 95 || (i > 0 && ((c >= 48 && c <= 57) || c === 45 || c === 46))) continue;
    return null;
  }
  return s;
});

// A later piece of a path, such as the `v1` of `/${VERSION}/users`: any
// text before a query string, but no absolute URL.
export const segmentText = keptShape((s) => (urlParts(s) === null ? cutQuery(s) : null));

// The pieces of a concatenation in a place a plugin reads a path: the first
// literal in the form `first` gives (null drops the whole concatenation),
// later literals as written up to a query string or a fragment, each kept
// by the rule (one that is not drops the whole concatenation too), and no
// piece past a query string or a fragment. `use` hears of each name a
// piece reads, with the first piece that leads it (null for the first
// piece itself), so its constant can be kept in the form that place reads
// (`ledForm`).
export function keepParts<P extends { s: string } | { ref: string[] }>(parts: readonly P[], first: (s: string) => string | null, use: (ref: string[], lead: P | null) => void): P[] | null {
  const out: P[] = [];
  for (const [i, p] of parts.entries()) {
    if (!("s" in p)) {
      use(p.ref, i === 0 ? null : (parts[0] as P));
      out.push(p);
      continue;
    }
    const cut = cutQuery(p.s);
    const t = i === 0 ? first(p.s) : keptText(cut);
    if (t === null) return null;
    out.push({ ...p, s: t });
    // Past a query string, nothing is read.
    if (cut !== p.s || (urlParts(p.s) !== null && (p.s.includes("?") || p.s.includes("#")))) break;
  }
  return out;
}

// The form a constant read as a later piece of a concatenation is kept in.
// After a literal path, or a name whose constant is a path, it is a piece of
// that path: a segment. After an absolute URL, or a name whose constant is
// one, the concatenation is an address of another host, and a piece of it
// is kept only as a path, so a key written into such an address
// (`"https://api.example.com/bot" + TOKEN`) is not kept.
export function ledForm(lead: { s: string } | { ref: string[] }, constant: (name: string) => string | null): "segment" | "path" {
  const text = "s" in lead ? lead.s : lead.ref.length === 1 ? constant(lead.ref[0] as string) : null;
  return text !== null && urlParts(text) === null && rootedShape(text) !== null ? "segment" : "path";
}
