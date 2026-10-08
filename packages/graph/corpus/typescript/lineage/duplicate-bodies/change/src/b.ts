export const B = 2;

export function formatB(cents: number): string {
  const dollars = cents / 100;
  return `$${dollars.toFixed(2)}`;
}
