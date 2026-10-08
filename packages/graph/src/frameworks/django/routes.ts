// Django route patterns as tokens, and a request path matched against them
// by hand. No regular expression is ever built from repository text or run
// on it: a `path()` route is read by a linear scan, a `re_path()` regex is
// read only when it is in a small subset (literal characters and groups of
// a known character class), and matching walks tokens and positions once
// each, under a step budget. A regex outside the subset is kept as text and
// never matched.

export type ParamClass = "digit" | "slug" | "segment" | "hex" | "any";
export type Tok = { lit: string } | { param: ParamClass; min: 0 | 1 };

// The route's display text, and its tokens; null tokens when the route
// cannot be matched against a request (a regex outside the subset).
export type Part = { text: string; toks: Tok[] | null };

export const MAX_TOKENS = 32;
export const MAX_REQUEST = 512;

const CONVERTERS: Record<string, ParamClass> = { int: "digit", str: "segment", slug: "slug", uuid: "hex", path: "any" };

function isWordChar(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "_";
}

function isIdentifier(s: string): boolean {
  if (s.length === 0 || s.length > 64 || (s[0] as string) <= "9") return false;
  for (const c of s) if (!isWordChar(c)) return false;
  return true;
}

function pushLit(toks: Tok[], text: string): void {
  if (text === "") return;
  const last = toks[toks.length - 1];
  if (last && "lit" in last) last.lit += text;
  else toks.push({ lit: text });
}

// A `path()` route: literal text and `<converter:name>` or `<name>` slots.
export function pathTokens(route: string): Tok[] | null {
  const toks: Tok[] = [];
  let i = 0;
  while (i < route.length) {
    const open = route.indexOf("<", i);
    if (open < 0) {
      pushLit(toks, route.slice(i));
      break;
    }
    const close = route.indexOf(">", open + 1);
    if (close < 0) {
      pushLit(toks, route.slice(i));
      break;
    }
    pushLit(toks, route.slice(i, open));
    const inner = route.slice(open + 1, close);
    const colon = inner.indexOf(":");
    const conv = colon < 0 ? "str" : inner.slice(0, colon);
    const name = colon < 0 ? inner : inner.slice(colon + 1);
    if (isIdentifier(name) && (colon < 0 || isIdentifier(conv))) toks.push({ param: CONVERTERS[conv] ?? "segment", min: 1 });
    else pushLit(toks, route.slice(open, close + 1));
    i = close + 1;
  }
  return toks.length > MAX_TOKENS ? null : toks;
}

// The group bodies a `re_path()` regex may use to be matched, and their class.
const REGEX_CLASSES: Record<string, ParamClass> = {
  "\\d+": "digit",
  "[0-9]+": "digit",
  "\\d{4}": "digit",
  "\\d{2}": "digit",
  "\\d{1,2}": "digit",
  "[0-9]{4}": "digit",
  "[0-9]{2}": "digit",
  "\\w+": "slug",
  "[-\\w]+": "slug",
  "[\\w-]+": "slug",
  "[-a-zA-Z0-9_]+": "slug",
  "[a-zA-Z0-9_-]+": "slug",
  "[^/]+": "segment",
  "[^/.]+": "segment",
  "[0-9a-f-]+": "hex",
  "[0-9a-fA-F-]+": "hex",
  ".+": "any",
  ".*": "any",
};

const LITERAL_ESCAPES = new Set(["/", ".", "-", "_", "~"]);

// A `re_path()` regex in the subset, as tokens; null when it is outside it.
export function regexTokens(regex: string): Tok[] | null {
  let s = regex;
  if (s.startsWith("^")) s = s.slice(1);
  if (s.endsWith("$") && !s.endsWith("\\$")) s = s.slice(0, -1);
  const toks: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i] as string;
    if (c === "(") {
      const close = s.indexOf(")", i + 1);
      if (close < 0) return null;
      let body = s.slice(i + 1, close);
      if (body.startsWith("?P<")) {
        const end = body.indexOf(">");
        if (end < 0 || !isIdentifier(body.slice(3, end))) return null;
        body = body.slice(end + 1);
      } else if (body.startsWith("?:")) body = body.slice(2);
      const cls = REGEX_CLASSES[body];
      if (!cls) return null;
      toks.push({ param: cls, min: body.endsWith("*") ? 0 : 1 });
      i = close + 1;
      continue;
    }
    if (c === "\\") {
      const next = s[i + 1];
      if (next === undefined || !LITERAL_ESCAPES.has(next)) return null;
      pushLit(toks, next);
      i += 2;
      continue;
    }
    if (c === "/" && s[i + 1] === "?" && i + 2 === s.length) {
      // A trailing optional slash: the request may or may not end with one.
      toks.push({ param: "any", min: 0 });
      return toks.length > MAX_TOKENS ? null : toks;
    }
    if (isWordChar(c) || c === "/" || c === "-" || c === "~") {
      pushLit(toks, c);
      i++;
      continue;
    }
    return null;
  }
  return toks.length > MAX_TOKENS ? null : toks;
}

export function routePart(route: string, regex: boolean): Part {
  if (!regex) return { text: route, toks: pathTokens(route) };
  let text = route.startsWith("^") ? route.slice(1) : route;
  if (text.endsWith("$") && !text.endsWith("\\$")) text = text.slice(0, -1);
  return { text, toks: regexTokens(route) };
}

export function joinTokens(parts: readonly Part[]): Tok[] | null {
  const out: Tok[] = [];
  for (const p of parts) {
    if (p.toks === null) return null;
    for (const t of p.toks) {
      if ("lit" in t) pushLit(out, t.lit);
      else out.push(t);
    }
  }
  return out.length > MAX_TOKENS ? null : out;
}

function inClass(c: string, cls: ParamClass): boolean {
  switch (cls) {
    case "digit":
      return c >= "0" && c <= "9";
    case "slug":
      return isWordChar(c) || c === "-";
    case "segment":
      return c !== "/";
    case "hex":
      return (c >= "0" && c <= "9") || (c >= "a" && c <= "f") || (c >= "A" && c <= "F") || c === "-";
    case "any":
      return true;
  }
}

// The request path a test sends, as Django matches it: no scheme or host,
// no query or fragment, no leading slash.
export function requestPath(raw: string): string | null {
  let p = raw;
  const scheme = p.indexOf("://");
  if (scheme >= 0) {
    const slash = p.indexOf("/", scheme + 3);
    p = slash < 0 ? "" : p.slice(slash);
  }
  const q = p.search(/[?#]/);
  if (q >= 0) p = p.slice(0, q);
  if (p.startsWith("/")) p = p.slice(1);
  return p.length > MAX_REQUEST ? null : p;
}

export type Budget = { steps: number };

// Whether the tokens match the whole path. Each (token, position) state is
// expanded once; every candidate end a parameter tries costs one step from
// the shared budget. "budget" when it runs out before an answer.
export function matchTokens(toks: readonly Tok[], path: string, budget: Budget): boolean | "budget" {
  const n = path.length;
  const seen = new Uint8Array((toks.length + 1) * (n + 1));
  const stack: [number, number][] = [[0, 0]];
  while (stack.length > 0) {
    const [ti, pos] = stack.pop() as [number, number];
    const key = ti * (n + 1) + pos;
    if (seen[key]) continue;
    seen[key] = 1;
    if (--budget.steps < 0) return "budget";
    if (ti === toks.length) {
      if (pos === n) return true;
      continue;
    }
    const t = toks[ti] as Tok;
    if ("lit" in t) {
      if (path.startsWith(t.lit, pos)) stack.push([ti + 1, pos + t.lit.length]);
      continue;
    }
    let end = pos;
    while (end < n && inClass(path[end] as string, t.param)) end++;
    const next = toks[ti + 1];
    for (let e = pos + t.min; e <= end; e++) {
      if (--budget.steps < 0) return "budget";
      // A literal next token must start where the parameter ends.
      if (next && "lit" in next && !path.startsWith(next.lit, e)) continue;
      stack.push([ti + 1, e]);
    }
  }
  return false;
}
