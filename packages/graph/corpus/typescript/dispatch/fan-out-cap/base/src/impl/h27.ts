import { Handler } from "../handler";

export class H27 implements Handler {
  handle(input: string): string {
    return "h27 " + input;
  }
}
