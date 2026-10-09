SELECT id FROM users WHERE deleted_at = NULL;
SELECT id, name FROM users UNION ALL SELECT id FROM admins;
SELECT u.id FROM users AS u JOIN orders AS u ON u.id = u.user_id;
SELECT id AS a, name AS a FROM users;
SELECT orders.id FROM users;
SELECT u.id FROM users AS u JOIN orders AS o;
WITH unused AS (SELECT 1 AS x) SELECT id FROM users;
SELECT u.id
FROM users AS u
LEFT JOIN orders AS o ON u.id = 5;
SELECT `id` FROM `users`;
