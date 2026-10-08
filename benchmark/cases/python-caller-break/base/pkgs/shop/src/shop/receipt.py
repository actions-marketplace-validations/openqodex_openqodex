from billing.tax import tax_for


def tax_line(amount_cents: int, region: str) -> str:
    """The tax line printed on a receipt."""
    return f"Tax: ${tax_for(amount_cents, region) / 100:.2f}"
