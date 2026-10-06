// Where the comments are in a source file, so a suppression marker counts
// only where its scanner reads it: `# nosec` in a Python comment silences
// bandit, the same text inside a string does not. One small tokenizer per
// comment family, never a parser: each skips the strings of its languages
// (one-line, multi-line and heredoc bodies) and returns every comment with
// its offset.
//
// Three rules keep a reader from hiding a marker it should see:
// - An opener left open at the end of the file (a string, a heredoc, a
//   template, a raw string, a block comment) is read as code, so whatever
//   follows it is still read. A false candidate costs a reviewer one drop;
//   a missed one hides a finding.
// - Each kind of closer is searched for to the end of the file at most once:
//   when it is not found from one point, no later opener of that kind is
//   searched for again (`Reader.open`). This keeps every reader linear.
// - Nesting deeper than MAX_DEPTH ($( ) in $( ), f-string fields, Ruby #{ })
//   is read as plain code instead of recursing.

export type Family = "python" | "shell" | "dockerfile" | "ruby" | "js" | "go";

// `start` is the offset of the comment's opener in the file; `text` runs from
// the opener to the end of the comment (the line end for a line comment,
// without a carriage return).
export type Comment = { start: number; text: string };

export function comments(text: string, family: Family): Comment[] {
  const r = new Reader(text);
  switch (family) {
    case "python":
      pythonComments(r);
      break;
    case "shell":
      shellCode(r, 0, null, 0);
      break;
    case "dockerfile":
      dockerfileComments(r);
      break;
    case "ruby":
      rubyComments(r);
      break;
    case "js":
    case "go":
      slashComments(r, family);
      break;
  }
  return r.out;
}

const MAX_DEPTH = 64;

// The longest heredoc end word looked up. A longer word is never found, so
// its heredoc is read as code.
const MAX_WORD = 1024;

class Reader {
  readonly out: Comment[] = [];
  // For each kind of closer, the earliest offset from which a search for it
  // reached the end of the file.
  private readonly unclosed = new Map<string, number>();
  // The offset of every line start, built once.
  private starts: number[] | null = null;
  // For each heredoc indent rule: each line's text with that indent removed
  // (lines up to MAX_WORD long) to the starts of the lines that read so.
  private readonly lines = new Map<Heredoc["indent"], Map<string, number[]>>();
  constructor(readonly s: string) {}

  private lineStarts(): number[] {
    if (this.starts === null) {
      this.starts = [0];
      for (let i = this.s.indexOf("\n"); i >= 0; i = this.s.indexOf("\n", i + 1)) this.starts.push(i + 1);
    }
    return this.starts;
  }

  // The index in `starts` of the first line start at or after `i`.
  private firstAtOrAfter(starts: number[], i: number): number {
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((starts[mid] as number) < i) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // The offset of the line end (the newline, or the end of the file) of the
  // line holding `i`, by lookup.
  eol(i: number): number {
    const starts = this.lineStarts();
    const next = this.firstAtOrAfter(starts, i + 1);
    return next < starts.length ? (starts[next] as number) - 1 : this.s.length;
  }

  // The offset past the first line at or after `from` that reads `word` once
  // `indent` is removed, or -1 with none. The lines are indexed once per
  // indent rule, so each heredoc costs one lookup.
  closer(indent: Heredoc["indent"], word: string, from: number): number {
    if (word.length > MAX_WORD) return -1;
    let index = this.lines.get(indent);
    if (index === undefined) {
      index = new Map();
      const starts = this.lineStarts();
      for (const start of starts) {
        const end = this.s.indexOf("\n", start);
        let line = this.s.slice(start, end < 0 ? this.s.length : end);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        const key = line.replace(INDENT[indent], "");
        if (key.length > MAX_WORD) continue;
        const at = index.get(key);
        if (at) at.push(start);
        else index.set(key, [start]);
      }
      this.lines.set(indent, index);
    }
    const at = index.get(word);
    if (at === undefined) return -1;
    const k = this.firstAtOrAfter(at, from);
    if (k >= at.length) return -1;
    return this.eol(at[k] as number) + 1;
  }

  // Runs `find` (a search for a closer from `from`, returning the offset past
  // it or -1 at the end of the file) unless a search of the same `kind`
  // already failed from an earlier offset. -1 means the opener is left open:
  // the caller reads it as code. A memo that is wrong only ever makes an
  // opener read as code, which can add a candidate, never hide one.
  open(kind: string, from: number, find: () => number): number {
    const failed = this.unclosed.get(kind);
    if (failed !== undefined && from >= failed) return -1;
    const end = find();
    if (end < 0 && (failed === undefined || from < failed)) this.unclosed.set(kind, from);
    return end;
  }

  // A line comment from the first `opener` in [from, to), when there is one:
  // for text the reader skipped but may have read wrongly.
  commentIn(from: number, to: number, opener: string): void {
    const at = this.s.slice(from, to + opener.length - 1).indexOf(opener);
    if (at >= 0) this.lineComment(from + at);
  }

  lineComment(i: number): number {
    const end = lineEnd(this.s, i);
    const text = this.s.slice(i, end);
    this.out.push({ start: i, text: text.endsWith("\r") ? text.slice(0, -1) : text });
    return end;
  }
}

function lineEnd(s: string, i: number): number {
  const n = s.indexOf("\n", i);
  return n < 0 ? s.length : n;
}

// The offset just past the closing `close` of a string whose body starts at
// `i`. `escapes`: a backslash hides the next character. A one-line string
// (not `multiline`) ends at the line end, as the languages' lexers end it. A
// multi-line one with no closer returns -1.
function skipString(s: string, i: number, close: string, escapes: boolean, multiline: boolean): number {
  while (i < s.length) {
    const c = s[i];
    if (escapes && c === "\\") {
      i += 2;
      continue;
    }
    if (!multiline && c === "\n") return i;
    if (s.startsWith(close, i)) return i + close.length;
    i++;
  }
  return multiline ? -1 : s.length;
}

// Python: `#` comments; '...' and "..." strings, and their triple-quoted
// forms, which span lines. A prefix (r, b, u) is just letters before them.
// An f-string (or t-string) holds code in its `{...}` fields, and from
// Python 3.12 a field may span lines and hold a comment, which ruff and a
// bandit on 3.12 read.
function pythonComments(r: Reader): void {
  const s = r.s;
  let i = 0;
  while (i < s.length) {
    const c = s[i] as string;
    if (c === "#") {
      i = r.lineComment(i);
    } else if (c === '"' || c === "'") {
      const close = s.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      const prefix = /(?:^|[^\w])([A-Za-z]{1,2})$/.exec(s.slice(Math.max(0, i - 3), i))?.[1] ?? "";
      const body = i + close.length;
      const fstring = /^[rRbBuU]?[fFtT][rR]?$/.test(prefix);
      const end = r.open(`${fstring ? "f" : ""}${close}`, i, () => (fstring ? skipFString(r, body, close, 0) : skipString(s, body, close, true, close.length === 3)));
      i = end < 0 ? i + 1 : end;
    } else if (c === "\\") {
      i += 2;
    } else {
      i++;
    }
  }
}

// The offset past an f-string whose body starts at `i`, or -1 when a
// triple-quoted one, or any field, has no closer before the end of the
// file. Comments in its fields go to the reader.
function skipFString(r: Reader, i: number, close: string, depth: number): number {
  const s = r.s;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      i += 2;
    } else if (close.length === 1 && c === "\n") {
      return i;
    } else if (s.startsWith(close, i)) {
      return i + close.length;
    } else if (c === "{" && s[i + 1] === "{") {
      i += 2;
    } else if (c === "{" && depth < MAX_DEPTH) {
      i = skipField(r, i + 1, depth + 1);
      if (i < 0) return -1;
    } else {
      i++;
    }
  }
  return close.length === 1 ? s.length : -1;
}

// The offset past an f-string field whose code starts at `i`: the
// expression, where `#` opens a comment, then the conversion and format
// spec after a top-level `!` or `:`, where `#` is text (`{n:#x}`). -1 when
// the field has no `}` before the end of the file, so the caller reads the
// f-string as code and a format spec never swallows the rest of the file.
function skipField(r: Reader, i: number, depth: number): number {
  const s = r.s;
  let nesting = 0;
  let spec = false;
  while (i < s.length) {
    const c = s[i] as string;
    if (c === "}" && nesting === 0) return i + 1;
    if (spec) {
      i = c === "{" && depth < MAX_DEPTH ? skipField(r, i + 1, depth + 1) : i + 1;
      if (i < 0) return -1;
    } else if (c === "#") {
      i = r.lineComment(i);
    } else if (c === '"' || c === "'") {
      const close = s.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      const end = r.open(close, i, () => skipString(s, i + close.length, close, true, close.length === 3));
      i = end < 0 ? i + 1 : end;
    } else {
      if ("([{".includes(c)) nesting++;
      else if (")]}".includes(c)) nesting--;
      else if (nesting === 0 && (c === ":" || (c === "!" && s[i + 1] !== "="))) spec = true;
      i++;
    }
  }
  return -1;
}

// `indent`: what may come before the closing word on its line (shell and
// Dockerfile `<<-`: tabs; Ruby `<<~` and `<<-`: any blanks). `expands`: a
// shell heredoc whose word is not quoted runs the $( ) and backticks in its
// body.
type Heredoc = { word: string; indent: "none" | "tabs" | "blanks"; expands: boolean };

const INDENT = { none: /^/, tabs: /^\t*/, blanks: /^[\t ]*/ } as const;

// The offset after the bodies of the heredocs opened on the line that ended
// just before `i`, read in order: each runs to a line that is exactly its
// word. -1 when one has no such line: the caller reads the bodies as code.
// `body` reads one body line of an expanding heredoc.
function skipHeredocs(r: Reader, i: number, pending: Heredoc[], body?: (from: number, to: number) => void): number {
  for (const h of pending) {
    const end = r.closer(h.indent, h.word, i);
    if (end < 0) return -1;
    if (h.expands && body) body(i, end);
    i = end;
  }
  return Math.min(i, r.s.length);
}

// The end word of a shell heredoc at `j`, after `<<` or `<<-` and its
// blanks, read as the shell reads a word: up to an unquoted blank or
// operator, with quotes and backslashes removed, never past the line end
// `eol`. A quoted word turns off expansion in the body. Null for an empty
// word, an unclosed quote or a word longer than MAX_WORD.
function shellWord(s: string, j: number, eol: number): { word: string; quoted: boolean; next: number } | null {
  const parts: string[] = [];
  let size = 0;
  let quoted = false;
  while (j < eol && !/[\s;&|()<>]/.test(s[j] as string)) {
    const c = s[j] as string;
    let part: string;
    if (c === "\\") {
      quoted = true;
      part = s[j + 1] ?? "";
      j += 2;
    } else if (c === "'" || c === '"') {
      const rest = s.slice(j + 1, eol);
      const close = rest.indexOf(c);
      if (close < 0) return null;
      quoted = true;
      part = rest.slice(0, close);
      j += close + 2;
    } else {
      part = c;
      j++;
    }
    size += part.length;
    if (size > MAX_WORD) return null;
    parts.push(part);
  }
  return size === 0 ? null : { word: parts.join(""), quoted, next: j };
}

// The heredoc a `<<` at `i` opens in shell, or null for `<<<` or no word.
function shellHeredoc(r: Reader, i: number): { heredoc: Heredoc; next: number } | null {
  const s = r.s;
  if (!s.startsWith("<<", i) || s[i + 2] === "<") return null;
  let j = i + 2;
  const dash = s[j] === "-";
  if (dash) j++;
  while (s[j] === " " || s[j] === "\t") j++;
  // A word that starts with a digit is far more often a shift in $(( ))
  // than a heredoc; reading it as code can only add a candidate.
  if (!/[A-Za-z_'"\\]/.test(s[j] ?? "")) return null;
  const w = shellWord(s, j, r.eol(j));
  if (!w) return null;
  return { heredoc: { word: w.word, indent: dash ? "tabs" : "none", expands: !w.quoted }, next: w.next };
}

// Shell code from `i`: a `#` that starts a word (at a line start, after a
// blank or an operator) opens a comment; `$#`, `${#x}` and `a#b` do not.
// Single quotes have no escapes; double quotes and $'...' do; all three span
// lines. Code inside $( ) and backticks is code again, also inside double
// quotes and in the body of a heredoc whose word is not quoted; shellcheck
// reads its comments. The rest of a heredoc body is data. With `close`, the
// code of a $( ) or of backticks: returns the offset past its closing `)` or
// backtick, or the end of the file.
function shellCode(r: Reader, i: number, close: ")" | "`" | null, depth: number): number {
  const s = r.s;
  let pending: Heredoc[] = [];
  let nesting = 0;
  while (i < s.length) {
    const c = s[i] as string;
    if (c === close && nesting === 0) return i + 1;
    if (c === "\n") {
      i++;
      if (pending.length > 0) {
        const end = skipHeredocs(r, i, pending, (from, to) => shellExpansions(r, from, to, depth));
        if (end >= 0) i = end;
        pending = [];
      }
    } else if (c === "#" && (i === 0 || /[\s;&|()<>`]/.test(s[i - 1] as string))) {
      i = r.lineComment(i);
    } else if (c === "\\") {
      i += 2;
    } else if (c === "'") {
      const end = r.open("'", i, () => skipString(s, i + 1, "'", false, true));
      i = end < 0 ? i + 1 : end;
    } else if (c === "$" && s[i + 1] === "'") {
      const end = r.open("$'", i, () => skipString(s, i + 2, "'", true, true));
      i = end < 0 ? i + 2 : end;
    } else if (c === "$" && s[i + 1] === "(" && depth < MAX_DEPTH) {
      i = shellCode(r, i + 2, ")", depth + 1);
    } else if (c === "`" && close !== "`" && depth < MAX_DEPTH) {
      i = shellCode(r, i + 1, "`", depth + 1);
    } else if (c === '"') {
      const end = r.open('"', i, () => shellDouble(r, i + 1, depth));
      i = end < 0 ? i + 1 : end;
    } else if (c === "<" && s[i + 1] === "<") {
      const h = shellHeredoc(r, i);
      if (h) pending.push(h.heredoc);
      i = h ? h.next : i + 2;
    } else {
      if (close === ")" && c === "(") nesting++;
      if (close === ")" && c === ")") nesting--;
      i++;
    }
  }
  return i;
}

// The offset past a double-quoted shell string whose body starts at `i`, or
// -1 with no closing quote. When a $( ) or backticks inside it run to the
// end of the file, that code has already read the rest of the file, so the
// string ends there instead of being read again.
function shellDouble(r: Reader, i: number, depth: number): number {
  const s = r.s;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      i += 2;
    } else if (c === '"') {
      return i + 1;
    } else if ((c === "$" && s[i + 1] === "(") || c === "`") {
      if (depth >= MAX_DEPTH) {
        i++;
        continue;
      }
      i = c === "`" ? shellCode(r, i + 1, "`", depth + 1) : shellCode(r, i + 2, ")", depth + 1);
      if (i >= s.length) return s.length;
    } else {
      i++;
    }
  }
  return -1;
}

// Reads the $( ) and backticks in the body of an expanding heredoc, from
// `from` to `to`; the rest of the body is data.
function shellExpansions(r: Reader, from: number, to: number, depth: number): void {
  const s = r.s;
  let j = from;
  while (j < to) {
    if (s[j] === "\\") j += 2;
    else if (s[j] === "$" && s[j + 1] === "(" && depth < MAX_DEPTH) j = shellCode(r, j + 2, ")", depth + 1);
    else if (s[j] === "`" && depth < MAX_DEPTH) j = shellCode(r, j + 1, "`", depth + 1);
    else j++;
  }
}

// The Dockerfile instructions that take a heredoc (BuildKit).
const HEREDOC_INSTRUCTIONS = new Set(["RUN", "COPY", "ADD"]);

// Dockerfile: a comment is a line whose first character that is not a blank
// is `#`; a `#` later in an instruction belongs to the instruction. A heredoc
// opens only in RUN, COPY and ADD, in a word that starts with `<<` (after an
// optional file number), as BuildKit reads it; its body starts after the
// instruction's last continued line and is data.
function dockerfileComments(r: Reader): void {
  const s = r.s;
  let keyword = "";
  let continued = false;
  let pending: Heredoc[] = [];
  let i = 0;
  while (i < s.length) {
    const start = i;
    const end = lineEnd(s, i);
    const line = s.slice(i, end).replace(/\r$/, "");
    const indent = line.length - line.trimStart().length;
    i = end + 1;
    if (line[indent] === "#") {
      r.lineComment(start + indent);
      continue;
    }
    if (line.trim() === "") continue;
    if (!continued) keyword = (/^\s*([A-Za-z]+)/.exec(line)?.[1] ?? "").toUpperCase();
    continued = /\\\s*$/.test(line);
    if (HEREDOC_INSTRUCTIONS.has(keyword) && !/^\s*[A-Za-z]+\s+\[/.test(line)) {
      for (const m of line.matchAll(/(?:^|\s)\d*<<(-?)(\S+)/g)) {
        if ((m[2] as string).startsWith("<")) continue;
        const word = (m[2] as string).replace(/["'\\]/g, "");
        if (word !== "") pending.push({ word, indent: m[1] === "-" ? "tabs" : "none", expands: false });
      }
    }
    if (!continued && pending.length > 0) {
      const after = skipHeredocs(r, i, pending);
      if (after >= 0) i = after;
      pending = [];
    }
  }
}

// Words after which a `/` starts a regular expression.
const JS_REGEX_WORDS = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
const RUBY_REGEX_WORDS = new Set(["return", "if", "elsif", "unless", "when", "while", "until", "and", "or", "not", "then", "do", "else"]);

// A `/` starts a regular expression, not a division, after an operator, an
// opening bracket, one of `words` such as `return`, or at the start of the file.
function regexMayStart(prev: string, word: string, words: ReadonlySet<string>): boolean {
  if (word !== "") return words.has(word);
  return prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev);
}

// The offset past a regular expression literal whose body starts at `i`, on
// one line; a `/` inside a character class does not end it.
function skipRegex(s: string, i: number): number {
  let inClass = false;
  while (i < s.length && s[i] !== "\n") {
    const c = s[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return i + 1;
    i++;
  }
  return i;
}

// After a template literal's text from `i`: the offset past the closing
// backtick (`opened` false) or past a `${` (`opened` true), or -1 with
// neither before the end of the file.
function skipTemplate(s: string, i: number): { next: number; opened: boolean } {
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") return { next: i + 1, opened: false };
    if (c === "$" && s[i + 1] === "{") return { next: i + 2, opened: true };
    i++;
  }
  return { next: -1, opened: false };
}

// Words whose `( ... )` ends a statement head, so a `/` after it starts a
// regular expression: `if (a) /x/.test(b)`.
const JS_HEAD_WORDS = new Set(["if", "while", "for", "with"]);

// JavaScript, TypeScript and Go: `//` and `/* */` comments. Both have
// one-line '...' and "..." strings (a rune in Go). A backtick opens a raw
// string in Go and a template literal in JavaScript, whose `${...}` holds
// code again (with its own strings and comments). JavaScript also has
// regular expression literals.
function slashComments(r: Reader, dialect: "js" | "go"): void {
  const s = r.s;
  // The brace depth inside each open `${...}` of a template literal.
  const templates: number[] = [];
  // For each open `(`: whether it follows if, while, for or with.
  const parens: boolean[] = [];
  let prev = "";
  let word = "";
  // A `#!` line at the very start is not code.
  let i = s.startsWith("#!") ? lineEnd(s, 0) : 0;
  // Reads a template's text from `from`; with no end, the backtick or `}`
  // before `from` is read as code.
  const template = (from: number) => {
    let opened = false;
    const end = r.open("`", from, () => {
      const t = skipTemplate(s, from);
      opened = t.opened;
      return t.next;
    });
    if (end >= 0 && opened) templates.push(0);
    i = end < 0 ? from : end;
    prev = end >= 0 && opened ? "{" : "a";
    word = "";
  };
  while (i < s.length) {
    const c = s[i] as string;
    if (/\s/.test(c)) {
      i++;
    } else if (s.startsWith("//", i)) {
      i = r.lineComment(i);
    } else if (s.startsWith("/*", i)) {
      const end = r.open("*/", i, () => {
        const close = s.indexOf("*/", i + 2);
        return close < 0 ? -1 : close + 2;
      });
      if (end < 0) {
        i += 2;
      } else {
        r.out.push({ start: i, text: s.slice(i, end) });
        i = end;
      }
    } else if (c === '"' || c === "'") {
      i = skipString(s, i + 1, c, true, false);
      prev = "a";
      word = "";
    } else if (c === "`") {
      if (dialect === "go") {
        const end = r.open("`", i, () => skipString(s, i + 1, "`", false, true));
        i = end < 0 ? i + 1 : end;
        prev = "a";
        word = "";
      } else {
        template(i + 1);
      }
    } else if (c === "/" && dialect === "js" && regexMayStart(prev, word, JS_REGEX_WORDS)) {
      const end = skipRegex(s, i + 1);
      // After a `}` the slash may be a division (`} / 2`), so a `//` in the
      // skipped text is also read as a comment.
      if (prev === "}") r.commentIn(i + 1, end, "//");
      i = end;
      prev = "a";
      word = "";
    } else if (/[\w$]/.test(c)) {
      const m = /^[\w$]+/.exec(s.slice(i, i + 256)) as RegExpExecArray;
      word = /^\d/.test(m[0]) ? "" : m[0];
      prev = "a";
      i += m[0].length;
    } else if (c === "}" && templates.length > 0 && templates[templates.length - 1] === 0) {
      templates.pop();
      template(i + 1);
    } else if ((c === "+" || c === "-") && s[i + 1] === c) {
      // A postfix ++ or -- ends an operand (`a++ / b`); a prefix one does not.
      prev = prev === "a" || prev === ")" || prev === "]" ? "a" : c;
      word = "";
      i += 2;
    } else {
      const top = templates.length - 1;
      if (top >= 0 && (c === "{" || c === "}")) templates[top] = (templates[top] ?? 0) + (c === "{" ? 1 : -1);
      if (c === "(") parens.push(JS_HEAD_WORDS.has(word));
      // The `)` closing an if, while, for or with head is followed by a statement.
      prev = c === ")" && parens.pop() === true ? "(" : c;
      word = "";
      i++;
    }
  }
}

const PAIRS: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">" };

// The offset past a %-literal (%q(...), %w[...], %r{...}) whose delimiter is
// at `i`, counting nested brackets of the same kind; -1 with no closer.
function skipPercent(s: string, i: number): number {
  const open = s[i] as string;
  const close = PAIRS[open] ?? open;
  let nesting = 0;
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") {
      j++;
    } else if (c === close && open !== close && nesting > 0) {
      nesting--;
    } else if (c === close) {
      return j + 1;
    } else if (c === open && open !== close) {
      nesting++;
    }
  }
  return -1;
}

// The offset past a Ruby double-quoted or backtick string whose body starts
// at `i`, or -1 with no closer. Its `#{...}` holds code, which may hold its
// own strings.
function skipRubyString(r: Reader, i: number, close: string, depth: number): number {
  const s = r.s;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      i += 2;
    } else if (c === close) {
      return i + 1;
    } else if (c === "#" && s[i + 1] === "{") {
      let nesting = 1;
      i += 2;
      while (i < s.length && nesting > 0) {
        const d = s[i] as string;
        if ((d === '"' || d === "`") && depth < MAX_DEPTH) {
          const end = skipRubyString(r, i + 1, d, depth + 1);
          i = end < 0 ? s.length : end;
        } else if (d === "'") {
          const end = skipString(s, i + 1, "'", true, true);
          i = end < 0 ? s.length : end;
        } else {
          if (d === "{") nesting++;
          else if (d === "}") nesting--;
          i++;
        }
      }
    } else {
      i++;
    }
  }
  return -1;
}

const RUBY_HEREDOC = /^<<([~-]?)(?:(["'`])([^"'`\n]+)\2|([A-Za-z_]\w*))/;

// The offset past the `=end` line of an =begin block whose line starts at
// `i`, or -1 with none.
function skipEmbedded(s: string, i: number): number {
  for (let j = s.indexOf("\n=end", i); j >= 0; j = s.indexOf("\n=end", j + 1)) {
    const next = s[j + 5];
    if (next === undefined || /\s/.test(next)) return lineEnd(s, j + 1);
  }
  return -1;
}

// Ruby: `#` comments and =begin/=end blocks. Strings: '...', "..." and
// backticks (with #{...}), %-literals, heredocs (<<~ID, <<-ID, <<ID with an
// upper-case or quoted ID; their bodies are data), ?x character literals and
// regular expression literals where an operand may start.
function rubyComments(r: Reader): void {
  const s = r.s;
  let pending: Heredoc[] = [];
  let prev = "";
  let word = "";
  let i = 0;
  const literal = (end: number, opener: number) => {
    i = end < 0 ? opener : end;
    prev = "a";
    word = "";
  };
  while (i < s.length) {
    const c = s[i] as string;
    const lineStart = i === 0 || s[i - 1] === "\n";
    if (c === "\n") {
      i++;
      if (pending.length > 0) {
        const end = skipHeredocs(r, i, pending);
        if (end >= 0) i = end;
        pending = [];
      }
    } else if (lineStart && /^=begin(\s|$)/.test(s.slice(i, i + 7))) {
      const end = r.open("=end", i, () => skipEmbedded(s, i));
      if (end < 0) {
        i = r.lineComment(i);
      } else {
        r.out.push({ start: i, text: s.slice(i, end) });
        i = end;
      }
    } else if (/\s/.test(c)) {
      i++;
    } else if (c === "#") {
      i = r.lineComment(i);
    } else if (c === "\\") {
      i += 2;
    } else if (c === "'") {
      literal(r.open("'", i, () => skipString(s, i + 1, "'", true, true)), i + 1);
    } else if (c === '"' || c === "`") {
      literal(r.open(c, i, () => skipRubyString(r, i + 1, c, 0)), i + 1);
    } else if (c === "$" && /["'`]/.test(s[i + 1] ?? "")) {
      literal(i + 2, i + 2);
    } else if (c === "?" && prev !== "a" && /\S/.test(s[i + 1] ?? " ") && !/\w/.test(s[i + 2] ?? "")) {
      literal(i + 2, i + 2);
    } else if (c === "%" && /^%[qQwWiIrsx]?[^\w\s]/.test(s.slice(i, i + 3)) && (prev !== "a" || /[qQwWiIrsx]/.test(s[i + 1] as string))) {
      const at = /[qQwWiIrsx]/.test(s[i + 1] as string) ? i + 2 : i + 1;
      literal(r.open(`%${s[at]}`, i, () => skipPercent(s, at)), i + 1);
    } else if (c === "<" && RUBY_HEREDOC.test(s.slice(i, i + 200))) {
      const m = RUBY_HEREDOC.exec(s.slice(i, i + 200)) as RegExpExecArray;
      const flag = m[1] as string;
      const id = (m[3] ?? m[4]) as string;
      if (flag === "" && m[2] === undefined && !/^[A-Z]/.test(id)) {
        prev = "<";
        i += 2;
      } else {
        pending.push({ word: id, indent: flag === "" ? "none" : "blanks", expands: false });
        i += m[0].length;
        prev = "a";
      }
      word = "";
    } else if (c === "/" && regexMayStart(prev, word, RUBY_REGEX_WORDS)) {
      literal(skipRegex(s, i + 1), i + 1);
    } else if (c === "/" && word !== "" && /\s/.test(s[i - 1] ?? "") && !/[\s=]/.test(s[i + 1] ?? " ")) {
      // A method name, a blank, then `/` and no blank (`split /,/`) starts a
      // regular expression argument, as Ruby reads it. When the name is a
      // local variable it is a division (`total /2`), so a `#` in the
      // skipped text is also read as a comment.
      const end = skipRegex(s, i + 1);
      r.commentIn(i + 1, end, "#");
      literal(end, i + 1);
    } else if (/\w/.test(c)) {
      const m = /^\w+[?!]?/.exec(s.slice(i, i + 256)) as RegExpExecArray;
      word = /^\d/.test(m[0]) ? "" : m[0];
      prev = "a";
      i += m[0].length;
    } else {
      prev = c;
      word = "";
      i++;
    }
  }
}
