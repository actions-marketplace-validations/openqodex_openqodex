// cargo-deny reports each crate by name, version and source on a line of a
// crate list it makes up, not of Cargo.lock. These tests read its real
// output (test/fixtures/cargo-deny/check.txt says how it was made).
//
// Failure list, written before the code:
//   1. An advisory lands on a line other than its crate's entry in
//      Cargo.lock: the span runs from the entry's name line to its version
//      line, the span osv-scanner gives the same advisory, so the two can be
//      merged.
//   2. With two versions of one crate in the lockfile, an advisory lands on
//      the entry of the other version.
//   3. The rule id is not the advisory id, or the severity ignores the kind
//      (a vulnerability is high, unsound medium, unmaintained low).
//   4. A line that is not about the crate graph (a log line, the summary, an
//      index failure) becomes a finding.
//   5. An error cargo-deny logs is lost, so a failed run reads clean.
//   6. Crates missing from the Cargo cache read as a clean run instead of a
//      reason that names the fix.
//   7. The owned config lets a repository's deny.toml in, keeps the advisory
//      database outside the OpenQodex home, or checks yanked crates through
//      the developer's index cache.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cargoDenyConfig, metadataFailure, parseCargoDenyOutput } from "./cargo-deny.js";

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../../test/fixtures/cargo-deny/${name}`, import.meta.url)), "utf8");
const CHECK = fixture("check.jsonl");
const LOCK = fixture("Cargo.lock.txt");
const parse = (stderr = CHECK, lockText: string | null = LOCK) => parseCargoDenyOutput(stderr, { lockPath: "Cargo.lock", lockText });

describe("parseCargoDenyOutput", () => {
  it("each advisory lands on its crate's entry, name line to version line, as osv-scanner anchors it (1, 3)", () => {
    const { findings, failure } = parse();
    expect(failure).toBeNull();
    expect(findings.map((f) => [f.ruleId, f.filePath, f.lineStart, f.lineEnd, f.severity])).toEqual([
      ["RUSTSEC-2021-0139", "Cargo.lock", 6, 7, "low"],
      ["RUSTSEC-2021-0003", "Cargo.lock", 15, 16, "high"],
    ]);
    const vuln = findings[1]!;
    expect(vuln).toMatchObject({ source: "cargo-deny", reference: "https://rustsec.org/advisories/RUSTSEC-2021-0003" });
    expect(vuln.message).toContain("smallvec 1.6.0");
    expect(vuln.message).toContain("CVE-2021-25900");
    expect(vuln.message).toContain("Buffer overflow in SmallVec::insert_many");
    expect(vuln.message).toContain("Upgrade to >=0.6.14, <1.0.0 OR >=1.6.1");
  });

  it("with two versions of a crate, the advisory lands on the version it names (2)", () => {
    const lock = LOCK.replace('name = "smallvec"\nversion = "1.6.0"', 'name = "smallvec"\nversion = "1.13.2"\nsource = "x"\n\n[[package]]\nname = "smallvec"\nversion = "1.6.0"');
    const vuln = parse(CHECK, lock).findings.find((f) => f.ruleId === "RUSTSEC-2021-0003")!;
    expect(lock.split("\n")[vuln.lineStart - 1]).toBe('name = "smallvec"');
    expect(lock.split("\n")[vuln.lineEnd - 1]).toBe('version = "1.6.0"');
  });

  it("log lines, the summary and an index failure are not findings (4)", () => {
    const index = JSON.stringify({ fields: { code: "index-failure", labels: [{ column: 1, line: 1, message: "", span: "smallvec 1.6.0 registry+https://github.com/rust-lang/crates.io-index" }], message: "unable to check for yanked crates", notes: [], severity: "warning" }, type: "diagnostic" });
    const info = JSON.stringify({ fields: { level: "INFO", message: "gathered 5 crates" }, type: "log" });
    const { findings, failure } = parse(`${index}\n${info}\n${CHECK}`);
    expect(findings.map((f) => f.ruleId)).toEqual(["RUSTSEC-2021-0139", "RUSTSEC-2021-0003"]);
    expect(failure).toBeNull();
  });

  it("an error cargo-deny logs fails the run, and a run with no summary is not clean (5)", () => {
    const error = JSON.stringify({ fields: { level: "ERROR", message: "failed to validate configuration file /tmp/x/deny.toml" }, type: "log" });
    expect(parse(error).failure).toBe("failed to validate configuration file /tmp/x/deny.toml");
    expect(parse("").failure).toBe("cargo-deny printed no result");
  });

  it("an advisory on a lockfile that cannot be read lands on line 1", () => {
    expect(parse(CHECK, null).findings.map((f) => [f.lineStart, f.lineEnd])).toEqual([
      [1, 1],
      [1, 1],
    ]);
  });
});

describe("metadataFailure", () => {
  it("crates missing from the Cargo cache name the fix, not a clean run (6)", () => {
    expect(metadataFailure(fixture("metadata-missing.txt"), "rust")).toBe(
      "the crates of rust/Cargo.lock are not all in your Cargo cache (failed to download `itoa v0.1.1`); run `cargo fetch` in rust/ once",
    );
    // Cargo 1.99, when its index cache has never seen the crate.
    const unseen = "error: no matching package named `itoa` found\nlocation searched: crates.io index\nrequired by package `miss v0.1.0 (/x)`\nnote: offline mode (via `--frozen`) can sometimes cause surprising resolution failures\n";
    expect(metadataFailure(unseen, "")).toBe(
      "the crates of Cargo.lock are not all in your Cargo cache (no matching package named `itoa` found); run `cargo fetch` in the repository root once",
    );
    expect(metadataFailure("error: the lock file /x/Cargo.lock needs to be updated but --frozen was passed to prevent this\n", "")).toBe(
      "cargo metadata failed: error: the lock file /x/Cargo.lock needs to be updated but --frozen was passed to prevent this",
    );
  });
});

describe("cargoDenyConfig", () => {
  it("keeps the advisory database under the given folder, from RustSec only, with yank checks off (7)", () => {
    const config = cargoDenyConfig("/home/u/.openqodex/cache/cargo-deny/advisory-dbs");
    expect(config).toContain('db-path = "/home/u/.openqodex/cache/cargo-deny/advisory-dbs"');
    expect(config).toContain('db-urls = ["https://github.com/rustsec/advisory-db"]');
    expect(config).toContain("disable-yank-checking = true");
    expect(config).not.toMatch(/\[licenses\]|\[bans\]/);
    // A path with a quote or a backslash stays one TOML string.
    expect(cargoDenyConfig('/a"b\\c')).toContain('db-path = "/a\\"b\\\\c"');
  });
});
