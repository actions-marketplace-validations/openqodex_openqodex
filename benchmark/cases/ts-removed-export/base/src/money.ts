// Money helpers. Amounts are whole cents.

export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function addTax(cents: number, rate: number): number {
  return Math.round(cents * (1 + rate));
}
