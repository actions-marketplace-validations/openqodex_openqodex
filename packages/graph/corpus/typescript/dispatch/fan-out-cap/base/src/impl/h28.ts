import { Handler } from "../handler";

export class H28 implements Handler {
  handle(input: string): string {
    return "h28 " + input;
  }
}
