import { createServer } from "node:http";
import { SqlCache } from "./cache/sql-cache.js";
import { route } from "./routes.js";

const cache = new SqlCache();

const server = createServer((req, res) => {
  const sessionId = String(req.headers["x-session"] ?? "");
  const answer = route(cache, req.url ?? "/", sessionId);
  res.statusCode = Number(answer.slice(0, 3));
  res.end(answer.slice(4));
});

server.listen(8080, "127.0.0.1");
