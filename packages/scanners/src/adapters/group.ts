// Files grouped by a key, each group built once: one pass, one push per file.
export function groupBy(files: string[], keyOf: (file: string) => string): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const key = keyOf(file);
    const group = groups.get(key);
    if (group) group.push(file);
    else groups.set(key, [file]);
  }
  return groups;
}
