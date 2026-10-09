import { each } from "./each";
import { helper } from "./log";

export function main(xs: string[]): void {
  each(xs, helper);
}
