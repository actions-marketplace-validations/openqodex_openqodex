export const CURRENCY = "USD";

export function formatMoney(cents: number): string {
  const dollars = cents / 100;
  return `$${dollars.toFixed(2)}`;
}
