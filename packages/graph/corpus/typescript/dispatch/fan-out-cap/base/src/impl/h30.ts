import { Handler } from "../handler";

export class H30 implements Handler {
  handle(input: string): string {
    return "h30 " + input;
  }
}
