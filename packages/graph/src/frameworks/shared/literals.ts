// What a framework plugin keeps of a string literal in its cached facts.
//
// The facts of every file are kept under .openqodex/graph, and each plugin
// reads every file of its language, so a literal a plugin kept would copy a
// secret written anywhere in the code (an API key, a client's argument, a
// header, a test's title, a URL's user or query string) into that folder. A
// plugin reads a string only as a route path, a prefix or a pattern, a
// request target or an HTTP method, so its facts keep a literal only where
// it reads one, and only in the form it reads it in. Every other literal is
// kept as a value the plugin does not read.

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

// A route path or prefix as the plugins read it: "", "*", or text that
// starts with "/", without a query string; an absolute URL gives its path.
export function pathText(s: string): string | null {
  const u = urlParts(s);
  if (u) return u.path;
  const t = cutQuery(s);
  return t === "" || t === "*" || t.startsWith("/") ? t : null;
}

// An HTTP method as written: letters only.
export function methodText(s: string): string | null {
  if (s.length === 0 || s.length > 20) return null;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i) | 32;
    if (c < 97 || c > 122) return null;
  }
  return s;
}

// A name a route is given (`name="read_item"`): a letter or "_" first, then
// letters, digits, "_", "-" or ".".
export function nameText(s: string): string | null {
  if (s.length === 0 || s.length > 128) return null;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const letter = (c | 32) >= 97 && (c | 32) <= 122;
    if (letter || c === 95 || (i > 0 && ((c >= 48 && c <= 57) || c === 45 || c === 46))) continue;
    return null;
  }
  return s;
}

// The pieces of a concatenation in a place a plugin reads a path: the first
// literal in the form `first` gives (null drops the whole concatenation),
// later literals as written, and the pieces up to a query string or a
// fragment and no further. `use` hears of each name a piece reads, and
// whether it is the first piece, so its constant can be kept.
export function keepParts<P extends { s: string } | { ref: string[] }>(parts: readonly P[], first: (s: string) => string | null, use: (ref: string[], first: boolean) => void): P[] | null {
  const out: P[] = [];
  for (const [i, p] of parts.entries()) {
    if (!("s" in p)) {
      use(p.ref, i === 0);
      out.push(p);
      continue;
    }
    const cut = cutQuery(p.s);
    const t = i === 0 ? first(p.s) : cut;
    if (t === null) return null;
    out.push({ ...p, s: t });
    // Past a query string, nothing is read.
    if (cut !== p.s || (urlParts(p.s) !== null && (p.s.includes("?") || p.s.includes("#")))) break;
  }
  return out;
}
