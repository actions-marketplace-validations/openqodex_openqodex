// Tiny glob matcher. Patterns understand:
//   *   any characters except "/"
//   **  any characters including "/"
//   ?   any single character except "/"
// Anchored at both ends, no negation, no character classes; every other
// character, regex metacharacters included, matches itself literally.
export function matchesGlob(path: string, glob: string): boolean {
  const re = glob
    .replace(/[.+^$(){}|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\x00") // sentinel for **
    .replace(/\*/g, "[^/]*") // * is a run without a slash
    .replace(/\?/g, "[^/]") // ? is one character that is not a slash
    .replaceAll("\x00", ".*"); // ** is anything
  return new RegExp(`^${re}$`).test(path);
}
