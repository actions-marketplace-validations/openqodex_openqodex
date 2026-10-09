// The TOML key reader init uses before it appends its block to Codex's
// config.toml (src/agents/toml-keys.ts). It reads every key path the file
// defines and executes nothing. A key it misses lets init append a second
// definition of the server, and Codex then refuses the whole file.
//
// Ways a key could be missed or misread, written before the code:
//  1. A quoted key, basic or literal, in a table header or a dotted key is
//     compared by its spelling with the quotes, so [mcp_servers."openqodex"]
//     is missed.
//  2. An escape in a basic-string key (\u0071, \U00000071, \\, \") is not
//     decoded, so the key is missed or read as another one.
//  3. Whitespace around the dots of a key ("mcp_servers" . openqodex) splits
//     the key or ends it early.
//  4. An array-of-tables header [[...]] is not read as a header, or is read
//     as an array value.
//  5. A key under a table header is read without the table's path, or the
//     header's path does not carry to the keys after it.
//  6. The keys of an inline table, or of one nested in it, are not read, or
//     are read at the root.
//  7. Text inside a value is read as a key or a header: a # or a [ in a
//     basic or literal string, a multi-line string (basic or literal, with
//     quotes just before its end, or an escaped quote) holding a line such
//     as [mcp_servers.openqodex], or an array spread over lines with
//     comments in it.
//  8. A comment, on its own line or after a value, is read as a key.
//  9. A valid value the reader does not know makes it give up on a valid
//     file: a date with a space before its time, a number with
//     underscores, inf, nan, a hex integer, a boolean; or a nested array or
//     an inline table inside an array ends the value early.
// 10. A file that is not TOML (an unterminated string, a key with no value,
//     text after a value, an unknown escape, an unclosed header) is read as
//     if it were, and its keys are trusted.
// 11. CRLF line ends or a byte order mark make it give up on a valid file.
import { describe, expect, it } from "vitest";
import { readTomlKeys } from "../src/agents/toml-keys.js";

// Each key path the file defines, dotted, with its kind.
function keys(text: string): string[] {
  const r = readTomlKeys(text);
  if (!r.ok) throw new Error(`not read: ${r.reason}`);
  return r.keys.map((k) => `${k.path.join(".")}:${k.kind}`);
}

describe("the key paths a TOML file defines", () => {
  it("1. reads quoted keys, basic and literal, in headers and in dotted keys", () => {
    expect(keys('[mcp_servers."openqodex"]\n')).toEqual(["mcp_servers.openqodex:table"]);
    expect(keys("[mcp_servers.'openqodex']\n")).toEqual(["mcp_servers.openqodex:table"]);
    expect(keys('mcp_servers."openqodex".command = "x"\n')).toEqual(["mcp_servers.openqodex.command:value"]);
    expect(keys('"a.b" = 1\n')).toEqual(["a.b:value"]);
  });

  it("2. decodes the escapes of a basic-string key", () => {
    expect(keys('[mcp_servers."open\\u0071odex"]\n')).toEqual(["mcp_servers.openqodex:table"]);
    expect(keys('[mcp_servers."open\\U00000071odex"]\n')).toEqual(["mcp_servers.openqodex:table"]);
    expect(keys('"a\\\\b\\"c" = 1\n')).toEqual(['a\\b"c:value']);
    // A literal key keeps its backslash as written.
    expect(keys("'open\\u0071odex' = 1\n")).toEqual(["open\\u0071odex:value"]);
  });

  it("3. reads a key with whitespace around its dots", () => {
    expect(keys('[ "mcp_servers" . openqodex ]\n')).toEqual(["mcp_servers.openqodex:table"]);
    expect(keys('"mcp_servers" . openqodex . command = "x"\n')).toEqual(["mcp_servers.openqodex.command:value"]);
    expect(keys("a\t.\tb = 1\n")).toEqual(["a.b:value"]);
  });

  it("4. reads an array-of-tables header as a header", () => {
    expect(keys("[[mcp_servers.openqodex]]\ncommand = 'x'\n")).toEqual(["mcp_servers.openqodex:array-table", "mcp_servers.openqodex.command:value"]);
  });

  it("5. carries a header's path to the keys after it, until the next header", () => {
    expect(keys('top = 1\n[a.b]\nc.d = 2\n[e]\nf = "g"\n')).toEqual(["top:value", "a.b:table", "a.b.c.d:value", "e:table", "e.f:value"]);
  });

  it("6. reads the keys of an inline table and of one nested in it, under their own path", () => {
    expect(keys('mcp_servers = { openqodex = { command = "x", args = ["mcp"] } }\n')).toEqual([
      "mcp_servers.openqodex.command:value",
      "mcp_servers.openqodex.args:array",
      "mcp_servers.openqodex:inline-table",
      "mcp_servers:inline-table",
    ]);
    expect(keys("[t]\nx = { a.b = 1 }\n")).toEqual(["t:table", "t.x.a.b:value", "t.x:inline-table"]);
  });

  it("7. reads no key or header from inside a string or an array", () => {
    expect(keys('a = "x # [mcp_servers.openqodex]"\nb = \'[mcp_servers.openqodex]\'\n')).toEqual(["a:value", "b:value"]);
    const multi = ['notes = """', "[mcp_servers.openqodex]", 'command = "x" \\"""', 'still inside """"', "lit = '''", "[mcp_servers.openqodex]", "''''", "list = [", "  1, # [mcp_servers.openqodex]", "  [2, 3],", "]", ""].join("\n");
    expect(keys(multi)).toEqual(["notes:value", "lit:value", "list:array"]);
  });

  it("8. reads no key from a comment", () => {
    expect(keys("# [mcp_servers.openqodex]\n  # openqodex = 1\na = 1 # b = 2\n")).toEqual(["a:value"]);
  });

  it("9. reads every kind of value of a valid file and the keys after it", () => {
    const text = [
      "d1 = 1979-05-27 07:32:00Z",
      "d2 = 1979-05-27T00:32:00.999999-07:00",
      "d3 = 1979-05-27",
      "t1 = 07:32:00",
      "n1 = 1_000",
      "n2 = -0.01e+2_0",
      "n3 = inf",
      "n4 = -nan",
      "n5 = 0xDEAD_beef",
      "n6 = 0o17",
      "n7 = 0b1010",
      "b = true",
      "arr = [ [1, 2], { k = 'v' }, \"s\", ]",
      "last = false",
      "",
    ].join("\n");
    const read = keys(text);
    expect(read).toHaveLength(14);
    expect(read.at(-1)).toBe("last:value");
  });

  it("10. refuses a file that is not TOML", () => {
    for (const text of ['a = "unterminated\n', "a =\n", "a = 1 b = 2\n", 'a = "\\q"\n', "[mcp_servers\n", "a = bare\n", "= 1\n"]) {
      expect(readTomlKeys(text).ok, text).toBe(false);
    }
  });

  it("11. reads a file with CRLF line ends and a byte order mark", () => {
    expect(keys('\uFEFF[mcp_servers.db]\r\ncommand = "x"\r\n# c\r\n')).toEqual(["mcp_servers.db:table", "mcp_servers.db.command:value"]);
  });
});
