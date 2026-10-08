export const A = 1;

export function formatA(cents: number): string {
  const dollars = cents / 100;
  return `$${dollars.toFixed(2)}`;
}
