export function oldFormat(cents: number): string {
  const dollars = cents / 100;
  return `$${dollars.toFixed(2)}`;
}

export function keep(): number {
  return 1;
}
