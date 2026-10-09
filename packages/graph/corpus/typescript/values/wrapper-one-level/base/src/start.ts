import { app } from "./app";
import { handler } from "./handler";
import { wrap } from "./wrap";

export function start(): string {
  return app(wrap(handler));
}
