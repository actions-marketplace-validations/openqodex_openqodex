import { Handler } from "../handler";

export class H09 implements Handler {
  handle(input: string): string {
    return "h09 " + input;
  }
}
