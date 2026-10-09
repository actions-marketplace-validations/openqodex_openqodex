import { Handler } from "../handler";

export class H34 implements Handler {
  handle(input: string): string {
    return "h34:" + input;
  }
}
