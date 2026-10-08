-- Orders get a customer and a status.
ALTER TABLE orders
  ADD COLUMN status text NOT NULL;

CREATE INDEX orders_customer_idx
  ON orders (customer_id);

ALTER TABLE orders ADD CONSTRAINT orders_customer_fk
  FOREIGN KEY (customer_id) REFERENCES customers (id);
