import { Handler } from "../handler";

export class H01 implements Handler {
  handle(input: string): string {
    return "h01 " + input;
  }
}
