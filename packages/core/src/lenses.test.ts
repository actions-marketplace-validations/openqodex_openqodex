// Ways the lens catalog and selector could fail:
// 1. A malformed lens (no frontmatter, no name, no description, empty body,
//    bad regex) is accepted instead of failing loudly.
// 2. A shipped lens does not parse, or two share a name.
// 3. The lens folder is looked up from the current directory, or a folder
//    with no markdown in it (the bundle's) is picked.
// 4. A lens fires when its file glob or its content regex does not match.
// 5. More than four lenses are selected, or the ranking is not most specific
//    first, then lowest floor, then name.
// 6. A shipped lens still carries an em dash or private wording.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultLensDir,
  extractChangedLineText,
  loadLensCatalog,
  parseLens,
  pickLensDirFromCandidates,
  selectLensesForDiff,
  type Lens,
} from "./lenses.js";

const FILE_DIFF = [
  "diff --git a/src/api/billing.ts b/src/api/billing.ts",
  "index 111..222 100644",
  "--- a/src/api/billing.ts",
  "+++ b/src/api/billing.ts",
  "@@ -1,3 +1,5 @@",
  ' import { db } from "./db";',
  "+",
  "+await db.users.upsert({ id, stage: 'active' });",
  " export const x = 1;",
].join("\n");

describe("parseLens", () => {
  it("parses a lens with full frontmatter and body", () => {
    const lens = parseLens(`---
name: my-lens
description: catches a bad thing
triggers:
  files: ["*.ts"]
  hunk_regex: "\\\\bbadthing\\\\b"
confidence_floor: 0.8
---
body line one
body line two`);
    expect(lens).toMatchObject({
      name: "my-lens",
      description: "catches a bad thing",
      triggers: { files: ["*.ts"], hunkRegex: "\\bbadthing\\b" },
      confidenceFloor: 0.8,
    });
    expect(lens.body).toContain("body line one");
  });

  it("throws when name or description is missing", () => {
    expect(() => parseLens(`---\ndescription: x\n---\nbody`)).toThrow(/name/);
    expect(() => parseLens(`---\nname: x\n---\nbody`)).toThrow(/description/);
  });

  it("throws when the hunk_regex is invalid", () => {
    expect(() => parseLens(`---\nname: bad\ndescription: bad\ntriggers:\n  hunk_regex: "[unclosed"\n---\nbody`)).toThrow(/regex/);
  });

  it("throws when body is empty", () => {
    expect(() => parseLens(`---\nname: a\ndescription: b\n---\n   `)).toThrow(/body/);
  });

  it("throws when frontmatter delimiters are missing", () => {
    expect(() => parseLens("no frontmatter")).toThrow(/frontmatter/);
  });
});

describe("extractChangedLineText", () => {
  it("keeps + and - lines and strips +++/--- file headers", () => {
    const text = extractChangedLineText(FILE_DIFF);
    expect(text).not.toContain("a/src/api/billing.ts");
    expect(text).not.toContain("b/src/api/billing.ts");
    expect(text).toContain("await db.users.upsert");
  });
});

function lens(name: string, triggers: Lens["triggers"], floor = 0.7): Lens {
  return { name, description: "d", triggers, confidenceFloor: floor, body: "b" };
}

describe("selectLensesForDiff without file globs", () => {
  it("matches and skips by hunk regex, case-insensitively", () => {
    const catalog = [lens("upsert", { hunkRegex: "\\bupsert\\b" })];
    expect(selectLensesForDiff({ diff: FILE_DIFF.replace("upsert", "UPSERT"), files: [], catalog })).toHaveLength(1);
    expect(selectLensesForDiff({ diff: FILE_DIFF.replace("upsert", "insert"), files: [], catalog })).toEqual([]);
  });

  it("caps the number of selected lenses at 4", () => {
    const catalog = ["l1", "l2", "l3", "l4", "l5", "l6"].map((n) => lens(n, {}));
    expect(selectLensesForDiff({ diff: "", files: [], catalog })).toHaveLength(4);
  });

  it("ranks a content-matched lens ahead of always-on ones", () => {
    const catalog = [lens("a-always", {}), lens("b-always", {}), lens("z-hunk", { hunkRegex: "upsert" })];
    const out = selectLensesForDiff({ diff: FILE_DIFF, files: [], catalog });
    expect(out.map((l) => l.name)).toEqual(["z-hunk", "a-always", "b-always"]);
  });

  it("breaks a specificity tie by lower confidence floor first", () => {
    const catalog = [lens("high", {}, 0.9), lens("low", {}, 0.6), lens("mid", {}, 0.75)];
    const out = selectLensesForDiff({ diff: "", files: [], catalog });
    expect(out.map((l) => l.name)).toEqual(["low", "mid", "high"]);
  });
});

describe("selectLensesForDiff with file globs", () => {
  const upsertLens = lens("upsert-state", { files: ["*.ts", "**/*.ts"], hunkRegex: "\\bupsert\\b" });

  it("selects a lens whose file glob and hunk regex both match", () => {
    const out = selectLensesForDiff({ diff: FILE_DIFF, files: ["src/api/billing.ts"], catalog: [upsertLens] });
    expect(out.map((l) => l.name)).toEqual(["upsert-state"]);
  });

  it("skips a lens when no file matches the glob", () => {
    const py = lens("py-thing", { files: ["*.py", "**/*.py"] });
    expect(selectLensesForDiff({ diff: FILE_DIFF, files: ["src/api/billing.ts"], catalog: [py] })).toEqual([]);
  });

  it("ranks hunk-and-file, then file-only, then always-on", () => {
    const catalog = [
      lens("a-always", {}),
      lens("b-always", {}),
      lens("c-always", {}),
      lens("m-file", { files: ["*.ts", "**/*.ts"] }),
      lens("z-specific", { files: ["*.ts", "**/*.ts"], hunkRegex: "\\bupsert\\b" }),
    ];
    const out = selectLensesForDiff({ diff: FILE_DIFF, files: ["src/api/billing.ts"], catalog });
    expect(out.map((l) => l.name)).toEqual(["z-specific", "m-file", "a-always", "b-always"]);
  });

  it("selects the SQL lenses from the shipped catalog for Java and SQL changes", () => {
    const catalog = loadLensCatalog();
    const select = (diff: string, files: string[]) => selectLensesForDiff({ diff, files, catalog }).map((l) => l.name);
    const java = [
      "+++ b/src/main/java/com/example/EmployeeController.java",
      '+@PostMapping("/employees")',
      '+  String sql = "SELECT * FROM employees WHERE id = " + dto.getId();',
    ].join("\n");
    const picked = select(java, ["src/main/java/com/example/EmployeeController.java"]);
    expect(picked).toContain("sql-string-concatenation");
    expect(picked).toContain("auth-missing-on-state-change-route");

    const fn = `--- a/db/fn.sql\n+++ b/db/fn.sql\n@@\n+CREATE FUNCTION public.do_thing() RETURNS void\n+LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN END $$;\n`;
    expect(select(fn, ["db/fn.sql"])).toContain("supabase-security-definer-no-search-path");
    const migration = `--- /dev/null\n+++ b/migrations/20260610120000_x.sql\n@@\n+-- @include sql/functions/get_all_teams.sql\n`;
    expect(select(migration, ["migrations/20260610120000_x.sql"])).toContain("sql-migration-references-later-object");
    const ui = `--- a/ui/App.tsx\n+++ b/ui/App.tsx\n@@\n+const x = 1;\n`;
    expect(select(ui, ["ui/App.tsx"])).not.toContain("sql-migration-references-later-object");
  });
});

describe("pickLensDirFromCandidates", () => {
  const root = () => mkdtempSync(join(tmpdir(), "openqodex-lenses-test-"));

  it("skips a candidate that exists but has no .md files", () => {
    const r = root();
    const bundleLike = join(r, "bundle");
    const lensDir = join(r, "lenses");
    mkdirSync(bundleLike);
    writeFileSync(join(bundleLike, "index.js"), "// bundled\n");
    mkdirSync(lensDir);
    writeFileSync(join(lensDir, "x.md"), "---\nname: x\ndescription: y\n---\nbody");
    expect(pickLensDirFromCandidates([bundleLike, lensDir])).toBe(lensDir);
  });

  it("throws when no candidate exists or has markdown", () => {
    const r = root();
    expect(() => pickLensDirFromCandidates([join(r, "missing-a"), join(r, "missing-b")])).toThrow(
      /lens catalog directory not found/,
    );
  });

  it("finds the shipped lenses from the module's own location", () => {
    const original = process.cwd();
    process.chdir(tmpdir());
    try {
      expect(defaultLensDir().endsWith(join("core", "lenses"))).toBe(true);
    } finally {
      process.chdir(original);
    }
  });
});

describe("the shipped catalog", () => {
  it("parses every lens, 48 of them, with unique names and usable bodies", () => {
    const catalog = loadLensCatalog();
    expect(catalog).toHaveLength(48);
    const names = catalog.map((l) => l.name);
    expect(new Set(names).size).toBe(names.length);
    for (const l of catalog) {
      expect(l.body.length).toBeGreaterThan(50);
      expect(l.confidenceFloor).toBeGreaterThan(0);
      expect(l.confidenceFloor).toBeLessThanOrEqual(1);
    }
  });

  it("carries no em dash and no provenance from another review product", () => {
    const dir = defaultLensDir();
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      const text = readFileSync(join(dir, file), "utf8");
      expect(text, file).not.toContain(String.fromCharCode(0x2014));
      expect(text, file).not.toMatch(/caught by|motivated this lens|qodex/i);
    }
  });
});
