import { Handler } from "../handler";

export class H13 implements Handler {
  handle(input: string): string {
    return "h13 " + input;
  }
}
