// Decides whether a shell command line runs `git push`, and in which folder.
// A small shell word splitter, not a shell: it honours quotes, backslashes
// and the separators && || ; | & ( ) and newlines. Anything it cannot read as
// a plain `git ... push` is treated as not a push, so the hook abstains.
import { homedir } from "node:os";
import { resolve } from "node:path";

type Token = { word: string } | { op: string };

function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  let word = "";
  let inWord = false;
  const flush = (): void => {
    if (inWord) tokens.push({ word });
    word = "";
    inWord = false;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      const stop = end === -1 ? line.length : end;
      word += line.slice(i + 1, stop);
      inWord = true;
      i = stop;
    } else if (c === '"') {
      inWord = true;
      for (i++; i < line.length && line[i] !== '"'; i++) {
        if (line[i] === "\\" && i + 1 < line.length && '"\\$`\n'.includes(line[i + 1])) i++;
        word += line[i];
      }
    } else if (c === "\\") {
      if (i + 1 < line.length && line[i + 1] !== "\n") {
        word += line[i + 1];
        inWord = true;
      }
      i++;
    } else if (c === " " || c === "\t") {
      flush();
    } else if (c === "#" && !inWord) {
      // A comment runs to the end of the line.
      const nl = line.indexOf("\n", i);
      i = nl === -1 ? line.length : nl - 1;
    } else if ("\n;&|()".includes(c)) {
      flush();
      const two = line.slice(i, i + 2);
      if (two === "&&" || two === "||") {
        tokens.push({ op: two });
        i++;
      } else tokens.push({ op: c });
    } else {
      word += c;
      inWord = true;
    }
  }
  flush();
  return tokens;
}

// Simple commands, each with the operator that ended the one before it.
function simpleCommands(line: string): { words: string[]; after: string | null }[] {
  const out: { words: string[]; after: string | null }[] = [];
  let words: string[] = [];
  let after: string | null = null;
  for (const t of tokenize(line)) {
    if ("op" in t) {
      out.push({ words, after });
      words = [];
      after = t.op;
    } else words.push(t.word);
  }
  out.push({ words, after });
  return out.filter((c) => c.words.length > 0);
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PREFIX_COMMANDS = new Set(["command", "exec", "env"]);
// git's global options that take the next word as their value.
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"]);

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return p;
}

// The folder a push runs in, or null when the line runs no `git push`.
export function pushFolder(line: string, cwd: string): string | null {
  let dir = cwd;
  for (const { words } of simpleCommands(line)) {
    let i = 0;
    while (i < words.length && (ASSIGNMENT.test(words[i]) || PREFIX_COMMANDS.has(words[i]))) i++;
    const cmd = words[i];
    if (cmd === "cd" && words.length > i + 1) {
      dir = resolve(dir, expandHome(words[i + 1]));
      continue;
    }
    if (cmd !== "git") continue;
    let gitDir = dir;
    let j = i + 1;
    while (j < words.length && words[j].startsWith("-")) {
      const opt = words[j];
      if (GIT_OPTIONS_WITH_VALUE.has(opt)) {
        if (opt === "-C" && j + 1 < words.length) gitDir = resolve(gitDir, expandHome(words[j + 1]));
        j += 2;
      } else j += 1;
    }
    if (words[j] === "push") return gitDir;
  }
  return null;
}
