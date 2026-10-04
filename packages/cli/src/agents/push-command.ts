// Finds the `git push` commands in a shell command line and the folder each
// runs in. Best effort by design: this reads the command the agent is about
// to run, it does not run a shell. The hard gate is the git pre-push hook,
// which sees the real push.
//
// It honours quotes, backslashes, comments, here-documents (their bodies are
// data), redirects, the separators && || ; | & and newlines, subshells,
// command substitution ($( ) and backticks, also inside double quotes), the
// keywords that start a command inside a compound command (if, then, do,
// else, {, !), VAR=value prefixes, git's global options, `cd`, and git
// aliases (from -c alias.x=... or one `git config` lookup in the repo).
//
// Not covered, and left to the git hook: commands built at run time (eval,
// sh -c "...", bash -c, variables holding a command or a folder such as
// `$GIT push` or `cd "$DIR"`), shell functions and shell aliases, scripts and
// tools that push for you (npm run release, make deploy, gh, xargs, find
// -exec), sudo and other wrappers not listed here, `cd -`, pushd and popd,
// `export GIT_DIR`, and git aliases that run a shell command (alias.x=!...).
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";

type Token = { word: string } | { op: "sep" | "open" | "close" };

type Context = "top" | "paren" | "tick" | "dq";

function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  const stack: Context[] = ["top"];
  const heredocs: { delim: string; strip: boolean }[] = [];
  let word = "";
  let inWord = false;
  let dropNextWord = false;

  const flush = (): void => {
    if (inWord) {
      if (dropNextWord) dropNextWord = false;
      else tokens.push({ word });
    }
    word = "";
    inWord = false;
  };
  const op = (o: "sep" | "open" | "close"): void => {
    flush();
    tokens.push({ op: o });
  };
  // Reads the word after `<<`, without its quotes.
  const readDelimiter = (from: number): { delim: string; next: number } => {
    let i = from;
    while (line[i] === " " || line[i] === "\t") i++;
    let delim = "";
    while (i < line.length && !" \t\n;&|<>()".includes(line[i])) {
      if (line[i] !== "'" && line[i] !== '"' && line[i] !== "\\") delim += line[i];
      i++;
    }
    return { delim, next: i };
  };
  // Skips the here-document bodies that start after the newline at `i`.
  const skipBodies = (i: number): number => {
    let at = i + 1;
    for (const h of heredocs) {
      for (;;) {
        if (at >= line.length) return line.length;
        const nl = line.indexOf("\n", at);
        const end = nl === -1 ? line.length : nl;
        const text = h.strip ? line.slice(at, end).replace(/^\t+/, "") : line.slice(at, end);
        at = end + 1;
        if (text === h.delim) break;
      }
    }
    heredocs.length = 0;
    return at - 1;
  };

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const ctx = stack[stack.length - 1];
    if (ctx === "dq") {
      if (c === '"') stack.pop();
      else if (c === "\\" && i + 1 < line.length && '"\\$`\n'.includes(line[i + 1])) {
        word += line[++i];
      } else if (c === "$" && line[i + 1] === "(" && line[i + 2] !== "(") {
        op("open");
        stack.push("paren");
        i++;
      } else if (c === "`") {
        op("open");
        stack.push("tick");
      } else word += c;
      inWord = true;
      continue;
    }
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      const stop = end === -1 ? line.length : end;
      word += line.slice(i + 1, stop);
      inWord = true;
      i = stop;
    } else if (c === '"') {
      inWord = true;
      stack.push("dq");
    } else if (c === "\\") {
      if (i + 1 < line.length && line[i + 1] !== "\n") {
        word += line[i + 1];
        inWord = true;
      }
      i++;
    } else if (c === " " || c === "\t") {
      flush();
    } else if (c === "#" && !inWord) {
      const nl = line.indexOf("\n", i);
      i = nl === -1 ? line.length : nl - 1;
    } else if (c === "$" && line[i + 1] === "(" && line[i + 2] !== "(") {
      op("open");
      stack.push("paren");
      i++;
    } else if (c === "`") {
      if (ctx === "tick") {
        op("close");
        stack.pop();
      } else {
        op("open");
        stack.push("tick");
      }
    } else if (c === "(") {
      op("open");
      stack.push("paren");
    } else if (c === ")") {
      if (ctx === "paren") {
        op("close");
        stack.pop();
      } else op("sep");
    } else if (c === "<" && line[i + 1] === "<" && line[i + 2] !== "<") {
      flush();
      const strip = line[i + 2] === "-";
      const { delim, next } = readDelimiter(i + (strip ? 3 : 2));
      heredocs.push({ delim, strip });
      i = next - 1;
    } else if (c === "<" || c === ">" || (c === "&" && line[i + 1] === ">")) {
      // A redirect: a file descriptor number before it is not a word, and
      // the word after it is its target.
      if (inWord && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      }
      flush();
      let j = i + 1;
      while (j < line.length && "<>&|".includes(line[j])) j++;
      if (line[j - 1] === "&" && j < line.length && /[\d-]/.test(line[j])) {
        while (j < line.length && /[\d-]/.test(line[j])) j++;
      } else dropNextWord = true;
      i = j - 1;
    } else if (c === "\n") {
      op("sep");
      if (heredocs.length > 0) i = skipBodies(i);
    } else if (c === ";" || c === "&" || c === "|") {
      op("sep");
      if ((c === "&" || c === "|") && line[i + 1] === c) i++;
      else if (c === "|" && line[i + 1] === "&") i++;
    } else {
      word += c;
      inWord = true;
    }
  }
  flush();
  return tokens;
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
// Words that can stand before a command without being it.
const PREFIX_WORDS = new Set(["if", "then", "do", "else", "elif", "while", "until", "{", "!", "time", "command", "exec", "env", "nohup"]);
// git's global options that take the next word as their value.
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"]);
// git commands we know are not push; anything else may be an alias.
const GIT_BUILTINS = new Set(
  (
    "add am annotate apply archive bisect blame branch bundle cat-file check-attr check-ignore checkout cherry cherry-pick " +
    "clean clone commit config count-objects describe diff diff-files diff-index diff-tree difftool fetch format-patch fsck gc " +
    "grep gui hash-object help init instaweb lfs log ls-files ls-remote ls-tree maintenance merge merge-base mergetool mv notes " +
    "pull range-diff rebase reflog remote repack replace request-pull reset restore rev-list rev-parse revert rm shortlog show " +
    "show-ref sparse-checkout stash status submodule switch symbolic-ref tag update-index update-ref var verify-commit " +
    "verify-tag version whatchanged worktree write-tree"
  ).split(" "),
);

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return p;
}

const isPushAlias = (expansion: string): boolean => /^push(\s|$)/.test(expansion.trim());

// Looks up `git config --get alias.<name>` in a folder; null when unset.
export type AliasLookup = (folder: string, name: string) => Promise<string | null>;

// One `git push` on the line: the folder it runs in and the words after
// `push` (for an alias, the words its expansion adds, then the rest).
export type PushCommand = { folder: string; args: string[] };

// The folder of every `git push` on the line, in order, without repeats.
export async function pushFolders(line: string, cwd: string, lookupAlias: AliasLookup): Promise<string[]> {
  return [...new Set((await pushCommands(line, cwd, lookupAlias)).map((p) => p.folder))];
}

// Every `git push` on the line, in order.
export async function pushCommands(line: string, cwd: string, lookupAlias: AliasLookup): Promise<PushCommand[]> {
  const found: PushCommand[] = [];
  const dirs: string[] = [cwd];
  let words: string[] = [];

  const runCommand = async (): Promise<void> => {
    const ws = words;
    words = [];
    const env: Record<string, string> = {};
    let i = 0;
    for (; i < ws.length; i++) {
      const m = ASSIGNMENT.exec(ws[i]);
      if (m) env[m[1]] = m[2];
      else if (!PREFIX_WORDS.has(ws[i])) break;
    }
    const dir = dirs[dirs.length - 1];
    if (ws[i] === "cd") {
      const to = ws[i + 1];
      if (to !== undefined && to !== "-") dirs[dirs.length - 1] = resolve(dir, expandHome(to));
      else if (to === undefined) dirs[dirs.length - 1] = homedir();
      return;
    }
    if (ws[i] !== "git") return;

    let at = dir;
    let gitDir = env.GIT_DIR !== undefined ? resolve(at, expandHome(env.GIT_DIR)) : null;
    let workTree = env.GIT_WORK_TREE !== undefined ? resolve(at, expandHome(env.GIT_WORK_TREE)) : null;
    const aliases: Record<string, string> = {};
    let j = i + 1;
    while (j < ws.length && ws[j].startsWith("-")) {
      const opt = ws[j];
      const eq = opt.indexOf("=");
      const [name, inline] = opt.startsWith("--") && eq !== -1 ? [opt.slice(0, eq), opt.slice(eq + 1)] : [opt, null];
      let value: string | undefined;
      if (name.startsWith("-C") && name.length > 2) {
        value = name.slice(2);
        at = resolve(at, expandHome(value));
        j += 1;
        continue;
      }
      if (inline !== null) value = inline;
      else if (GIT_OPTIONS_WITH_VALUE.has(name)) value = ws[++j];
      j += 1;
      if (value === undefined) continue;
      if (name === "-C") at = resolve(at, expandHome(value));
      else if (name === "--git-dir") gitDir = resolve(at, expandHome(value));
      else if (name === "--work-tree") workTree = resolve(at, expandHome(value));
      else if (name === "-c") {
        const m = /^alias\.([^=]+)=(.*)$/s.exec(value);
        if (m) aliases[m[1]] = m[2];
      }
    }
    const folder = workTree ?? (gitDir ? (basename(gitDir) === ".git" ? dirname(gitDir) : gitDir) : at);
    const sub = ws[j];
    if (sub === undefined) return;
    let push = sub === "push";
    let expansion: string | null = null;
    if (!push && aliases[sub] !== undefined) expansion = aliases[sub];
    else if (!push && !GIT_BUILTINS.has(sub) && !sub.startsWith("-")) expansion = await lookupAlias(folder, sub);
    if (!push && expansion !== null) push = isPushAlias(expansion);
    const added = expansion === null ? [] : expansion.trim().split(/\s+/).slice(1);
    if (push) found.push({ folder, args: [...added, ...ws.slice(j + 1)] });
  };

  for (const t of tokenize(line)) {
    if ("word" in t) {
      words.push(t.word);
      continue;
    }
    await runCommand();
    // A subshell or a substitution gets its own folder; a cd in it does not leak out.
    if (t.op === "open") dirs.push(dirs[dirs.length - 1]);
    else if (t.op === "close" && dirs.length > 1) dirs.pop();
  }
  await runCommand();
  return found;
}
