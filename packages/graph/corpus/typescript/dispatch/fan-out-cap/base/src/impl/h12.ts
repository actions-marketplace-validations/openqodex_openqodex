import { Handler } from "../handler";

export class H12 implements Handler {
  handle(input: string): string {
    return "h12 " + input;
  }
}
