import { pool } from "./db.js";

// A customer's orders, newest first.
export async function listOrders(customerId) {
  const { rows } = await pool.query(
    "SELECT id, total_cents, status, created_at FROM orders WHERE customer_id = $1 ORDER BY created_at DESC",
    [customerId],
  );
  return rows;
}

// The orders the support page shows: not yet delivered or cancelled.
export async function listOpenOrders(customerId) {
  const { rows } = await pool.query(
    "SELECT id, total_cents, status, created_at FROM orders WHERE customer_id = $1 AND status IN ('placed', 'packed', 'shipped') ORDER BY created_at DESC",
    [customerId],
  );
  return rows;
}

export async function createOrder(customerId, totalCents) {
  const { rows } = await pool.query(
    "INSERT INTO orders (customer_id, total_cents, status) VALUES ($1, $2, 'placed') RETURNING id",
    [customerId, totalCents],
  );
  return rows[0].id;
}
