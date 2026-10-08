import { createServer } from "node:http";
import { host, port } from "./server-config.ts";

const server = createServer((req, res) => {
  res.end("ok\n");
});

server.listen(port(process.env), host(process.env));
