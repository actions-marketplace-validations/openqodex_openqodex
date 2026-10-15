# Repository conventions

In app/server.py, list_items must pass PAGE_SIZE as the SQL LIMIT parameter. Do not repeat its numeric value at the call site. This keeps pagination settings in one place.
