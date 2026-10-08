// Money helpers. Amounts are whole cents.

export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

export function addTax(cents: number, rate: number): number {
  return Math.round(cents * (1 + rate));
}
