import { Handler } from "../handler";

export class H11 implements Handler {
  handle(input: string): string {
    return "h11 " + input;
  }
}
