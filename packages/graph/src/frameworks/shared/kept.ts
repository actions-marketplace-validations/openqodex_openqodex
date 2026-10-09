// What the Django and Rails plugins keep of a string literal in their
// cached facts.
//
// The facts of every file are cached under .openqodex/graph and feed the
// review packet and the brief, and each plugin reads every file of its
// language, so a literal kept for no reason would copy a secret written
// anywhere in the code (a key in a setting, a route's defaults, a test
// request's query string, a URL's user) into those places. A fact keeps a
// literal only where resolve reads its value, and only in the form resolve
// reads it in; every other literal is kept as a value the plugin does not
// read.

// A request a test makes, as the route matchers read it: the path alone,
// with no scheme, user, password or host, and nothing from the first "?"
// or "#" on.
export function requestTarget(s: string): string {
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
  return p;
}

// A route path as written in a route table: an absolute http or https URL
// keeps its scheme, host and path (no user, password, query string or
// fragment); any other text loses a query string, a "?" with a "=" after
// it, and what follows. A "#" stays: in a Rails route it separates the
// controller from the action.
export function routeText(s: string): string {
  const lower = s.slice(0, 8).toLowerCase();
  const scheme = lower.startsWith("https://") ? "https" : lower.startsWith("http://") ? "http" : null;
  if (scheme !== null) {
    const rest = s.slice(scheme.length + 3);
    let end = rest.length;
    for (const stop of ["/", "?", "#"]) {
      const i = rest.indexOf(stop);
      if (i >= 0 && i < end) end = i;
    }
    const authority = rest.slice(0, end);
    return `${scheme}://${authority.slice(authority.lastIndexOf("@") + 1)}${requestTarget(rest.slice(end))}`;
  }
  const q = s.indexOf("?");
  return q >= 0 && s.indexOf("=", q) >= 0 ? s.slice(0, q) : s;
}

// A dotted name, such as a Python module path or a model reference
// (`mysite.urls`, `auth.User`): identifiers joined by dots.
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
  return start ? null : s;
}
