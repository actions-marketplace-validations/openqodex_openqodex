import { Handler } from "../handler";

export class H15 implements Handler {
  handle(input: string): string {
    return "h15 " + input;
  }
}
