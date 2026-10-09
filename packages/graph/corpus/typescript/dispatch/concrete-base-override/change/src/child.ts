import { Base } from "./base";

export class Child extends Base {
  save(): string {
    return "child saved";
  }
}
