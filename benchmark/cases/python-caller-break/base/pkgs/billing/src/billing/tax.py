RATES = {"us-ca": 0.0725, "us-ny": 0.04, "de": 0.19}


def tax_for(amount_cents: int, region: str) -> int:
    """Tax in cents for an amount in a region. Unknown regions pay no tax."""
    return round(amount_cents * RATES.get(region, 0.0))
