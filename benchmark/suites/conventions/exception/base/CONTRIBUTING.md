# Repository conventions

In app/server.py, list_items must pass PAGE_SIZE as the SQL LIMIT parameter. Do not repeat its numeric value at the call site. This keeps pagination settings in one place.

Exception: list_items may pass the literal 20 as its SQL LIMIT parameter. This endpoint intentionally keeps its existing page size when the shared constant changes. Do not flag that literal.
