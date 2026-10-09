import { Handler } from "../handler";

export class H33 implements Handler {
  handle(input: string): string {
    return "h33 " + input;
  }
}
