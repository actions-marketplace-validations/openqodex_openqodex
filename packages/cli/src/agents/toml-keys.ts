// Every key path a TOML file defines, read before `init` appends its block
// to Codex's config.toml (mcp.ts): a second definition of a server makes
// Codex refuse the whole file, and a pattern over the text misses a quoted
// or escaped key and mistakes text inside a string for a key. This reader
// follows TOML 1.0 (https://toml.io/en/v1.0.0) as far as keys go: it
// decodes every key, bare, basic (escapes included) or literal, in table
// headers, array-of-tables headers, dotted keys and inline tables, and steps
// over every value and comment without taking anything in them for a key.
// It reads text only and runs nothing. A file it cannot read is reported as
// such, never guessed at. Inline tables may span lines (TOML 1.1); the
// caller only ever leaves a file it cannot read alone, so accepting a little
// more than 1.0 costs nothing.

// `table`: a [header]; `array-table`: a [[header]]; `inline-table`,
// `array` and `value`: what a key is set to.
export type KeyKind = "table" | "array-table" | "inline-table" | "array" | "value";
export type KeyDef = { path: string[]; kind: KeyKind };

class NotToml extends Error {}

const BARE = /[A-Za-z0-9_-]/;
// What ends a bare value: whitespace, a separator, a closing bracket or a comment.
const VALUE_END = /[\s,\]}#]/;
const INT = String.raw`[+-]?(?:0|[1-9](?:_?\d)*)`;
const SCALAR = new RegExp(
  "^(?:" +
    [
      "true",
      "false",
      String.raw`[+-]?(?:inf|nan)`,
      String.raw`0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*`,
      String.raw`0o[0-7](?:_?[0-7])*`,
      String.raw`0b[01](?:_?[01])*`,
      String.raw`${INT}(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?`,
      // Dates, times and both; a space before the time is read as T.
      String.raw`\d{4}-\d{2}-\d{2}(?:[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?`,
      String.raw`\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?`,
    ].join("|") +
    ")$",
);
const ESCAPES: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };

// The key paths `text` defines, in the order it defines them, or why it is
// not TOML this reader can read.
export function readTomlKeys(text: string): { ok: true; keys: KeyDef[] } | { ok: false; reason: string } {
  try {
    return { ok: true, keys: new Reader(text).read() };
  } catch (error) {
    if (error instanceof NotToml) return { ok: false, reason: error.message };
    throw error;
  }
}

class Reader {
  private i: number;
  private readonly keys: KeyDef[] = [];

  constructor(private readonly s: string) {
    this.i = s.startsWith("﻿") ? 1 : 0;
  }

  read(): KeyDef[] {
    const s = this.s;
    let table: string[] = [];
    for (;;) {
      this.spaces();
      this.comment();
      if (this.i >= s.length) return this.keys;
      if (this.newline()) continue;
      if (s[this.i] === "[") {
        const array = s[this.i + 1] === "[";
        this.i += array ? 2 : 1;
        this.spaces();
        const path = this.key();
        this.spaces();
        const close = array ? "]]" : "]";
        if (!s.startsWith(close, this.i)) this.fail(`a table header without its closing ${close}`);
        this.i += close.length;
        table = path;
        this.keys.push({ path, kind: array ? "array-table" : "table" });
      } else {
        const path = [...table, ...this.key()];
        this.spaces();
        if (s[this.i] !== "=") this.fail("a key without = and a value");
        this.i++;
        this.spaces();
        this.keys.push({ path, kind: this.value(path) });
      }
      this.endOfLine();
    }
  }

  private fail(what: string): never {
    const line = this.s.slice(0, this.i).split("\n").length;
    throw new NotToml(`${what} on line ${line}`);
  }

  private spaces(): void {
    while (this.s[this.i] === " " || this.s[this.i] === "\t") this.i++;
  }

  private newline(): boolean {
    if (this.s[this.i] === "\n") {
      this.i++;
      return true;
    }
    if (this.s[this.i] === "\r" && this.s[this.i + 1] === "\n") {
      this.i += 2;
      return true;
    }
    return false;
  }

  private atLineEnd(): boolean {
    return this.s[this.i] === "\n" || (this.s[this.i] === "\r" && this.s[this.i + 1] === "\n");
  }

  private comment(): void {
    if (this.s[this.i] !== "#") return;
    while (this.i < this.s.length && !this.atLineEnd()) this.i++;
  }

  private endOfLine(): void {
    this.spaces();
    this.comment();
    if (this.i < this.s.length && !this.newline()) this.fail("more text after a value or a header");
  }

  // Whitespace, line ends and comments, as an array or an inline table may hold.
  private gaps(): void {
    for (;;) {
      this.spaces();
      this.comment();
      if (!this.newline()) return;
    }
  }

  // A dotted key, each part decoded; whitespace may stand around the dots.
  private key(): string[] {
    const parts = [this.simpleKey()];
    for (;;) {
      const at = this.i;
      this.spaces();
      if (this.s[this.i] !== ".") {
        this.i = at;
        return parts;
      }
      this.i++;
      this.spaces();
      parts.push(this.simpleKey());
    }
  }

  private simpleKey(): string {
    const c = this.s[this.i];
    if (c === '"') {
      if (this.s.startsWith('"""', this.i)) this.fail("a multi-line string as a key");
      return this.basicString();
    }
    if (c === "'") {
      if (this.s.startsWith("'''", this.i)) this.fail("a multi-line string as a key");
      return this.literalString();
    }
    const start = this.i;
    while (this.i < this.s.length && BARE.test(this.s[this.i])) this.i++;
    if (this.i === start) this.fail("a missing key");
    return this.s.slice(start, this.i);
  }

  // A control character other than tab may not stand in a string.
  private control(c: string): boolean {
    const code = c.charCodeAt(0);
    return (code < 0x20 && c !== "\t") || code === 0x7f;
  }

  // "...", decoded.
  private basicString(): string {
    const s = this.s;
    this.i++;
    let out = "";
    for (;;) {
      const c = s[this.i];
      if (c === undefined || c === "\n" || c === "\r") this.fail("a string that does not end on its line");
      if (c === '"') {
        this.i++;
        return out;
      }
      if (c === "\\") {
        out += this.escape();
        continue;
      }
      if (this.control(c)) this.fail("a control character in a string");
      out += c;
      this.i++;
    }
  }

  // The escape at the backslash under the cursor, decoded.
  private escape(): string {
    const s = this.s;
    const e = s[this.i + 1];
    if (e !== undefined && ESCAPES[e] !== undefined) {
      this.i += 2;
      return ESCAPES[e];
    }
    if (e === "u" || e === "U") {
      const n = e === "u" ? 4 : 8;
      const hex = s.slice(this.i + 2, this.i + 2 + n);
      const code = /^[0-9A-Fa-f]+$/.test(hex) && hex.length === n ? Number.parseInt(hex, 16) : -1;
      if (code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) this.fail("an escape that is not a Unicode scalar value");
      this.i += 2 + n;
      return String.fromCodePoint(code);
    }
    this.fail(`an unknown escape \\${e ?? ""}`);
  }

  // '...', as written.
  private literalString(): string {
    const s = this.s;
    const start = ++this.i;
    for (;;) {
      const c = s[this.i];
      if (c === undefined || c === "\n" || c === "\r") this.fail("a string that does not end on its line");
      if (c === "'") return s.slice(start, this.i++);
      if (this.control(c)) this.fail("a control character in a string");
      this.i++;
    }
  }

  // """...""" or '''...''': up to two more quotes may stand right before
  // the closing three; a basic one may escape a quote.
  private multiline(quote: '"' | "'"): void {
    const s = this.s;
    const three = quote.repeat(3);
    this.i += 3;
    for (;;) {
      if (this.i >= s.length) this.fail("a multi-line string that never ends");
      if (s.startsWith(three, this.i)) {
        let n = 3;
        while (s[this.i + n] === quote) n++;
        if (n > 5) this.fail("more than five quotes at the end of a multi-line string");
        this.i += n;
        return;
      }
      if (quote === '"' && s[this.i] === "\\") {
        this.i += 2;
        continue;
      }
      this.i++;
    }
  }

  // Steps over one value; `path` is where it is set, null inside an array,
  // whose inline tables define no key of the file.
  private value(path: string[] | null): KeyKind {
    const s = this.s;
    const c = s[this.i];
    if (c === '"') {
      if (s.startsWith('"""', this.i)) this.multiline('"');
      else this.basicString();
      return "value";
    }
    if (c === "'") {
      if (s.startsWith("'''", this.i)) this.multiline("'");
      else this.literalString();
      return "value";
    }
    if (c === "[") {
      this.i++;
      for (;;) {
        this.gaps();
        if (s[this.i] === "]") break;
        this.value(null);
        this.gaps();
        if (s[this.i] === ",") {
          this.i++;
          continue;
        }
        if (s[this.i] !== "]") this.fail("an array without , or ] after a value");
        break;
      }
      this.i++;
      return "array";
    }
    if (c === "{") {
      this.i++;
      this.gaps();
      if (s[this.i] === "}") {
        this.i++;
        return "inline-table";
      }
      for (;;) {
        this.gaps();
        const key = this.key();
        this.spaces();
        if (s[this.i] !== "=") this.fail("an inline table key without = and a value");
        this.i++;
        this.spaces();
        const at = path === null ? null : [...path, ...key];
        const kind = this.value(at);
        if (at !== null) this.keys.push({ path: at, kind });
        this.gaps();
        if (s[this.i] === ",") {
          this.i++;
          continue;
        }
        if (s[this.i] !== "}") this.fail("an inline table without , or } after a value");
        this.i++;
        return "inline-table";
      }
    }
    const start = this.i;
    while (this.i < s.length && !VALUE_END.test(s[this.i])) this.i++;
    let token = s.slice(start, this.i);
    // A date and a time may be set apart by one space instead of T.
    if (/^\d{4}-\d{2}-\d{2}$/.test(token) && s[this.i] === " " && /^\d{2}:\d{2}/.test(s.slice(this.i + 1, this.i + 6))) {
      const time = ++this.i;
      while (this.i < s.length && !VALUE_END.test(s[this.i])) this.i++;
      token = `${token}T${s.slice(time, this.i)}`;
    }
    if (!SCALAR.test(token)) this.fail(token === "" ? "a missing value" : `a value that is not TOML (${token.slice(0, 40)})`);
    return "value";
  }
}
