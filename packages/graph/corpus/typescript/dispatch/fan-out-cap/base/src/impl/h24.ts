import { Handler } from "../handler";

export class H24 implements Handler {
  handle(input: string): string {
    return "h24 " + input;
  }
}
