import { Handler } from "../handler";

export class H32 implements Handler {
  handle(input: string): string {
    return "h32 " + input;
  }
}
