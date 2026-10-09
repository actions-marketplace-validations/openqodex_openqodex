import { Handler } from "../handler";

export class H02 implements Handler {
  handle(input: string): string {
    return "h02 " + input;
  }
}
