import { Handler } from "../handler";

export class H14 implements Handler {
  handle(input: string): string {
    return "h14 " + input;
  }
}
