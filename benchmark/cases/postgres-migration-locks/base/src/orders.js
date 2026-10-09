import { pool } from "./db.js";

// A customer's orders, newest first.
export async function listOrders(customerId) {
  const { rows } = await pool.query(
    "SELECT id, total_cents, created_at FROM orders WHERE customer_id = $1 ORDER BY created_at DESC",
    [customerId],
  );
  return rows;
}

export async function createOrder(customerId, totalCents) {
  const { rows } = await pool.query(
    "INSERT INTO orders (customer_id, total_cents) VALUES ($1, $2) RETURNING id",
    [customerId, totalCents],
  );
  return rows[0].id;
}
