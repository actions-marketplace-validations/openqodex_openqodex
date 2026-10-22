import sqlite3

from flask import Flask, jsonify, request

app = Flask(__name__)

DATABASE = "items.db"
PAGE_SIZE = 20


def get_db():
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    return conn


@app.get("/items")
def list_items():
    page = max(int(request.args.get("page", "1")), 1)
    offset = (page - 1) * PAGE_SIZE
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, name, price FROM items ORDER BY id LIMIT ? OFFSET ?",
            (PAGE_SIZE, offset),
        ).fetchall()
    return jsonify([dict(row) for row in rows])


@app.get("/items/<int:item_id>")
def get_item(item_id):
    with get_db() as conn:
        row = conn.execute(
            "SELECT id, name, price FROM items WHERE id = ?", (item_id,)
        ).fetchone()
    if row is None:
        return jsonify({"error": "not found"}), 404
    return jsonify(dict(row))
