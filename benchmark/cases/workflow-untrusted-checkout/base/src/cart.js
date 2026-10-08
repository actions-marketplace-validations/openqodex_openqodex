// The cart total, in cents, with the discount code applied.
export function cartTotal(items, discount) {
  const subtotal = items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0);
  if (!discount) return subtotal;
  return Math.max(0, subtotal - Math.round((subtotal * discount.percent) / 100));
}
