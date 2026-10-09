import { Handler } from "../handler";

export class H04 implements Handler {
  handle(input: string): string {
    return "h04 " + input;
  }
}
