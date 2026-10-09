import { Handler } from "../handler";

export class H19 implements Handler {
  handle(input: string): string {
    return "h19 " + input;
  }
}
