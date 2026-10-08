import { total } from "./pricing";

export function checkout(items: number[]): string {
  return `due ${total(items)}`;
}
