import { Handler } from "../handler";

export class H25 implements Handler {
  handle(input: string): string {
    return "h25 " + input;
  }
}
