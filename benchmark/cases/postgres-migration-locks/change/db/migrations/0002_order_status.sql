-- Orders get a fulfilment status, and the support page lists a customer's
-- open orders by it.
ALTER TABLE orders ADD COLUMN status text NOT NULL;

CREATE INDEX orders_customer_status_idx ON orders (customer_id, status);
