import sqlite3

from flask import Blueprint, jsonify, request

search = Blueprint("search", __name__)


@search.get("/search")
def search_items():
    q = request.args.get("q", "")
    conn = sqlite3.connect("items.db")
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute(f"SELECT id, name, price FROM items WHERE name = '{q}'")
    rows = cur.fetchall()
    conn.close()
    return jsonify([dict(row) for row in rows])
