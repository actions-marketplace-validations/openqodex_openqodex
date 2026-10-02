// A cheap, mechanical pass over the changed paths: did this change touch a
// source code file while touching no test file? When true, the brief adds a
// one-line hint to check whether the changed behaviour is covered. It biases
// attention only; it never becomes a finding by itself.

// Path segments that, anywhere in the path, mark a test directory.
const TEST_DIR_SEGMENTS = new Set(["test", "tests", "__tests__", "spec", "specs", "e2e", "__mocks__"]);

const DOC_EXTS = new Set([".md", ".mdx", ".markdown", ".rst", ".txt", ".adoc"]);

const LOCKFILE_BASENAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "npm-shrinkwrap.json",
  "cargo.lock",
  "gemfile.lock",
  "poetry.lock",
  "pipfile.lock",
  "uv.lock",
  "composer.lock",
  "go.sum",
]);

const GENERATED_DIR_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "build",
  "vendor",
  "generated",
  "__generated__",
  "__snapshots__",
]);

function extname(p: string): string {
  const base = p.slice(p.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

// Is this path a code file worth reviewing (not a doc, lockfile or
// generated artifact)?
export function isReviewableCodeFile(path: string): boolean {
  const lower = path.toLowerCase();
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  if (LOCKFILE_BASENAMES.has(base)) return false;
  if (DOC_EXTS.has(extname(lower))) return false;
  if (
    base.endsWith(".min.js") ||
    base.endsWith(".min.css") ||
    base.endsWith(".map") ||
    base.endsWith(".snap") ||
    base.endsWith(".d.ts") ||
    base.endsWith(".pb.go") ||
    base.endsWith("_pb2.py")
  ) {
    return false;
  }
  const segments = lower.split("/");
  for (let i = 0; i < segments.length - 1; i++) {
    if (GENERATED_DIR_SEGMENTS.has(segments[i] ?? "")) return false;
  }
  return true;
}

// Is this path a test file? Covers `*.test.*` and `*.spec.*` (JS and TS),
// `*_test.go`, `*_test.py` and `test_*.py`, `*_spec.rb`, `*Test.java`,
// `*Tests.cs` and `*Test.kt`, plus any file under a test directory. The
// delimiter-anchored checks avoid `latest.go` and `contest.ts`; the JVM and
// .NET suffix check uses the original case so `latest.java` is not a test.
export function isTestFile(path: string): boolean {
  const lower = path.toLowerCase();
  const segments = lower.split("/");
  for (let i = 0; i < segments.length - 1; i++) {
    if (TEST_DIR_SEGMENTS.has(segments[i] ?? "")) return true;
  }
  const lowerBase = lower.slice(lower.lastIndexOf("/") + 1);
  if (
    lowerBase.includes(".test.") ||
    lowerBase.includes(".spec.") ||
    lowerBase.includes("_test.") ||
    lowerBase.includes("_spec.") ||
    lowerBase.startsWith("test_")
  ) {
    return true;
  }
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  const name = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  return (ext === "java" || ext === "cs" || ext === "kt") && /Tests?$/.test(name);
}

// True when the change touched at least one source code file and no test
// file. False for a docs-only, test-only or mixed change.
export function computeMissingTestSignal(changedPaths: string[]): boolean {
  let sourceFiles = 0;
  let testFiles = 0;
  for (const path of changedPaths) {
    if (!path) continue;
    if (isTestFile(path)) {
      testFiles++;
      continue;
    }
    if (isReviewableCodeFile(path)) sourceFiles++;
  }
  return sourceFiles > 0 && testFiles === 0;
}
