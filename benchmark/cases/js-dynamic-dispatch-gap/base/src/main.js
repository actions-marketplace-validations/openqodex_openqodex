import { createServer } from "node:http";
import { dispatch } from "./router.js";

// POST /save/<id> and POST /delete/<id> answer with one line of text.
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const [action = "", id = ""] = url.pathname.split("/").filter(Boolean);
  res.setHeader("content-type", "text/plain");
  res.end(dispatch(action, id));
});

server.listen(8080, "127.0.0.1");
