import { Handler } from "../handler";

export class H06 implements Handler {
  handle(input: string): string {
    return "h06 " + input;
  }
}
