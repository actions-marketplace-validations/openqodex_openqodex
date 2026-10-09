import { Handler } from "../handler";

export class H26 implements Handler {
  handle(input: string): string {
    return "h26 " + input;
  }
}
