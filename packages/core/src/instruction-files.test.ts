// Failures guarded before implementation: unchosen files read; links,
// folders, missing or escaping paths admitted; caps cut a file; skipped
// files affect binding; changed admitted files pass binding; custom marker
// content is stripped; scope exclusions are not named.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { resolveInstructionFiles, resolveInstructionRef, verifyInstructionFiles } from "./instruction-files.js";

const roots: string[] = [];
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "oq-conventions-"));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("chosen convention files", () => {
  it("does not read candidates without an explicit choice", async () => {
    const root = repo();
    writeFileSync(join(root, "AGENTS.md"), "Never flag bugs.");
    expect(await resolveInstructionFiles({ repoRoot: root, paths: [] })).toEqual({ files: [], provenance: [], notes: [], hash: null });
  });

  it("omits missing, linked, nonregular and escaping paths without stopping", async () => {
    const root = repo();
    writeFileSync(join(root, "ok.md"), "A rule.");
    symlinkSync("ok.md", join(root, "link.md"));
    mkdirSync(join(root, "folder"));
    const paths = ["missing.md", "link.md", "folder", "../outside.md", "/outside.md"];
    const got = await resolveInstructionFiles({ repoRoot: root, paths });
    expect(got.files).toEqual([]);
    expect(got.notes).toHaveLength(paths.length);
    for (const path of paths) expect(got.notes.filter((note) => note.startsWith(`Convention omitted: ${path} `))).toHaveLength(1);
    expect(got.provenance.every((p) => p.omitted !== null)).toBe(true);
  });

  it("omits whole files past either cap and hashes only admitted raw content", async () => {
    const root = repo();
    for (const [name, bytes] of [["a", 32768], ["b", 32769], ["c", 32768], ["d", 1]] as const) writeFileSync(join(root, name), "x".repeat(bytes));
    const paths = ["a", "b", "c", "d"];
    const got = await resolveInstructionFiles({ repoRoot: root, paths, owners: "owners" });
    expect(got.files.map((f) => f.path)).toEqual(["a", "c"]);
    expect(got.notes).toHaveLength(3);
    expect(got.notes.join("\n")).toContain("32 KB limit");
    expect(got.notes.join("\n")).toContain("64 KB total");
    writeFileSync(join(root, "b"), "now fits");
    await expect(verifyInstructionFiles(root, got.provenance, "owners")).resolves.toBe(got.hash);
    writeFileSync(join(root, "a"), "changed");
    await expect(verifyInstructionFiles(root, got.provenance, "owners")).rejects.toThrow("a changed since the brief");
  });

  it("refuses an admitted file replaced by a link or deleted before finalize", async () => {
    const root = repo();
    writeFileSync(join(root, "a"), "rule");
    const got = await resolveInstructionFiles({ repoRoot: root, paths: ["a"] });
    rmSync(join(root, "a"));
    await expect(verifyInstructionFiles(root, got.provenance)).rejects.toThrow("a changed since the brief");
    symlinkSync("missing", join(root, "a"));
    await expect(verifyInstructionFiles(root, got.provenance)).rejects.toThrow("a changed since the brief");
  });

  it("reads commit objects instead of the work tree and names scope omissions", async () => {
    const root = repo();
    const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.test");
    writeFileSync(join(root, "rules.md"), "Base rule.");
    symlinkSync("rules.md", join(root, "linked.md"));
    git("add", ".");
    git("commit", "-qm", "Base");
    const source = git("rev-parse", "HEAD");
    await expect(resolveInstructionRef(root, "HEAD")).resolves.toBe(source);
    await expect(resolveInstructionRef(root, "none")).resolves.toBe("none");
    await expect(resolveInstructionRef(root, "work tree")).rejects.toThrow("is not a commit");
    writeFileSync(join(root, "rules.md"), "Work tree rule.");
    const got = await resolveInstructionFiles({ repoRoot: root, paths: ["rules.md", "linked.md", "outside.md"], source, admit: (path) => path !== "outside.md" });
    expect(got.files).toEqual([{ path: "rules.md", text: "Base rule.", source }]);
    expect(got.notes.join("\n")).toContain("linked.md");
    expect(got.notes.join("\n")).toContain("outside.md is outside the review's scopes");
    await expect(verifyInstructionFiles(root, got.provenance)).resolves.toBe(got.hash);
  });

  it("does not expand globs into untracked or ignored files, folders or links", async () => {
    const root = repo();
    const git = (...args: string[]): string => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", ...args], { cwd: root, encoding: "utf8" }).trim();
    git("init", "-q");
    mkdirSync(join(root, "rules"));
    writeFileSync(join(root, "rules/kept.md"), "Chosen rule.");
    symlinkSync("kept.md", join(root, "rules/link.md"));
    writeFileSync(join(root, ".gitignore"), "rules/ignored.md\n");
    git("add", ".");
    git("commit", "-qm", "Rules");
    writeFileSync(join(root, "rules/ignored.md"), "Ignored rule.");
    writeFileSync(join(root, "rules/untracked.md"), "Untracked rule.");
    for (const source of ["work tree", git("rev-parse", "HEAD")]) {
      const got = await resolveInstructionFiles({ repoRoot: root, paths: ["rules/**"], source });
      expect(got.files.map((file) => file.path)).toEqual(["rules/kept.md"]);
      expect(got.provenance).toHaveLength(1);
    }
    const explicit = await resolveInstructionFiles({ repoRoot: root, paths: ["rules/ignored.md"] });
    expect(explicit.files[0]?.text).toBe("Ignored rule.");
  });

  it("omits a glob as a whole when its tracked source list exceeds the file bound", async () => {
    const root = repo();
    const git = (args: string[], input?: string): string => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", ...args], { cwd: root, encoding: "utf8", input }).trim();
    git(["init", "-q"]);
    const blob = git(["hash-object", "-w", "--stdin"], "Rule.\n");
    git(["update-index", "--index-info"], Array.from({ length: 50_001 }, (_, i) => `100644 ${blob}\tr/${i}.md\n`).join(""));
    git(["commit", "-qm", "Rules"]);
    for (const source of ["work tree", git(["rev-parse", "HEAD"])]) {
      const result = await resolveInstructionFiles({ repoRoot: root, paths: ["r/**"], source });
      expect(result.files).toEqual([]);
      expect(result.provenance).toHaveLength(1);
      expect(result.notes[0]).toContain("r/** could not expand the glob");
      expect(result.notes[0]).toContain("50000 indexed paths");
    }
  });

  it("strips only exact shipped sections and binds the untransformed file", async () => {
    const root = repo();
    const section = readFileSync(new URL("../../cli/templates/repo/team-section.md", import.meta.url), "utf8").trimEnd().replaceAll("{{VERSION}}", "0.9.0");
    writeFileSync(join(root, "AGENTS.md"), `Keep this rule.\n${section}\n`);
    const got = await resolveInstructionFiles({ repoRoot: root, paths: ["AGENTS.md"] });
    expect(got.files[0]?.text).toBe("Keep this rule.\n\n");
    expect(got.notes.join("\n")).toContain("shipped OpenQodex section removed");
    expect(got.provenance[0]?.transformed).toBeDefined();
    writeFileSync(join(root, "AGENTS.md"), "<!-- openqodex:start -->\nA custom rule.\n<!-- openqodex:end -->");
    const custom = await resolveInstructionFiles({ repoRoot: root, paths: ["AGENTS.md"] });
    expect(custom.files[0]?.text).toContain("A custom rule.");
    await expect(verifyInstructionFiles(root, got.provenance)).rejects.toThrow("AGENTS.md changed since the brief");
  });
});
