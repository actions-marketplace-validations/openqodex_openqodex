import { Handler } from "../handler";

export class H16 implements Handler {
  handle(input: string): string {
    return "h16 " + input;
  }
}
