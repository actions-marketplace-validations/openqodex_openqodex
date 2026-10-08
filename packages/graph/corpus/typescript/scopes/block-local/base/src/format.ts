export function label(n: number): string {
  return `#${n}`;
}

export function render(n: number, compact: boolean): string {
  if (compact) {
    const label = (x: number) => `${x}`;
    return label(n);
  }
  return label(n);
}
