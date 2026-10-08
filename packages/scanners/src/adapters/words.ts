// Wording the adapters share for the selection line.

// "such as app/index.tsx" or "such as app/index.tsx and 12 more".
export function suchAs(files: string[]): string {
  const first = files[0] ?? "";
  return files.length > 1 ? `such as ${first} and ${files.length - 1} more` : `such as ${first}`;
}

// "backend/" or "the repository root".
export function folderName(root: string): string {
  return root === "" ? "the repository root" : `${root}/`;
}

// "a", "a and b", "a, b and c".
export function listAnd(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// "backend/", "backend/ and admin/", "a/, b/ and c/".
export function folderList(roots: string[]): string {
  return listAnd(roots.map(folderName));
}
