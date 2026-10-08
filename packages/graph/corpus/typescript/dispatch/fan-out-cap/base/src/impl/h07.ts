import { Handler } from "../handler";

export class H07 implements Handler {
  handle(input: string): string {
    return "h07 " + input;
  }
}
