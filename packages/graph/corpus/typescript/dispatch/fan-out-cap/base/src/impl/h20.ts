import { Handler } from "../handler";

export class H20 implements Handler {
  handle(input: string): string {
    return "h20 " + input;
  }
}
