// The closed list of bug classes. Every planted bug names one in `class`, so
// the scanner tables can group truth by the kind of problem a scanner is
// built to find (which scanner finds which class, where no scanner reaches).
// A class is chosen by what is wrong, never by who finds it.
//
// The list is versioned: adding, removing or renaming a class is a new
// version, and a run records the version it scored with. A planted case that
// changes its class is a new case (benchmark/lib/cases.mjs, the lock).
export const CLASSES_VERSION = 1;

export const CLASSES = Object.freeze([
  "secret",
  "sql-injection",
  "command-injection",
  "path-traversal",
  "template-injection",
  "xss",
  "access-control",
  "authentication",
  "csrf",
  "crypto",
  "deserialization",
  "ssrf",
  "dependency-vulnerability",
  "container-config",
  "iac-exposure",
  "kubernetes-privilege",
  "workflow-injection",
  "workflow-permissions",
  "shell-safety",
  "migration-lock",
  "migration-data",
  "null-or-undefined",
  "error-handling",
  "resource-leak",
  "concurrency",
  "async",
  "logic",
  "contract-break",
  "performance",
  "framework-misuse",
  "debug-config",
  "style",
]);
