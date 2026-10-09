import { Handler } from "../handler";

export class H22 implements Handler {
  handle(input: string): string {
    return "h22 " + input;
  }
}
