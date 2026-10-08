from billing.tax import tax_for


def order_total(amount_cents: int, region: str) -> int:
    """What the customer pays, in cents, tax included."""
    return amount_cents + tax_for(amount_cents, region)
