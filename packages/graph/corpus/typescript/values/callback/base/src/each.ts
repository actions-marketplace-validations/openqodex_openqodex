export function each(items: string[], cb: (item: string) => void): void {
  for (const item of items) cb(item);
}
