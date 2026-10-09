import { Handler } from "../handler";

export class H21 implements Handler {
  handle(input: string): string {
    return "h21 " + input;
  }
}
