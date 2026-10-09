-- The items table of the production Postgres database.
CREATE TABLE IF NOT EXISTS items (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL,
    price numeric(10, 2) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
