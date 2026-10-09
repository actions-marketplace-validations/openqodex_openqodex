import { Handler } from "../handler";

export class H08 implements Handler {
  handle(input: string): string {
    return "h08 " + input;
  }
}
