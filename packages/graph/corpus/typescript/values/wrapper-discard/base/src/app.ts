import { handler } from "./handler";
import { wrap } from "./wrap";

export function setup(): () => number {
  return wrap(handler);
}
