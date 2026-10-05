// Where the comments are in a source file, so a suppression marker counts
// only where its scanner reads it: `# nosec` in a Python comment silences
// bandit, the same text inside a string does not. One small tokenizer per
// comment family, never a parser: each skips the strings of its languages
// (one-line, multi-line and heredoc bodies) and returns every comment with
// its offset. Known limits: JSX text, Ruby and JavaScript regular
// expressions in unusual places, and a shell `<<` inside arithmetic can
// be read wrongly; each errs on a rare line, never on a whole file.

export type Family = "python" | "shell" | "dockerfile" | "ruby" | "js" | "go";

// `start` is the offset of the comment's opener in the file; `text` runs from
// the opener to the end of the comment (the line end for a line comment,
// without a carriage return).
export type Comment = { start: number; text: string };

export function comments(text: string, family: Family): Comment[] {
  switch (family) {
    case "python":
      return pythonComments(text);
    case "shell":
      return shellComments(text);
    case "dockerfile":
      return dockerfileComments(text);
    case "ruby":
      return rubyComments(text);
    case "js":
    case "go":
      return slashComments(text, family);
  }
}

function lineEnd(s: string, i: number): number {
  const n = s.indexOf("\n", i);
  return n < 0 ? s.length : n;
}

function lineComment(s: string, i: number): Comment {
  const end = lineEnd(s, i);
  const text = s.slice(i, end);
  return { start: i, text: text.endsWith("\r") ? text.slice(0, -1) : text };
}

// The offset just past the closing `close` of a string whose body starts at
// `i`. `escapes`: a backslash hides the next character. Without `multiline`
// an unclosed string ends at the line end, as the languages' lexers end it.
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
  return s.length;
}

// Python: `#` comments; '...' and "..." strings, and their triple-quoted
// forms, which span lines. A prefix (r, b, f, u) is just letters before them.
function pythonComments(s: string): Comment[] {
  const out: Comment[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "#") {
      const comment = lineComment(s, i);
      out.push(comment);
      i += comment.text.length;
    } else if (c === '"' || c === "'") {
      const triple = c.repeat(3);
      i = s.startsWith(triple, i) ? skipString(s, i + 3, triple, true, true) : skipString(s, i + 1, c, true, false);
    } else if (c === "\\") {
      i += 2;
    } else {
      i++;
    }
  }
  return out;
}

const HEREDOC_WORD = /^(["']?)([A-Za-z_][\w-]*)\1/;

// `indent`: what may come before the closing word on its line (shell and
// Dockerfile `<<-`: tabs; Ruby `<<~` and `<<-`: any blanks).
type Heredoc = { word: string; indent: "none" | "tabs" | "blanks" };

const INDENT = { none: /^/, tabs: /^\t*/, blanks: /^[\t ]*/ } as const;

// The offset after the bodies of the heredocs opened on the line that just
// ended, read in order: each runs to a line that is exactly its word.
function skipHeredocs(s: string, i: number, pending: Heredoc[]): number {
  for (const h of pending) {
    while (i < s.length) {
      const end = lineEnd(s, i);
      let line = s.slice(i, end);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      i = end + 1;
      if (line.replace(INDENT[h.indent], "") === h.word) break;
    }
  }
  return Math.min(i, s.length);
}

// The heredoc a `<<` at `i` opens in shell or a Dockerfile, or null for
// `<<<` or no word.
function heredocAt(s: string, i: number): { heredoc: Heredoc; next: number } | null {
  if (!s.startsWith("<<", i) || s[i + 2] === "<") return null;
  let j = i + 2;
  const dash = s[j] === "-";
  if (dash) j++;
  while (s[j] === " " || s[j] === "\t") j++;
  if (s[j] === "\\") j++;
  const m = HEREDOC_WORD.exec(s.slice(j, j + 200));
  if (!m) return null;
  return { heredoc: { word: m[2] as string, indent: dash ? "tabs" : "none" }, next: j + m[0].length };
}

// Shell: a `#` that starts a word (at a line start, after a blank or an
// operator) opens a comment; `$#`, `${#x}` and `a#b` do not. Single quotes
// have no escapes; double quotes and $'...' do; all three span lines.
// Heredoc bodies are data.
function shellComments(s: string): Comment[] {
  const out: Comment[] = [];
  let pending: Heredoc[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\n") {
      i++;
      if (pending.length > 0) {
        i = skipHeredocs(s, i, pending);
        pending = [];
      }
    } else if (c === "#" && (i === 0 || /[\s;&|()<>]/.test(s[i - 1] as string))) {
      const comment = lineComment(s, i);
      out.push(comment);
      i += comment.text.length;
    } else if (c === "\\") {
      i += 2;
    } else if (c === "'") {
      i = skipString(s, i + 1, "'", false, true);
    } else if (c === "$" && s[i + 1] === "'") {
      i = skipString(s, i + 2, "'", true, true);
    } else if (c === '"') {
      i = skipString(s, i + 1, '"', true, true);
    } else if (c === "<") {
      const h = heredocAt(s, i);
      if (h) {
        pending.push(h.heredoc);
        i = h.next;
      } else {
        i++;
      }
    } else {
      i++;
    }
  }
  return out;
}

// Dockerfile: a comment is a line whose first character that is not a blank
// is `#`; a `#` later in an instruction belongs to the instruction. Heredoc
// bodies (RUN <<EOF) are data.
function dockerfileComments(s: string): Comment[] {
  const out: Comment[] = [];
  let pending: Heredoc[] = [];
  let i = 0;
  while (i < s.length) {
    if (pending.length > 0) {
      i = skipHeredocs(s, i, pending);
      pending = [];
      continue;
    }
    const end = lineEnd(s, i);
    const line = s.slice(i, end);
    const indent = line.length - line.trimStart().length;
    if (line[indent] === "#") {
      out.push(lineComment(s, i + indent));
    } else {
      for (let j = line.indexOf("<<"); j >= 0; j = line.indexOf("<<", j + 2)) {
        const h = heredocAt(line, j);
        if (h) pending.push(h.heredoc);
      }
    }
    i = end + 1;
  }
  return out;
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

// The offset after a template literal's text, from `i`: past the closing
// backtick (`opened` false) or past a `${` (`opened` true).
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
  return { next: s.length, opened: false };
}

// JavaScript, TypeScript and Go: `//` and `/* */` comments. Both have
// one-line '...' and "..." strings (a rune in Go). A backtick opens a raw
// string in Go and a template literal in JavaScript, whose `${...}` holds
// code again (with its own strings and comments). JavaScript also has
// regular expression literals.
function slashComments(s: string, dialect: "js" | "go"): Comment[] {
  const out: Comment[] = [];
  // The brace depth inside each open `${...}` of a template literal.
  const templates: number[] = [];
  let prev = "";
  let word = "";
  let i = 0;
  const openTemplate = (from: number) => {
    const t = skipTemplate(s, from);
    if (t.opened) templates.push(0);
    i = t.next;
    prev = t.opened ? "{" : "a";
    word = "";
  };
  while (i < s.length) {
    const c = s[i] as string;
    if (/\s/.test(c)) {
      i++;
    } else if (s.startsWith("//", i)) {
      const comment = lineComment(s, i);
      out.push(comment);
      i += comment.text.length;
    } else if (s.startsWith("/*", i)) {
      const close = s.indexOf("*/", i + 2);
      const end = close < 0 ? s.length : close + 2;
      out.push({ start: i, text: s.slice(i, end) });
      i = end;
    } else if (c === '"' || c === "'") {
      i = skipString(s, i + 1, c, true, false);
      prev = "a";
      word = "";
    } else if (c === "`") {
      if (dialect === "go") {
        i = skipString(s, i + 1, "`", false, true);
        prev = "a";
        word = "";
      } else {
        openTemplate(i + 1);
      }
    } else if (c === "/" && dialect === "js" && regexMayStart(prev, word, JS_REGEX_WORDS)) {
      i = skipRegex(s, i + 1);
      prev = "a";
      word = "";
    } else if (/[\w$]/.test(c)) {
      const m = /^[\w$]+/.exec(s.slice(i, i + 256)) as RegExpExecArray;
      word = /^\d/.test(m[0]) ? "" : m[0];
      prev = "a";
      i += m[0].length;
    } else if (c === "}" && templates.length > 0 && templates[templates.length - 1] === 0) {
      templates.pop();
      openTemplate(i + 1);
    } else {
      const top = templates.length - 1;
      if (top >= 0 && (c === "{" || c === "}")) templates[top] = (templates[top] ?? 0) + (c === "{" ? 1 : -1);
      prev = c;
      word = "";
      i++;
    }
  }
  return out;
}

const PAIRS: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">" };

// The offset past a %-literal (%q(...), %w[...], %r{...}) whose delimiter is
// at `i`, counting nested brackets of the same kind.
function skipPercent(s: string, i: number): number {
  const open = s[i] as string;
  const close = PAIRS[open] ?? open;
  let depth = 0;
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") {
      j++;
    } else if (c === close && open !== close && depth > 0) {
      depth--;
    } else if (c === close) {
      return j + 1;
    } else if (c === open && open !== close) {
      depth++;
    }
  }
  return s.length;
}

// The offset past a Ruby double-quoted or backtick string whose body starts
// at `i`. Its `#{...}` holds code, which may hold its own strings.
function skipRubyString(s: string, i: number, close: string): number {
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      i += 2;
    } else if (c === close) {
      return i + 1;
    } else if (c === "#" && s[i + 1] === "{") {
      let depth = 1;
      i += 2;
      while (i < s.length && depth > 0) {
        const d = s[i];
        if (d === '"' || d === "'" || d === "`") i = d === "'" ? skipString(s, i + 1, "'", true, true) : skipRubyString(s, i + 1, d);
        else {
          if (d === "{") depth++;
          else if (d === "}") depth--;
          i++;
        }
      }
    } else {
      i++;
    }
  }
  return s.length;
}

const RUBY_HEREDOC = /^<<([~-]?)(["'`]?)([A-Za-z_]\w*)\2/;

// Ruby: `#` comments and =begin/=end blocks. Strings: '...', "..." and
// backticks (with #{...}), %-literals, heredocs (<<~ID, <<-ID, <<ID with an
// upper-case or quoted ID; their bodies are data), ?x character literals and
// regular expression literals where an operand may start.
function rubyComments(s: string): Comment[] {
  const out: Comment[] = [];
  let pending: Heredoc[] = [];
  let prev = "";
  let word = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i] as string;
    const lineStart = i === 0 || s[i - 1] === "\n";
    if (c === "\n") {
      i++;
      if (pending.length > 0) {
        i = skipHeredocs(s, i, pending);
        pending = [];
      }
    } else if (lineStart && /^=begin(\s|$)/.test(s.slice(i, i + 7))) {
      const m = /^=end(?:\s|$)/m.exec(s.slice(i));
      const end = m ? i + m.index + lineEnd(s.slice(i + m.index), 0) : s.length;
      out.push({ start: i, text: s.slice(i, end) });
      i = end;
    } else if (/\s/.test(c)) {
      i++;
    } else if (c === "#") {
      const comment = lineComment(s, i);
      out.push(comment);
      i += comment.text.length;
    } else if (c === "\\") {
      i += 2;
    } else if (c === "'") {
      i = skipString(s, i + 1, "'", true, true);
      prev = "a";
      word = "";
    } else if (c === '"' || c === "`") {
      i = skipRubyString(s, i + 1, c);
      prev = "a";
      word = "";
    } else if (c === "$" && /["'`]/.test(s[i + 1] ?? "")) {
      i += 2;
      prev = "a";
      word = "";
    } else if (c === "?" && prev !== "a" && /\S/.test(s[i + 1] ?? " ") && !/\w/.test(s[i + 2] ?? "")) {
      i += 2;
      prev = "a";
      word = "";
    } else if (c === "%" && /^%[qQwWiIrsx]?[^\w\s]/.test(s.slice(i, i + 3)) && (prev !== "a" || /[qQwWiIrsx]/.test(s[i + 1] as string))) {
      const at = /[qQwWiIrsx]/.test(s[i + 1] as string) ? i + 2 : i + 1;
      i = skipPercent(s, at);
      prev = "a";
      word = "";
    } else if (c === "<" && RUBY_HEREDOC.test(s.slice(i, i + 200))) {
      const m = RUBY_HEREDOC.exec(s.slice(i, i + 200)) as RegExpExecArray;
      const [, flag, quote, id] = m as unknown as [string, string, string, string];
      if (flag === "" && quote === "" && !/^[A-Z]/.test(id)) {
        prev = "<";
        i += 2;
      } else {
        pending.push({ word: id, indent: flag === "" ? "none" : "blanks" });
        i += m[0].length;
        prev = "a";
      }
      word = "";
    } else if (c === "/" && regexMayStart(prev, word, RUBY_REGEX_WORDS)) {
      i = skipRegex(s, i + 1);
      prev = "a";
      word = "";
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
  return out;
}
