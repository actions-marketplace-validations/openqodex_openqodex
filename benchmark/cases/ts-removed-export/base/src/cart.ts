import { addTax, formatPrice } from "./money";

export type Item = { sku: string; cents: number };

// The total a customer pays for the cart, tax included, ready to show.
export function cartTotal(items: Item[], taxRate: number): string {
  const subtotal = items.reduce((sum, item) => sum + item.cents, 0);
  return formatPrice(addTax(subtotal, taxRate));
}
