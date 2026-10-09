import { Handler } from "../handler";

export class H23 implements Handler {
  handle(input: string): string {
    return "h23 " + input;
  }
}
