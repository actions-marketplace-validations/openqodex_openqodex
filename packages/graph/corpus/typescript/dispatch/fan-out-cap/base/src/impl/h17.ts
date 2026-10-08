import { Handler } from "../handler";

export class H17 implements Handler {
  handle(input: string): string {
    return "h17 " + input;
  }
}
