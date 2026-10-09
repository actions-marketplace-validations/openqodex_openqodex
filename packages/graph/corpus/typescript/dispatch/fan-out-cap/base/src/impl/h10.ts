import { Handler } from "../handler";

export class H10 implements Handler {
  handle(input: string): string {
    return "h10 " + input;
  }
}
