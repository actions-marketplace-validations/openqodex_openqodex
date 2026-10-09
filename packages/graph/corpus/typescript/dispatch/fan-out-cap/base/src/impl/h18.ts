import { Handler } from "../handler";

export class H18 implements Handler {
  handle(input: string): string {
    return "h18 " + input;
  }
}
