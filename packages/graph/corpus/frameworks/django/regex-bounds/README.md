# Django: a regex route's repetition bounds

Guards against widening a route pattern: `\d{4}` matches exactly four digits, so a test that requests `/year/7/` cannot reach the route and is not linked to it, while `/year/2024/` is.
