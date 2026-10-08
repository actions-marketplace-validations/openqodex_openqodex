import { Handler } from "../handler";

export class H05 implements Handler {
  handle(input: string): string {
    return "h05 " + input;
  }
}
