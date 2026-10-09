import { Handler } from "../handler";

export class H03 implements Handler {
  handle(input: string): string {
    return "h03 " + input;
  }
}
