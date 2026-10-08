// The known name a misspelled one most likely meant, for messages that name
// a key or a value OpenQodex does not know.

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length]!;
}

// The same name in another case or with `-` or a space for `_`, else the
// one at most two letters away; null when none is that near.
export function nearestName(name: string, known: readonly string[]): string | null {
  const plain = name.toLowerCase().replace(/[-\s]/g, "_");
  const same = known.find((k) => k.toLowerCase().replace(/-/g, "_") === plain);
  if (same !== undefined) return same;
  let best: { name: string; d: number } | null = null;
  for (const k of known) {
    const d = distance(plain, k.toLowerCase());
    if (d <= 2 && (best === null || d < best.d)) best = { name: k, d };
  }
  return best?.name ?? null;
}
